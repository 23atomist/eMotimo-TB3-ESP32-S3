# IMU Foundation — Design

**Status:** approved design, pre-implementation
**Layer:** sensor-fusion (layer 4), increment 1 of N
**Hardware:** genuine MPU-9250 (accel + gyro + AK8963 mag) + BMP280 baro, on the ESP32-S3 I²C bus **GPIO8 = SDA / GPIO9 = SCL** (see `docs/hardware-pinmap.md`).

## Goal

Get the real IMU data flowing off the rig and **measure it** — nothing more. No sensor fusion, no integration into the sun guard or pointing, no frame alignment. Surface raw bursts for characterization plus a few derived live fields, then let the *measured* data quality steer the later increments that actually use it.

This is deliberately the smallest useful step: the "Future sensor inputs" section of the sun-avoidance design (`docs/superpowers/specs/2026-07-17-sun-avoidance-design.md`) reserved a clean attitude seam (`boresightEnu()`), but it never characterized the accel noise on a moving rig and explicitly flagged the magnetometer as *suspect near the steppers*. We measure before we design against it.

## Scope

### In scope
- Firmware IMU driver (`tb3_imu.{h,cpp}`) on the existing GPIO8/9 bus.
- `GET /api/imu?n=N` on-demand raw burst endpoint (characterization workhorse).
- Derived live fields (`imu{ok,pitch,roll,tempC,pressHpa}`) folded into the existing 5 Hz telemetry (tick + `/api/status`).
- Daemon `scripts/imu-probe.mjs` that pulls bursts and reports statistics, tagged by scenario label.
- `DeviceState.imu` ingestion in `device.ts`.
- Removal of the temporary `/api/i2c_scan` probe (the driver's init now owns discovery).

### Deferred (each its own later increment, steered by the data)
- **Fusion** (complementary / Mahony filter) — raw + naive accel-from-gravity tilt only for now.
- **Sensor→mount frame alignment** — bursts and live pitch/roll are **sensor-frame**; `boresightEnu()` is untouched. Aligning the IMU to the pan/tilt frame and feeding or cross-checking the seam is the *integration* increment.
- **Magnetometer heading** — reported raw for characterization only; the open question is whether it is usable near the steppers at all. Never wired into heading here.
- **No MCP tool** — probe script + telemetry fields only; add a tool once we know what is worth exposing.
- **No GPS** — not on this board.

## Firmware

### `tb3_imu.{h,cpp}` (new module, `tb3_web` / `tb3_ota` pattern)

Owns the bus and the sensor. All access is core-0 and mutex-guarded; nothing runs in the step ISR.

Types:

```c
struct Tb3ImuSample {
  uint32_t t_us;      // micros() at read
  float ax, ay, az;   // g
  float gx, gy, gz;   // deg/s
  float mx, my, mz;   // µT (AK8963); NaN if this sample's mag read failed/overflowed
  float tempC;        // BMP280 temperature
  float pressHpa;     // BMP280 pressure
};

struct Tb3ImuInfo {
  bool present;         // all required WHO_AM_I matched
  uint8_t mpu_who;      // 0x71 genuine MPU-9250
  uint8_t mag_who;      // 0x48 AK8963
  uint8_t bmp_id;       // 0x58 BMP280
  uint16_t accel_fs_g;  // configured full-scale, g
  uint16_t gyro_fs_dps; // configured full-scale, deg/s
};
```

API:
- `bool tb3_imu_begin();` — called once from `setup()`. `Wire.begin(8,9)`; create access mutex; WHO_AM_I checks; wake MPU (PWR_MGMT_1 clear sleep, PLL clock); set accel/gyro full-scale; enable bypass (INT_PIN_CFG BYPASS_EN) and init AK8963 (continuous 100 Hz, 16-bit) reading its factory sensitivity adjustment (ASA); read BMP280 calibration coefficients and configure normal mode. Returns `present`. Replaces the lazy `Wire.begin` that was in `/api/i2c_scan`.
- `bool tb3_imu_read(Tb3ImuSample& out);` — one mutex-guarded sample: accel+gyro+temp (14 bytes @ 0x3B), mag (AK8963 @ 0x03 incl. ST2 overflow check), BMP280 raw → compensated (Bosch formula with the read coefficients). Converts to physical units.
- `size_t tb3_imu_burst(Tb3ImuSample* buf, size_t n);` — takes the mutex once, tight-loops `n` reads as fast as the bus allows, `micros()`-stamping each. Returns count read.
- `Tb3ImuInfo tb3_imu_info();`

Unit conversions:
- accel = raw / 32768 × FS_g
- gyro = raw / 32768 × FS_dps
- mag = raw × 0.15 µT/LSB (16-bit) × per-axis ASA adjustment
- baro = Bosch BMP280 compensation → °C, Pa → hPa

Config defaults (revisable once we see data): accel **±4 g**, gyro **±500 °/s**, mag 16-bit continuous, BMP280 standard-res. **I²C 100 kHz** to start — conservative for the ~10 cm marginal-edge wire; `read_errors` in the burst tells us whether 400 kHz would hold.

### `tb3_web.cpp` endpoints & telemetry

- **`GET /api/imu?n=N`** (default 200, cap 500). Allocates a burst buffer, calls `tb3_imu_burst`, frees it, and returns compact JSON:
  ```json
  {"info":{"present":true,"mpu_who":"0x71","mag_who":"0x48","bmp_id":"0x58","accel_fs_g":4,"gyro_fs_dps":500},
   "n":200,"span_us":1012345,"read_errors":0,
   "samples":[[t_us,ax,ay,az,gx,gy,gz,mx,my,mz,tempC,pressHpa], ...]}
  ```
  Samples are arrays (not objects) to keep the payload compact. `present:false` short-circuits with an empty `samples`.
- **Live fields.** The 5 Hz telemetry task reads one sample per tick and caches it (mutex-guarded); `buildTick` and `/api/status` add `imu:{ok, pitch, roll, tempC, pressHpa}`. `pitch`/`roll` come straight from gravity (`atan2`), **sensor-frame** — explicitly *not* boresight tilt (that needs the deferred mount alignment). The tick JSON buffer is enlarged to fit.
- **Remove `/api/i2c_scan`.**

## Daemon

### `scripts/imu-probe.mjs` (new; `jog-probe` / `sun-guard-probe` conventions)

Usage: `node scripts/imu-probe.mjs <IP> [n] [label]`. Pulls `GET /api/imu?n=N` and prints:
- **Effective rate** — from `span_us` and the median inter-sample dt.
- **Accel** — per-axis mean + stddev (noise floor) and mean magnitude (~1.0 g at rest = scale/health sanity).
- **Gyro** — per-axis mean (bias) + stddev.
- **Mag** — per-axis mean + stddev + vector magnitude (µT).
- **Baro** — temp + pressure.
- **`read_errors`** and the WHO_AM_I line.

The `label` tags the run (`rest`, `jog`, `steppers-idle`, `steppers-moving`). Comparing labeled runs — at rest vs during a jog, steppers idle vs energized — is how we see vibration coupling into the accel and whether the mag survives the stepper field. **That comparison is the deliverable of this increment.**

The stats computation (mean/stddev/rate from a samples array) is a small **pure function**, unit-tested offline; the script is the thin I/O wrapper around it.

### `DeviceState` + `device.ts`

- Extend `DeviceState` (`types.ts`): `imu?: { ok: boolean; pitchDeg: number; rollDeg: number; tempC: number; pressHpa: number }`.
- In `device.ts`, the WS `tick` handler reads `d.imu` and updates state immutably — same shape as the existing `pos`/`batt` ingestion. No `any`; `.js` imports.

## Data flow

- **Init:** `setup()` → `tb3_imu_begin()` → bus up, WHO_AM_I, configure, mutex created. Absent sensor → `present=false`.
- **Live (5 Hz):** telemetry task → one mutex-guarded read → cache → `buildTick`/`/api/status` emit `imu{…}` → `device.ts` → `DeviceState.imu`.
- **Burst (on demand):** `imu-probe.mjs` → `GET /api/imu?n=N` → mutex-guarded tight loop → samples JSON → pure stats fn → printed report.

## Failure behavior (fail-safe; never touches motion)

- IMU absent / WHO_AM_I mismatch → `present=false`, `imu.ok=false` everywhere; no crash; motion unaffected.
- Per-sample NAK/timeout → counted in `read_errors`, sample skipped; mag overflow (ST2 HOFL bit) → that sample's mag = `NaN`.
- The access **mutex** serializes the telemetry read and the burst so they never collide on the bus.
- `Wire.setTimeOut` guard → a dropped wire / bus fault returns fast instead of wedging the core-0 task.
- Burst `N` capped at 500 → bounded memory and time.
- Everything is core-0; the step ISR and motion planner are untouched. **This layer cannot affect pointing or motion safety.**

## Testing

- **Pure stats function** (mean/stddev/effective-rate from a samples array) — vitest, offline. The "pure math tested offline" pattern the rest of the daemon follows.
- **Telemetry ingestion** — extend the mock-TB3 harness to emit `imu` fields in its tick; a vitest asserts `device.ts` lands them in `DeviceState.imu`. Respects `fileParallelism:false` + deconflicted ports (8791–8802 taken).
- **Firmware live at the bench** — the probe's accel-magnitude ≈ 1 g at rest is the end-to-end proof the driver, conversions, and bus all work; `read_errors` characterizes the long-wire bus health.

## Success criteria

1. `GET /api/imu?n=200` returns 200 timestamped samples in physical units with `read_errors` low and `present:true` (WHO_AM_I 0x71 / 0x48 / 0x58).
2. `imu-probe.mjs` prints a clean statistical report; accel magnitude ≈ 1 g at rest.
3. Labeled runs at rest vs jogging (and steppers idle vs moving) give us the **measured** accel noise floor, gyro bias, and magnetometer behavior near the steppers — the inputs the next increment's fusion/integration design needs.
4. `DeviceState.imu` reflects live pitch/roll/baro; daemon tests green; `tsc --noEmit` and `npm run build` clean; firmware builds clean.
