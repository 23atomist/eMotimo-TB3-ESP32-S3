// src/tb3_tmc.cpp
#if defined(ESP32)

#include "tb3_tmc.h"

// GCONF bit assignments (TMC2209 datasheet 5.1)
#define GC_I_SCALE_ANALOG   (1u << 0)  // 1 = current scale comes from the VREF pot
#define GC_INTERNAL_RSENSE  (1u << 1)
#define GC_EN_SPREADCYCLE   (1u << 2)  // 0 = StealthChop, 1 = SpreadCycle
#define GC_SHAFT            (1u << 3)
#define GC_PDN_DISABLE      (1u << 6)  // "Set this bit when using the UART interface!"
#define GC_MSTEP_REG_SELECT (1u << 7)  // 0 = MS1/MS2 pins select microstep resolution
#define GC_MULTISTEP_FILT   (1u << 8)

// Everything except en_spreadCycle is chosen to leave the rig exactly as it
// behaves today, so an A/B measures one variable:
//   I_scale_analog   - leave the pots in charge of current
//   mstep_reg_select - leave microstepping on MS1/MS2. Deliberate: it keeps
//                      1/16 and STEPS_PER_DEG 444.444 true even if a config
//                      write never lands. There are no endstops, so motion scale
//                      must not depend on a UART datagram arriving.
//   pdn_disable      - required once PDN_UART is a UART. It also restores the
//                      "standstill current reduction off" state the pin used to
//                      provide while held HIGH, so the rework is not itself a
//                      behavioural change.
static const uint32_t GCONF_BASE =
    GC_I_SCALE_ANALOG | GC_PDN_DISABLE | GC_MULTISTEP_FILT;

static HardwareSerial *s_uart[TB3_TMC_AXES] = { &Serial1, &Serial2 };
static const int8_t s_tx[TB3_TMC_AXES] = { TB3_TMC_PAN_TX, TB3_TMC_TILT_TX };
static const int8_t s_rx[TB3_TMC_AXES] = { TB3_TMC_PAN_RX, TB3_TMC_TILT_RX };

static bool       s_ready  = false;
static bool       s_spread = false;
static bool       s_analog = true;      // GCONF.I_scale_analog -- pots by default
static uint8_t    s_irun = 0, s_ihold = 0;
static Tb3TmcInfo s_info[TB3_TMC_AXES];

// TMC UART CRC8: x^8 + x^2 + x + 1, fed LSB-first over the datagram.
static uint8_t tmc_crc(const uint8_t *d, uint8_t n) {
  uint8_t crc = 0;
  for (uint8_t i = 0; i < n; i++) {
    uint8_t b = d[i];
    for (uint8_t j = 0; j < 8; j++) {
      if ((crc >> 7) ^ (b & 0x01)) crc = (uint8_t)((crc << 1) ^ 0x07);
      else                         crc = (uint8_t)(crc << 1);
      b >>= 1;
    }
  }
  return crc;
}

// setup() drives MS3 HIGH. Its trace should be isolated after the rework, but a
// partial cut would leave an output sitting on a UART node and the failure would
// be silent, so float it before touching either bus.
static void release_ms3() { pinMode(TB3_TMC_MS3_PIN, INPUT); }

static bool write_reg(Tb3TmcAxis ax, uint8_t reg, uint32_t val) {
  if (!s_ready || ax >= TB3_TMC_AXES) return false;
  release_ms3();

  uint8_t d[8];
  d[0] = 0x05;                       // sync
  d[1] = TB3_TMC_ADDR;
  d[2] = (uint8_t)(reg | 0x80);      // write bit
  d[3] = (uint8_t)(val >> 24);
  d[4] = (uint8_t)(val >> 16);
  d[5] = (uint8_t)(val >> 8);
  d[6] = (uint8_t)(val);
  d[7] = tmc_crc(d, 7);

  s_uart[ax]->write(d, sizeof(d));
  s_uart[ax]->flush();
  s_info[ax].writes++;
  delayMicroseconds(200);            // idle bit times between datagrams
  return true;
}

bool tb3_tmc_read(Tb3TmcAxis ax, uint8_t reg, uint32_t *out) {
  if (!s_ready || ax >= TB3_TMC_AXES || !out) return false;
  release_ms3();

  HardwareSerial *u = s_uart[ax];
  while (u->available()) u->read();

  uint8_t q[4];
  q[0] = 0x05;
  q[1] = TB3_TMC_ADDR;
  q[2] = reg;                        // no write bit
  q[3] = tmc_crc(q, 3);
  u->write(q, sizeof(q));
  u->flush();

  // TX and RX share one wire, so the request echoes straight back into RX.
  // Collect what arrives and scan past the echo for the reply's 0x05 0xFF head.
  uint8_t  buf[24];
  size_t   n  = 0;
  uint32_t t0 = millis();
  while (n < sizeof(buf) && (millis() - t0) < 20) {
    if (u->available()) buf[n++] = (uint8_t)u->read();
  }

  for (size_t i = 0; i + 8 <= n; i++) {
    if (buf[i] == 0x05 && buf[i + 1] == 0xFF && buf[i + 2] == reg &&
        tmc_crc(&buf[i], 7) == buf[i + 7]) {
      *out = ((uint32_t)buf[i + 3] << 24) | ((uint32_t)buf[i + 4] << 16) |
             ((uint32_t)buf[i + 5] << 8)  |  (uint32_t)buf[i + 6];
      s_info[ax].read_ok = true;
      return true;
    }
  }
  s_info[ax].read_ok = false;
  return false;
}

#define TMC_REG_IHOLD_IRUN 0x10

static uint32_t gconf_value() {
  uint32_t g = GC_PDN_DISABLE | GC_MULTISTEP_FILT;
  if (s_analog) g |= GC_I_SCALE_ANALOG;
  if (s_spread) g |= GC_EN_SPREADCYCLE;
  return g;
}

static bool push_gconf() {
  uint32_t g = gconf_value();
  bool all = true;
  for (int a = 0; a < TB3_TMC_AXES; a++) {
    if (write_reg((Tb3TmcAxis)a, TB3_TMC_REG_GCONF, g)) s_info[a].gconf = g;
    else all = false;
  }
  return all;
}

bool tb3_tmc_set_spread(bool spread) {
  if (!s_ready) return false;
  s_spread = spread;
  return push_gconf();
}

bool tb3_tmc_set_current(uint8_t irun, uint8_t ihold) {
  if (!s_ready) return false;
  if (irun  > TB3_TMC_IRUN_MAX) irun  = TB3_TMC_IRUN_MAX;
  if (ihold > irun)             ihold = irun;
  // IHOLD_IRUN: IHOLD[4:0], IRUN[12:8], IHOLDDELAY[19:16]
  uint32_t v = (uint32_t)ihold | ((uint32_t)irun << 8) | (6u << 16);
  bool all = true;
  for (int a = 0; a < TB3_TMC_AXES; a++) {
    if (!write_reg((Tb3TmcAxis)a, TMC_REG_IHOLD_IRUN, v)) all = false;
    s_info[a].irun = irun; s_info[a].ihold = ihold; s_info[a].analog_current = false;
  }
  s_irun = irun; s_ihold = ihold; s_analog = false;
  return push_gconf() && all;     // GCONF last: clears I_scale_analog
}

bool tb3_tmc_use_pots() {
  if (!s_ready) return false;
  s_analog = true;
  for (int a = 0; a < TB3_TMC_AXES; a++) s_info[a].analog_current = true;
  return push_gconf();
}

Tb3TmcInfo tb3_tmc_info(Tb3TmcAxis ax) {
  if (ax >= TB3_TMC_AXES) return Tb3TmcInfo{};
  uint32_t v = 0;

  if (tb3_tmc_read(ax, TB3_TMC_REG_IOIN, &v)) {
    s_info[ax].version = (uint8_t)(v >> 24);
    s_info[ax].present = (s_info[ax].version == 0x21);   // TMC2209
  } else {
    s_info[ax].present = false;
  }
  // IFCNT is the driver's own count of accepted writes: the only proof that
  // datagrams are landing rather than disappearing into an unconnected wire.
  if (tb3_tmc_read(ax, TB3_TMC_REG_IFCNT, &v)) s_info[ax].ifcnt = (uint16_t)(v & 0xFF);
  if (tb3_tmc_read(ax, TB3_TMC_REG_SG_RESULT, &v)) s_info[ax].sg_result = (uint16_t)(v & 0x3FF);

  if (tb3_tmc_read(ax, TB3_TMC_REG_DRV_STATUS, &v)) {
    s_info[ax].drv_status = v;
    s_info[ax].otpw      = v & (1u << 0);
    s_info[ax].ot        = v & (1u << 1);
    s_info[ax].ola       = v & (1u << 6);
    s_info[ax].olb       = v & (1u << 7);
    s_info[ax].cs_actual = (uint8_t)((v >> 16) & 0x1F);
    s_info[ax].stst      = v & (1u << 31);
  }
  return s_info[ax];
}

bool tb3_tmc_begin() {
  for (int a = 0; a < TB3_TMC_AXES; a++) {
    s_info[a] = Tb3TmcInfo{};
    s_info[a].analog_current = true;
    s_uart[a]->begin(TB3_TMC_BAUD, SERIAL_8N1, s_rx[a], s_tx[a]);
  }
  delay(10);
  release_ms3();
  s_ready = true;
  // StealthChop, as stock. SpreadCycle was tested and made no difference.
  bool ok = tb3_tmc_set_spread(false);
  // Current is NOT left to the pots: the drivers' reset default over-drives
  // these motors by ~50% and that is what made the rig stutter. See the note on
  // TB3_TMC_DEFAULT_IRUN. Applied every boot because IHOLD_IRUN does not persist.
  ok = tb3_tmc_set_current(TB3_TMC_DEFAULT_IRUN, TB3_TMC_DEFAULT_IHOLD) && ok;
  for (int a = 0; a < TB3_TMC_AXES; a++) tb3_tmc_info((Tb3TmcAxis)a);
  return ok;
}

bool tb3_tmc_ready()  { return s_ready; }
bool tb3_tmc_spread() { return s_spread; }

#endif // ESP32
