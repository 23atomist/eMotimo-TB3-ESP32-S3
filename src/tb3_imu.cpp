// src/tb3_imu.cpp
#if defined(ESP32)

#include "tb3_imu.h"
#include <Wire.h>
#include <math.h>

// ---- register maps -------------------------------------------------------
// MPU-9250 / MPU-6050 at 0x68 (AD0 low) or 0x69 (AD0 high) -- detected at runtime.
static uint8_t s_mpu_addr           = 0x68;
static const uint8_t MPU_WHOAMI     = 0x75; // -> 0x71
static const uint8_t MPU_PWR_MGMT_1 = 0x6B;
static const uint8_t MPU_GYRO_CFG   = 0x1B; // FS_SEL[4:3]
static const uint8_t MPU_ACCEL_CFG  = 0x1C; // AFS_SEL[4:3]
static const uint8_t MPU_INT_PIN_CFG= 0x37; // BYPASS_EN=bit1
static const uint8_t MPU_USER_CTRL  = 0x6A; // I2C_MST_EN=bit5
static const uint8_t MPU_ACCEL_XOUT_H = 0x3B; // 14 bytes: accel[6] temp[2] gyro[6]
// AK8963 (0x0C)
static const uint8_t AK_ADDR   = 0x0C;
static const uint8_t AK_WIA    = 0x00; // -> 0x48
static const uint8_t AK_HXL    = 0x03; // 6 bytes little-endian, then ST2
static const uint8_t AK_CNTL1  = 0x0A; // mode[3:0], BIT(16-bit)=bit4
static const uint8_t AK_ASAX   = 0x10; // fuse-ROM sensitivity adjust
// BMP280 (0x76)
static const uint8_t BMP_ADDR   = 0x76;
static const uint8_t BMP_ID     = 0xD0; // -> 0x58
static const uint8_t BMP_CTRL   = 0xF4;
static const uint8_t BMP_CONFIG = 0xF5;
static const uint8_t BMP_CALIB  = 0x88; // 24 bytes
static const uint8_t BMP_PRESS  = 0xF7; // press[3] temp[3]

static const uint16_t ACCEL_FS_G = 4;
static const uint16_t GYRO_FS_DPS = 500;

static SemaphoreHandle_t s_mtx = nullptr;
static Tb3ImuInfo s_info = {};
static float s_asa[3] = {1, 1, 1};                 // AK8963 per-axis adjustment
static uint16_t s_dT1; static int16_t s_dT2, s_dT3;
static uint16_t s_dP1; static int16_t s_dP2, s_dP3, s_dP4, s_dP5, s_dP6, s_dP7, s_dP8, s_dP9;

// ---- low-level I2C -------------------------------------------------------
static bool wr(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr); Wire.write(reg); Wire.write(val);
  return Wire.endTransmission() == 0;
}
static bool rd(uint8_t addr, uint8_t reg, uint8_t *buf, size_t n) {
  Wire.beginTransmission(addr); Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)addr, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)Wire.read();
  return true;
}
static uint8_t rd1(uint8_t addr, uint8_t reg) { uint8_t v = 0; rd(addr, reg, &v, 1); return v; }

// ---- BMP280 float compensation (Bosch datasheet) -------------------------
static float bmp_compensate(int32_t adc_T, int32_t adc_P, float *pressHpaOut) {
  double var1 = (((double)adc_T) / 16384.0 - ((double)s_dT1) / 1024.0) * (double)s_dT2;
  double var2 = ((((double)adc_T) / 131072.0 - ((double)s_dT1) / 8192.0) *
                 (((double)adc_T) / 131072.0 - ((double)s_dT1) / 8192.0)) * (double)s_dT3;
  double t_fine = var1 + var2;
  double tempC = t_fine / 5120.0;

  double v1 = (t_fine / 2.0) - 64000.0;
  double v2 = v1 * v1 * (double)s_dP6 / 32768.0;
  v2 = v2 + v1 * (double)s_dP5 * 2.0;
  v2 = (v2 / 4.0) + ((double)s_dP4 * 65536.0);
  v1 = ((double)s_dP3 * v1 * v1 / 524288.0 + (double)s_dP2 * v1) / 524288.0;
  v1 = (1.0 + v1 / 32768.0) * (double)s_dP1;
  double p = 0.0;
  if (v1 != 0.0) {
    p = 1048576.0 - (double)adc_P;
    p = (p - (v2 / 4096.0)) * 6250.0 / v1;
    v1 = (double)s_dP9 * p * p / 2147483648.0;
    v2 = p * (double)s_dP8 / 32768.0;
    p = p + (v1 + v2 + (double)s_dP7) / 16.0;   // Pa
  }
  *pressHpaOut = (float)(p / 100.0);
  return (float)tempC;
}

// ---- init ----------------------------------------------------------------
bool tb3_imu_begin() {
  if (!s_mtx) s_mtx = xSemaphoreCreateMutex();
  // The breakout carrying the MPU may not share the retired GY-91's pin order,
  // so SDA/SCL can end up swapped. Probe both GPIO8/9 orientations and both I2C
  // addresses (AD0 low 0x68 / high 0x69) in each, and keep the combination that
  // returns a recognized WHO_AM_I -- a swapped SDA/SCL then works without
  // rewiring. Falls back to SDA=8/SCL=9 @ 0x68 if nothing answers anywhere
  // (present stays false: the wires aren't reaching the chip's SDA/SCL pads).
  const uint8_t sdaPins[2] = {8, 9};
  const uint8_t sclPins[2] = {9, 8};
  s_mpu_addr = 0x68;
  bool found = false;
  for (int o = 0; o < 2 && !found; o++) {
    Wire.end();
    Wire.begin(sdaPins[o], sclPins[o]);
    Wire.setClock(100000);
    Wire.setTimeOut(15);
    for (uint8_t a = 0x68; a <= 0x69; a++) {
      uint8_t who = rd1(a, MPU_WHOAMI);
      if (who == 0x71 || who == 0x73 || who == 0x68) { s_mpu_addr = a; found = true; break; }
    }
  }
  if (!found) { Wire.end(); Wire.begin(8, 9); Wire.setClock(100000); Wire.setTimeOut(15); }

  // MPU wake + ranges
  wr(s_mpu_addr, MPU_PWR_MGMT_1, 0x80); delay(100); // reset
  wr(s_mpu_addr, MPU_PWR_MGMT_1, 0x01); delay(10);  // wake, PLL clock
  wr(s_mpu_addr, MPU_GYRO_CFG, 0x08);               // ±500 dps (FS_SEL=1)
  wr(s_mpu_addr, MPU_ACCEL_CFG, 0x08);              // ±4 g (AFS_SEL=1)
  wr(s_mpu_addr, MPU_USER_CTRL, 0x00);              // I2C master off (bypass usable)
  wr(s_mpu_addr, MPU_INT_PIN_CFG, 0x02);            // BYPASS_EN
  delay(10);

  s_info.mpu_who = rd1(s_mpu_addr, MPU_WHOAMI);
  s_info.bmp_id  = rd1(BMP_ADDR, BMP_ID);

  // AK8963: power down, read ASA in fuse-ROM mode, then 16-bit continuous 100Hz
  wr(AK_ADDR, AK_CNTL1, 0x00); delay(10);
  wr(AK_ADDR, AK_CNTL1, 0x0F); delay(10);           // fuse ROM access
  uint8_t asa[3] = {128, 128, 128};
  rd(AK_ADDR, AK_ASAX, asa, 3);
  for (int i = 0; i < 3; i++) s_asa[i] = ((float)asa[i] - 128.0f) / 256.0f + 1.0f;
  wr(AK_ADDR, AK_CNTL1, 0x00); delay(10);
  wr(AK_ADDR, AK_CNTL1, 0x16); delay(10);           // 16-bit, continuous mode 2 (100Hz)
  s_info.mag_who = rd1(AK_ADDR, AK_WIA);

  // BMP280: calibration + normal mode
  uint8_t c[24];
  if (rd(BMP_ADDR, BMP_CALIB, c, 24)) {
    s_dT1 = (uint16_t)(c[0]  | (c[1]  << 8));
    s_dT2 = (int16_t) (c[2]  | (c[3]  << 8));
    s_dT3 = (int16_t) (c[4]  | (c[5]  << 8));
    s_dP1 = (uint16_t)(c[6]  | (c[7]  << 8));
    s_dP2 = (int16_t) (c[8]  | (c[9]  << 8));
    s_dP3 = (int16_t) (c[10] | (c[11] << 8));
    s_dP4 = (int16_t) (c[12] | (c[13] << 8));
    s_dP5 = (int16_t) (c[14] | (c[15] << 8));
    s_dP6 = (int16_t) (c[16] | (c[17] << 8));
    s_dP7 = (int16_t) (c[18] | (c[19] << 8));
    s_dP8 = (int16_t) (c[20] | (c[21] << 8));
    s_dP9 = (int16_t) (c[22] | (c[23] << 8));
  }
  wr(BMP_ADDR, BMP_CONFIG, 0x00);
  wr(BMP_ADDR, BMP_CTRL, 0x27);                      // osrs_t x1, osrs_p x1, normal mode

  s_info.accel_fs_g = ACCEL_FS_G;
  s_info.gyro_fs_dps = GYRO_FS_DPS;
  // WHO_AM_I: MPU-9250 -> 0x71, MPU-9255 -> 0x73, MPU-6050/6000 -> 0x68.
  // Accept all three so either module works. A 6-axis MPU-6050 has no AK8963
  // magnetometer or BMP280 barometer, so those reads return NaN and
  // mag_who/bmp_id stay 0x00 -- expected on a 6-DOF part, not a fault.
  s_info.present = (s_info.mpu_who == 0x71 || s_info.mpu_who == 0x73 || s_info.mpu_who == 0x68);
  return s_info.present;
}

// Read one sample WITHOUT taking the mutex (caller holds it).
static bool read_locked(Tb3ImuSample &o) {
  o.t_us = micros();
  uint8_t b[14];
  if (!rd(s_mpu_addr, MPU_ACCEL_XOUT_H, b, 14)) return false;
  int16_t ax = (b[0] << 8) | b[1], ay = (b[2] << 8) | b[3], az = (b[4] << 8) | b[5];
  int16_t gx = (b[8] << 8) | b[9], gy = (b[10] << 8) | b[11], gz = (b[12] << 8) | b[13];
  const float aScale = (float)ACCEL_FS_G / 32768.0f;
  const float gScale = (float)GYRO_FS_DPS / 32768.0f;
  o.ax = ax * aScale; o.ay = ay * aScale; o.az = az * aScale;
  o.gx = gx * gScale; o.gy = gy * gScale; o.gz = gz * gScale;

  // Magnetometer (little-endian; ST2 must be read to release the next sample).
  uint8_t m[7];
  o.mx = o.my = o.mz = NAN;
  if (rd(AK_ADDR, AK_HXL, m, 7)) {                  // m[6] = ST2
    if (!(m[6] & 0x08)) {                           // no HOFL overflow
      int16_t hx = (int16_t)(m[0] | (m[1] << 8));
      int16_t hy = (int16_t)(m[2] | (m[3] << 8));
      int16_t hz = (int16_t)(m[4] | (m[5] << 8));
      const float magScale = 0.15f;                 // µT/LSB (16-bit)
      o.mx = hx * magScale * s_asa[0];
      o.my = hy * magScale * s_asa[1];
      o.mz = hz * magScale * s_asa[2];
    }
  }

  // Baro
  uint8_t p[6];
  o.tempC = NAN; o.pressHpa = NAN;
  if (rd(BMP_ADDR, BMP_PRESS, p, 6)) {
    int32_t adc_P = ((int32_t)p[0] << 12) | ((int32_t)p[1] << 4) | (p[2] >> 4);
    int32_t adc_T = ((int32_t)p[3] << 12) | ((int32_t)p[4] << 4) | (p[5] >> 4);
    float hpa; o.tempC = bmp_compensate(adc_T, adc_P, &hpa); o.pressHpa = hpa;
  }
  return true;
}

bool tb3_imu_read(Tb3ImuSample &out) {
  if (!s_info.present || !s_mtx) return false;
  xSemaphoreTake(s_mtx, portMAX_DELAY);
  bool ok = read_locked(out);
  xSemaphoreGive(s_mtx);
  return ok;
}

size_t tb3_imu_burst(Tb3ImuSample *buf, size_t n) {
  if (!s_info.present || !s_mtx) return 0;
  if (n > TB3_IMU_BURST_MAX) n = TB3_IMU_BURST_MAX;
  size_t got = 0;
  xSemaphoreTake(s_mtx, portMAX_DELAY);
  for (size_t i = 0; i < n; i++) if (read_locked(buf[i])) got++;
  xSemaphoreGive(s_mtx);
  return got;
}

Tb3ImuInfo tb3_imu_info() { return s_info; }

#endif // ESP32
