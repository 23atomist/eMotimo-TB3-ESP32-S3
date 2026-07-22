// src/tb3_imu.h
#ifndef TB3_IMU_H
#define TB3_IMU_H
#if defined(ESP32)

#include <Arduino.h>

// GY-91: genuine MPU-9250 (accel + gyro) + AK8963 magnetometer + BMP280 baro,
// on I2C GPIO8=SDA / GPIO9=SCL. All access is core-0 and mutex-guarded; never
// call these from the step ISR. See docs/hardware-pinmap.md.

#define TB3_IMU_BURST_MAX 500

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

#endif // ESP32
#endif // TB3_IMU_H
