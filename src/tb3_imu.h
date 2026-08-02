// src/tb3_imu.h
#ifndef TB3_IMU_H
#define TB3_IMU_H
#if defined(ESP32)

#include <Arduino.h>

// Two supported parts, detected at runtime on I2C GPIO8=SDA / GPIO9=SCL:
//
//   MPU-9250 / MPU-6050 (+ AK8963 mag, BMP280 baro) at 0x68/0x69 — the
//   original GY-91-style module. ax/ay/az are RAW accelerometer.
//
//   BNO055 at 0x28/0x29 — Bosch 9-axis with an on-chip Cortex-M0 running
//   sensor fusion. Run deliberately in IMU mode (accel+gyro fusion, NO
//   magnetometer): this rig carries two stepper motors whose permanent-magnet
//   rotors deflect a magnetometer by more than the pointing accuracy we are
//   trying to achieve, and NDOF mode would fuse that corruption into pitch
//   and roll as well — turning a clean accelerometer attitude into a dirty
//   one. Heading comes from aircraft sightings, never from a magnetometer.
//
// All access is core-0 and mutex-guarded; never call these from the step ISR.
// See docs/hardware-pinmap.md.

#define TB3_IMU_BURST_MAX 500

#define TB3_IMU_CHIP_NONE 0
#define TB3_IMU_CHIP_MPU  1
#define TB3_IMU_CHIP_BNO  2

struct Tb3ImuSample {
  uint32_t t_us;      // micros() at read
  float ax, ay, az;   // g
  float gx, gy, gz;   // deg/s
  float mx, my, mz;   // µT (AK8963); NAN if this sample's mag read failed/overflowed
  float tempC;        // BMP280
  float pressHpa;     // BMP280
};

struct Tb3ImuInfo {
  bool present;         // true if MPU WHO_AM_I matched (0x71/0x73 MPU-9250/55, 0x68 MPU-6050)
  uint8_t mpu_who;      // 0x71 MPU-9250, 0x73 MPU-9255, 0x68 MPU-6050
  uint8_t mag_who;      // 0x48 AK8963 (0x00 on a 6-axis MPU-6050 -- no magnetometer)
  uint8_t bmp_id;       // 0x58 BMP280 (0x00 on an MPU-6050-only module -- no baro)
  uint16_t accel_fs_g;  // 4
  uint16_t gyro_fs_dps; // 500
  uint8_t chip;         // TB3_IMU_CHIP_*
  // BNO055 CALIB_STAT (0x35): sys<<6 | gyro<<4 | accel<<2 | mag, each 0..3.
  // The ACCEL field is the one that matters here -- it says whether a gravity
  // reading is trustworthy, which is exactly the question that could not be
  // answered when a stale R_s silently poisoned a whole calibration session.
  // Always 0 on the MPU (it has no such notion).
  uint8_t calib;
  // True when ax/ay/az carry the FUSED GRAVITY vector (linear acceleration
  // already removed by the BNO055) rather than raw accelerometer. The daemon
  // averages these to get gravity, so fusing first means vibration and
  // residual settling no longer bias the result.
  bool fused_gravity;
  // The SDA/SCL the probe settled on. tb3_imu_begin() tries both pin orders,
  // so this says whether the wires are swapped relative to the pinmap.
  uint8_t sda_pin, scl_pin;
  // BNO055 only. opr_mode is read BACK from the chip, not what we asked for:
  // a mode write that silently fails leaves the part in CONFIG (0x00), where
  // every data register reads zero. That is indistinguishable from a healthy
  // sensor at rest unless the mode is reported. sys_status/sys_err are the
  // chip's own self-report (status 5 == fusion running).
  uint8_t opr_mode, sys_status, sys_err;
};

// Call once from setup(). Wire.begin(8,9), WHO_AM_I checks, configure the three
// chips. Returns whether the IMU is present.
bool tb3_imu_begin();

// One mutex-guarded sample. Returns false if the IMU is absent.
bool tb3_imu_read(Tb3ImuSample &out);

// Tight-loop n reads (n capped at TB3_IMU_BURST_MAX) holding the mutex once.
// Returns the count actually written to buf.
size_t tb3_imu_burst(Tb3ImuSample *buf, size_t n);

Tb3ImuInfo tb3_imu_info();

// Walk the 7-bit I2C address range and write every address that ACKs into buf
// (at most n). Returns the count found.
//
// Purely diagnostic, and deliberately independent of `present`: it answers the
// one question the WHO_AM_I probe cannot, which is whether the bus is EMPTY
// (nothing powered or wired -- every address NAKs) or whether something is
// alive at an address the probe does not look at. A BNO055 strapped into UART
// mode, or an address-select pin in an unexpected state, is invisible to
// tb3_imu_begin() but shows up here.
size_t tb3_imu_i2c_scan(uint8_t *buf, size_t n);

#endif // ESP32
#endif // TB3_IMU_H
