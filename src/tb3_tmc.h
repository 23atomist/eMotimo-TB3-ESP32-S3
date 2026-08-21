// src/tb3_tmc.h
#ifndef TB3_TMC_H
#define TB3_TMC_H
#if defined(ESP32)

#include <Arduino.h>

// Per-driver TMC2209 UART (PDN_UART), one independent bus per axis.
//
// Why this exists: built to test whether StealthChop explained the rig's
// low-speed misbehaviour. Measured 2026-08-20, it does not -- an interleaved A/B
// against SpreadCycle came out at +4 points, i.e. noise, and so did giving the
// drivers a known 1.22 A instead of whatever the VREF pots were set to. The real
// fault was ~1.84 deg of lost motion on every direction reversal, which is
// mechanical (both axes are worm drives). This module stays because the driver
// telemetry it unlocked -- cs_actual, StallGuard, IFCNT write confirmation,
// open-load detection -- is worth far more than the hypothesis that motivated it.
// No SPREAD pin is broken out on these modules, so UART is the only way to reach
// any of it.
//
// Wiring (2026-08-20 rework). The carrier bridged MS1/MS2/MS3/RESET/SLEEP into
// one net and drove it HIGH -- correct for the A4988s this board shipped with
// (1/16 plus RESET/SLEEP released), but on a TMC2209 those pads are MS1, MS2,
// PDN_UART, PDN_UART and CLK. That tied the UART line to two ESP32 outputs
// holding it high, which no series resistor can drive against. RX/TX/CLK are
// now cut away from MS1/MS2, CLK is grounded, and each driver gets its own
// two-wire link:
//
//   GPIO42 (J3 p6) --[1k]--+                 GPIO40 (J3 p8) --[1k]--+
//                          +-- pan RX/TX                            +-- tilt RX/TX
//   GPIO41 (J3 p7) --------+                 GPIO39 (J3 p9) --------+
//
// RX and TX are one node because the TMC2209 has a single half-duplex UART pin.
// The 1k belongs in series with the transmit pin only, with the receive pin on
// the driver side of it -- otherwise the ESP32's idle-high output holds the node
// up and the driver can never pull it low, silently killing reads.
//
// MS1/MS2 stay seated and HIGH. That keeps microstep resolution pin-derived at
// 1/16 (so STEPS_PER_DEG 444.444 stays valid and cannot be broken by a config
// write failing) and leaves both drivers at UART address 3 -- harmless, because
// they are on separate buses.

#ifndef TB3_TMC_PAN_TX
#define TB3_TMC_PAN_TX   42
#endif
#ifndef TB3_TMC_PAN_RX
#define TB3_TMC_PAN_RX   41
#endif
#ifndef TB3_TMC_TILT_TX
#define TB3_TMC_TILT_TX  40
#endif
#ifndef TB3_TMC_TILT_RX
#define TB3_TMC_TILT_RX  39
#endif
#ifndef TB3_TMC_BAUD
#define TB3_TMC_BAUD     115200
#endif
#ifndef TB3_TMC_ADDR
#define TB3_TMC_ADDR     3      // MS1/MS2 both HIGH; per-bus, so not a conflict
#endif

// 26 -> ~1.49 A RMS, about 25% over the motors' 1.19 A RMS rating. Enough
// headroom to test a torque hypothesis, not enough to damage anything in the
// minutes a test takes. Raise deliberately, not by accident.
#ifndef TB3_TMC_IRUN_MAX
#define TB3_TMC_IRUN_MAX 26
#endif

// Applied at boot. 21 -> ~1.22 A RMS, which is what these motors are actually
// rated for: 1.68 A peak / sqrt(2) = 1.19 A RMS. The driver's own reset default
// of IRUN 31 runs them at ~1.77 A, roughly 50% over rating, and an over-driven
// stepper has more torque ripple and excites mid-band resonance. That was the
// stutter. Verified on the rig 2026-08-20: 21 pans smoothly, 26 (1.49 A) brings
// the judder back. This MUST be applied at boot -- IHOLD_IRUN is volatile, and
// without it the drivers silently revert to 31 on the next power cycle and the
// fault returns with no obvious cause.
#ifndef TB3_TMC_DEFAULT_IRUN
#define TB3_TMC_DEFAULT_IRUN  21
#endif
#ifndef TB3_TMC_DEFAULT_IHOLD
#define TB3_TMC_DEFAULT_IHOLD 10
#endif

// MS3 (GPIO17) landed on the old shared net. After the rework its trace should
// be isolated, but it is still released before each transaction in case a cut
// was partial -- a stuck output on the UART node fails silently otherwise.
#ifndef TB3_TMC_MS3_PIN
#define TB3_TMC_MS3_PIN  17
#endif

enum Tb3TmcAxis { TB3_TMC_PAN = 0, TB3_TMC_TILT = 1, TB3_TMC_AXES = 2 };

struct Tb3TmcInfo {
  bool     present;      // IOIN read back a plausible TMC2209 VERSION (0x21)
  uint8_t  version;
  uint32_t gconf;        // last value written
  uint16_t writes;       // datagrams sent
  uint16_t ifcnt;        // driver's own write counter -- proves writes land
  bool     read_ok;      // last read validated its CRC
  uint32_t drv_status;
  uint16_t sg_result;    // StallGuard load measure; lower = more loaded
  uint8_t  cs_actual;    // current scale the driver is ACTUALLY applying, 0-31
  bool     otpw, ot, ola, olb, stst;
  bool     analog_current;   // true = VREF pots in charge, false = digital IRUN
  uint8_t  irun, ihold;      // last values written (meaningless while analog)
};

// Opens both UARTs and writes the baseline GCONF. The baseline reproduces stock
// behaviour deliberately: current still comes from the VREF pots, microstepping
// still comes from MS1/MS2, and pdn_disable is set only because the datasheet
// requires it once PDN_UART carries traffic. SpreadCycle is then the single
// variable under test.
bool tb3_tmc_begin();

// false = StealthChop (stock), true = SpreadCycle. Applied to both axes.
bool tb3_tmc_set_spread(bool spread);

// Take current away from the VREF pots and set it digitally (clears
// GCONF.I_scale_analog and writes IHOLD_IRUN). This is the only way to learn
// what current the drivers are ACTUALLY delivering: cs_actual reads 31 during
// motion, but 31/31 of a pot-determined ceiling is still unknown in amps.
//
// irun/ihold are 0..31 scale steps. With 0.11 ohm sense resistors the full
// scale is ~1.77 A RMS, so I_rms ~= 1.77 * (n+1)/32. The SY42STH/JK42HS motors
// here are 1.68 A rated, which is 1.19 A RMS under sinusoidal microstepping ->
// irun 21. Clamped to TB3_TMC_IRUN_MAX so a typo cannot cook a motor that has
// no thermal cutout in the control loop.
bool tb3_tmc_set_current(uint8_t irun, uint8_t ihold);

// Hand current back to the VREF pots (restores GCONF.I_scale_analog).
bool tb3_tmc_use_pots();

bool       tb3_tmc_ready();
bool       tb3_tmc_spread();
Tb3TmcInfo tb3_tmc_info(Tb3TmcAxis axis);   // refreshes the read-back fields

bool tb3_tmc_read(Tb3TmcAxis axis, uint8_t reg, uint32_t *out);

#define TB3_TMC_REG_GCONF      0x00
#define TB3_TMC_REG_IFCNT      0x02
#define TB3_TMC_REG_IOIN       0x06
#define TB3_TMC_REG_TSTEP      0x12
#define TB3_TMC_REG_SG_RESULT  0x41
#define TB3_TMC_REG_CHOPCONF   0x6C
#define TB3_TMC_REG_DRV_STATUS 0x6F

#endif // ESP32
#endif // TB3_TMC_H
