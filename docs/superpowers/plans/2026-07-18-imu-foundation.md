# IMU Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the genuine MPU-9250 + BMP280 IMU data flowing off the rig and measurable, so the accel noise, vibration coupling, and magnetometer usability can be characterized before any fusion or sun-guard integration is designed.

**Architecture:** A new firmware driver (`tb3_imu`) owns the GPIO8/9 I²C bus and serves both an on-demand raw burst endpoint (`GET /api/imu?n=N`) and a cached live sample folded into the existing 5 Hz telemetry. On the daemon, a pure stats function digests a burst, a probe script prints a labeled statistical report, and `device.ts` ingests the live fields into `DeviceState`. All IMU access is core-0 and mutex-guarded; the step ISR and motion planner are untouched.

**Tech Stack:** Firmware — Arduino/ESP32-S3 C++, ESPAsyncWebServer, ArduinoJson v7. Daemon — TypeScript / Node ESM (tb3-mcp), vitest.

## Global Constraints

- **Firmware build:** `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"; pio run -e esp32-s3-devkitc-1` must succeed clean. ArduinoJson v7 API (`JsonDocument`, `obj["k"].to<JsonObject>()`). ESPAsyncWebServer handlers.
- **Daemon build:** from `tb3-mcp/`, `npx tsc --noEmit` and `npm run build` clean; `npm test` green. ESM with **`.js` import extensions mandatory**, **no `any`**.
- **Test ports:** vitest `fileParallelism:false`; ports **8791–8802 are taken** — the new daemon test uses **8803**.
- **IMU hardware:** genuine MPU-9250 @ `0x68` (WHO_AM_I `0x71`), AK8963 mag @ `0x0C` (WIA `0x48`, via bypass), BMP280 @ `0x76` (id `0x58`). Bus **GPIO8 = SDA, GPIO9 = SCL**, **I²C 100 kHz**. Ranges: accel **±4 g**, gyro **±500 °/s**, mag 16-bit continuous.
- **Concurrency:** every IMU/`Wire` access is core-0 and guarded by a single FreeRTOS mutex. Never in the step ISR.
- **Burst wire shape (`GET /api/imu?n=N`), exact:**
  ```json
  {"info":{"present":true,"mpu_who":"0x71","mag_who":"0x48","bmp_id":"0x58","accel_fs_g":4,"gyro_fs_dps":500},
   "n":200,"span_us":1012345,"read_errors":0,
   "samples":[[t_us,ax,ay,az,gx,gy,gz,mx,my,mz,tempC,pressHpa], ...]}
  ```
  Sample element order is fixed: `[t_us, ax,ay,az, gx,gy,gz, mx,my,mz, tempC, pressHpa]`. Units: g, °/s, µT, °C, hPa. A failed/overflowed mag read serializes its `mx,my,mz` as JSON `null` (ArduinoJson renders `NaN` as `null`). `present:false` → empty `samples`.
- **Live wire shape (in the WS `tick` and `/api/status`):** `"imu":{"ok":true,"pitch":<deg>,"roll":<deg>,"tempC":<c>,"pressHpa":<hpa>}`. `pitch`/`roll` are **sensor-frame** gravity angles, not boresight tilt.
- **`DeviceState.imu` shape:** `{ ok: boolean; pitchDeg: number; rollDeg: number; tempC: number; pressHpa: number }` — the tick's `pitch`→`pitchDeg`, `roll`→`rollDeg`.
- **Deferred (NOT in this plan):** fusion filter, sensor→mount frame alignment, magnetometer heading, any MCP tool, GPS.

---

## File Structure

- `tb3-mcp/src/imu-stats.ts` (new) — pure burst→statistics function. No I/O.
- `tb3-mcp/test/imu-stats.test.ts` (new) — vitest for the stats function.
- `tb3-mcp/src/types.ts` (modify) — add `imu?` to `DeviceState`.
- `tb3-mcp/src/device.ts` (modify) — ingest `d.imu` in `onTick`.
- `tb3-mcp/test/mock-tb3.ts` (modify) — emit `imu` in `pushTick`.
- `tb3-mcp/test/imu-ingest.test.ts` (new) — assert `DeviceState.imu` populates.
- `tb3-mcp/scripts/imu-probe.mjs` (new) — CLI burst→report (imports `dist/imu-stats.js`).
- `tb3-mcp/README.md` (modify) — one-line probe mention.
- `src/tb3_imu.h`, `src/tb3_imu.cpp` (new) — the firmware driver.
- `src/TB3_Black_109_Release1.ino` (modify:961) — call `tb3_imu_begin()` in setup.
- `src/tb3_web.cpp` (modify) — `/api/imu` endpoint, live `imu` fields, remove `/api/i2c_scan`.

---

## Task 1: Daemon — pure IMU stats function

**Files:**
- Create: `tb3-mcp/src/imu-stats.ts`
- Test: `tb3-mcp/test/imu-stats.test.ts`

**Interfaces:**
- Produces: `computeImuStats(burst: ImuBurst): ImuStats`, and the exported `ImuBurst`, `ImuStats`, `AxisStats` types. Consumed by Task 3's probe script.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/imu-stats.test.ts
import { describe, it, expect } from "vitest";
import { computeImuStats, type ImuBurst } from "../src/imu-stats.js";

// Two samples 5000µs apart → 200 Hz. Accel z alternates 1.00/1.02 (mean 1.01,
// nonzero std); gyro x is a constant 0.5 bias; mag on sample 2 is null (a failed
// read) so validCount must be 1 and mag stats ignore the null.
const burst: ImuBurst = {
  info: { present: true, mpu_who: "0x71", mag_who: "0x48", bmp_id: "0x58", accel_fs_g: 4, gyro_fs_dps: 500 },
  n: 2, span_us: 5000, read_errors: 0,
  samples: [
    [0,     0, 0, 1.00, 0.5, 0, 0, 20, 0, -40, 25.0, 1013.0],
    [5000,  0, 0, 1.02, 0.5, 0, 0, 22, 0, -38, 25.2, 1013.2],
  ],
};

describe("computeImuStats", () => {
  it("computes rate, per-axis mean/std, magnitudes, and skips null mag samples", () => {
    const s = computeImuStats(burst);
    expect(s.sampleCount).toBe(2);
    expect(s.rateHz).toBeCloseTo(200, 1);          // 1 / 5000µs
    expect(s.accel.z.mean).toBeCloseTo(1.01, 6);
    expect(s.accel.z.std).toBeGreaterThan(0);
    expect(s.accel.magMean).toBeCloseTo(1.01, 2);  // |[0,0,~1.01]|
    expect(s.gyro.x.mean).toBeCloseTo(0.5, 6);     // constant bias
    expect(s.gyro.x.std).toBeCloseTo(0, 6);
    expect(s.mag.validCount).toBe(2);
    expect(s.readErrors).toBe(0);
  });

  it("counts null mag rows as invalid and computes mag stats over the rest", () => {
    const b: ImuBurst = { ...burst, samples: [
      [0,    0,0,1, 0,0,0, 20,0,-40, 25,1013],
      [5000, 0,0,1, 0,0,0, null,null,null, 25,1013],  // failed mag read
    ]};
    const s = computeImuStats(b);
    expect(s.mag.validCount).toBe(1);
    expect(s.mag.x.mean).toBeCloseTo(20, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/imu-stats.test.ts`
Expected: FAIL — `computeImuStats` is not defined.

- [ ] **Step 3: Write the implementation**

```typescript
// tb3-mcp/src/imu-stats.ts

/** One burst as returned by GET /api/imu. Sample element order is fixed:
 *  [t_us, ax,ay,az, gx,gy,gz, mx,my,mz, tempC, pressHpa]. Mag entries may be
 *  null (a failed/overflowed read on that sample). */
export interface ImuBurst {
  info: {
    present: boolean;
    mpu_who: string; mag_who: string; bmp_id: string;
    accel_fs_g: number; gyro_fs_dps: number;
  };
  n: number;
  span_us: number;
  read_errors: number;
  samples: ReadonlyArray<ReadonlyArray<number | null>>;
}

export interface AxisStats { mean: number; std: number; }

export interface ImuStats {
  sampleCount: number;
  rateHz: number;
  readErrors: number;
  accel: { x: AxisStats; y: AxisStats; z: AxisStats; magMean: number };
  gyro: { x: AxisStats; y: AxisStats; z: AxisStats };
  mag: { x: AxisStats; y: AxisStats; z: AxisStats; magMean: number; validCount: number };
  baro: { tempMean: number; pressMean: number };
}

function axisStats(values: readonly number[]): AxisStats {
  const n = values.length;
  if (n === 0) return { mean: NaN, std: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Column indices into a sample row.
const T = 0, AX = 1, AY = 2, AZ = 3, GX = 4, GY = 5, GZ = 6, MX = 7, MY = 8, MZ = 9, TEMP = 10, PRESS = 11;

export function computeImuStats(burst: ImuBurst): ImuStats {
  const rows = burst.samples;
  const col = (i: number): number[] => rows.map((r) => Number(r[i]));

  // Effective rate from the median inter-sample dt (robust; see the project's
  // 5 Hz-aliasing lesson — median beats mean for rate).
  const t = rows.map((r) => Number(r[T]));
  const dts: number[] = [];
  for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
  const medDtUs = median(dts);
  const rateHz = medDtUs > 0 ? 1e6 / medDtUs : NaN;

  const ax = axisStats(col(AX)), ay = axisStats(col(AY)), az = axisStats(col(AZ));
  const accelMag = rows.map((r) => Math.hypot(Number(r[AX]), Number(r[AY]), Number(r[AZ])));

  // Mag rows with any null component are invalid; stats over the finite rest.
  const magRows = rows.filter((r) => r[MX] != null && r[MY] != null && r[MZ] != null);
  const mx = magRows.map((r) => Number(r[MX]));
  const my = magRows.map((r) => Number(r[MY]));
  const mz = magRows.map((r) => Number(r[MZ]));
  const magMag = magRows.map((r) => Math.hypot(Number(r[MX]), Number(r[MY]), Number(r[MZ])));

  return {
    sampleCount: rows.length,
    rateHz,
    readErrors: burst.read_errors,
    accel: { x: ax, y: ay, z: az, magMean: axisStats(accelMag).mean },
    gyro: { x: axisStats(col(GX)), y: axisStats(col(GY)), z: axisStats(col(GZ)) },
    mag: { x: axisStats(mx), y: axisStats(my), z: axisStats(mz), magMean: axisStats(magMag).mean, validCount: magRows.length },
    baro: { tempMean: axisStats(col(TEMP)).mean, pressMean: axisStats(col(PRESS)).mean },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/imu-stats.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `cd tb3-mcp && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/imu-stats.ts tb3-mcp/test/imu-stats.test.ts
git commit -m "feat(imu): pure burst->statistics function"
```

---

## Task 2: Daemon — DeviceState.imu ingestion

**Files:**
- Modify: `tb3-mcp/src/types.ts`
- Modify: `tb3-mcp/src/device.ts:85-98` (the `onTick` method)
- Modify: `tb3-mcp/test/mock-tb3.ts` (the `pushTick` method)
- Test: `tb3-mcp/test/imu-ingest.test.ts`

**Interfaces:**
- Consumes: the live `imu` tick shape from Global Constraints.
- Produces: `DeviceState.imu?: { ok: boolean; pitchDeg: number; rollDeg: number; tempC: number; pressHpa: number }`.

- [ ] **Step 1: Add the field to the mock's tick**

In `tb3-mcp/test/mock-tb3.ts`, inside `pushTick()`'s object literal (after `sta: "192.168.1.50",`), add:

```typescript
      imu: { ok: true, pitch: 1.5, roll: -2.0, tempC: 25.4, pressHpa: 1013.1 },
```

- [ ] **Step 2: Write the failing test**

```typescript
// tb3-mcp/test/imu-ingest.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8803;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });

describe("DeviceState.imu ingestion", () => {
  it("populates imu from the WS tick", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
    dev = new Device(cfg); dev.start();
    await waitFor(() => dev!.getState().imu !== undefined);
    const imu = dev.getState().imu;
    expect(imu).toBeDefined();
    expect(imu!.ok).toBe(true);
    expect(imu!.pitchDeg).toBeCloseTo(1.5, 6);
    expect(imu!.rollDeg).toBeCloseTo(-2.0, 6);
    expect(imu!.tempC).toBeCloseTo(25.4, 6);
    expect(imu!.pressHpa).toBeCloseTo(1013.1, 6);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/imu-ingest.test.ts`
Expected: FAIL — `imu` is `undefined` (device does not parse it yet).

- [ ] **Step 4: Extend `DeviceState`**

In `tb3-mcp/src/types.ts`, add the field to the interface (after `lastUpdateMs: number;`):

```typescript
  imu?: {
    ok: boolean;
    pitchDeg: number;
    rollDeg: number;
    tempC: number;
    pressHpa: number;
  };
```

- [ ] **Step 5: Ingest it in `onTick`**

In `tb3-mcp/src/device.ts`, inside `onTick`, after the line `this.state.lastUpdateMs = this.now();` and before the closing `}` of the `try`, add:

```typescript
      if (d.imu && typeof d.imu === "object") {
        this.state.imu = {
          ok: d.imu.ok === true,
          pitchDeg: Number(d.imu.pitch),
          rollDeg: Number(d.imu.roll),
          tempC: Number(d.imu.tempC),
          pressHpa: Number(d.imu.pressHpa),
        };
      }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/imu-ingest.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite + typecheck (no regressions in the other device/mock tests)**

Run: `cd tb3-mcp && npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add tb3-mcp/src/types.ts tb3-mcp/src/device.ts tb3-mcp/test/mock-tb3.ts tb3-mcp/test/imu-ingest.test.ts
git commit -m "feat(imu): ingest live imu fields into DeviceState"
```

---

## Task 3: Daemon — imu-probe.mjs

**Files:**
- Create: `tb3-mcp/scripts/imu-probe.mjs`
- Modify: `tb3-mcp/README.md`

**Interfaces:**
- Consumes: `computeImuStats` from `../dist/imu-stats.js` (Task 1, compiled), and the burst wire shape.

- [ ] **Step 1: Build so `dist/imu-stats.js` exists**

Run: `cd tb3-mcp && npm run build`
Expected: build succeeds; `dist/imu-stats.js` is present.

- [ ] **Step 2: Write the script**

```javascript
// tb3-mcp/scripts/imu-probe.mjs
//
// IMU characterization probe. Pulls a raw burst from the firmware and prints
// per-axis statistics. Run at rest and again during a jog (and with the
// steppers idle vs moving) using the label arg; comparing labeled runs is how
// we judge vibration coupling into the accel and whether the mag survives the
// stepper field.
//
// Requires a build first (imports the compiled stats fn so math is not
// duplicated):  npm run build
//
// Usage (from tb3-mcp/):  node scripts/imu-probe.mjs <IP> [n=200] [label]
//   e.g.  node scripts/imu-probe.mjs 192.168.4.56 200 rest

import { computeImuStats } from "../dist/imu-stats.js";

const ip = process.argv[2];
const n = Number(process.argv[3] ?? 200);
const label = process.argv[4] ?? "";
if (!ip) {
  console.error("usage: node scripts/imu-probe.mjs <IP> [n=200] [label]");
  console.error("  (run `npm run build` first — imports dist/imu-stats.js)");
  process.exit(1);
}

const res = await fetch(`http://${ip}/api/imu?n=${n}`);
if (!res.ok) { console.error(`GET /api/imu -> HTTP ${res.status}`); process.exit(1); }
const burst = await res.json();

if (!burst.info?.present) {
  console.error("IMU not present:", JSON.stringify(burst.info));
  process.exit(1);
}

const s = computeImuStats(burst);
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "NaN");

console.log(`\n=== IMU burst ${label ? `[${label}] ` : ""}${new Date().toISOString()} ===`);
console.log(`chip     MPU ${burst.info.mpu_who}  MAG ${burst.info.mag_who}  BMP ${burst.info.bmp_id}` +
            `   (accel ±${burst.info.accel_fs_g}g, gyro ±${burst.info.gyro_fs_dps}dps)`);
console.log(`samples  ${s.sampleCount}   rate ${f(s.rateHz, 1)} Hz   read_errors ${s.readErrors}`);
console.log(`accel g  x ${f(s.accel.x.mean)}±${f(s.accel.x.std)}  y ${f(s.accel.y.mean)}±${f(s.accel.y.std)}  ` +
            `z ${f(s.accel.z.mean)}±${f(s.accel.z.std)}   |a| ${f(s.accel.magMean)} (expect ~1.0 at rest)`);
console.log(`gyro dps x ${f(s.gyro.x.mean)}±${f(s.gyro.x.std)}  y ${f(s.gyro.y.mean)}±${f(s.gyro.y.std)}  ` +
            `z ${f(s.gyro.z.mean)}±${f(s.gyro.z.std)}   (mean = bias)`);
console.log(`mag µT   x ${f(s.mag.x.mean, 2)}±${f(s.mag.x.std, 2)}  y ${f(s.mag.y.mean, 2)}±${f(s.mag.y.std, 2)}  ` +
            `z ${f(s.mag.z.mean, 2)}±${f(s.mag.z.std, 2)}   |m| ${f(s.mag.magMean, 2)}  valid ${s.mag.validCount}/${s.sampleCount}`);
console.log(`baro     ${f(s.baro.tempMean, 2)} °C   ${f(s.baro.pressMean, 2)} hPa`);
```

- [ ] **Step 3: Syntax-check the script**

Run: `cd tb3-mcp && node --check scripts/imu-probe.mjs`
Expected: no output (valid). (Full behavior is validated live at the bench in Task 6 — there is no mock for `/api/imu`; the statistical math it calls is already unit-tested in Task 1.)

- [ ] **Step 4: Add a README line**

In `tb3-mcp/README.md`, in the probe/scripts area, add:

```markdown
- `node scripts/imu-probe.mjs <IP> [n] [label]` — pulls a raw IMU burst from `GET /api/imu` and prints per-axis accel/gyro/mag statistics (noise floor, gyro bias, mag stability). Run at rest vs during a jog (label the runs) to characterize vibration coupling and magnetometer usability. Requires `npm run build`.
```

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/scripts/imu-probe.mjs tb3-mcp/README.md
git commit -m "feat(imu): imu-probe.mjs characterization script"
```

---

## Task 4: Firmware — tb3_imu driver module

**Files:**
- Create: `src/tb3_imu.h`, `src/tb3_imu.cpp`

**Interfaces:**
- Produces: `tb3_imu_begin()`, `tb3_imu_read(Tb3ImuSample&)`, `tb3_imu_burst(buf, n)`, `tb3_imu_info()`, and the `Tb3ImuSample` / `Tb3ImuInfo` structs + `TB3_IMU_BURST_MAX`. Consumed by Task 5 (`tb3_web.cpp`).

- [ ] **Step 1: Write the header**

```cpp
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
  bool present;         // all required WHO_AM_I matched
  uint8_t mpu_who;      // 0x71 genuine MPU-9250
  uint8_t mag_who;      // 0x48 AK8963
  uint8_t bmp_id;       // 0x58 BMP280
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
```

- [ ] **Step 2: Write the implementation**

```cpp
// src/tb3_imu.cpp
#if defined(ESP32)

#include "tb3_imu.h"
#include <Wire.h>
#include <math.h>

// ---- register maps -------------------------------------------------------
// MPU-9250 (0x68)
static const uint8_t MPU_ADDR       = 0x68;
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
static const uint8_t AK_ST1    = 0x02; // DRDY=bit0
static const uint8_t AK_HXL    = 0x03; // 6 bytes little-endian, then ST2
static const uint8_t AK_ST2    = 0x09; // HOFL=bit3 (must be read to latch next)
static const uint8_t AK_CNTL1  = 0x0A; // mode[3:0], BIT(16-bit)=bit4
static const uint8_t AK_ASAX   = 0x10; // fuse-ROM sensitivity adjust
// BMP280 (0x76)
static const uint8_t BMP_ADDR   = 0x76;
static const uint8_t BMP_ID     = 0xD0; // -> 0x58
static const uint8_t BMP_RESET  = 0xE0; // write 0xB6
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
  Wire.begin(8, 9);
  Wire.setClock(100000);
  Wire.setTimeOut(15);

  // MPU wake + ranges
  wr(MPU_ADDR, MPU_PWR_MGMT_1, 0x80); delay(100);   // reset
  wr(MPU_ADDR, MPU_PWR_MGMT_1, 0x01); delay(10);    // wake, PLL clock
  wr(MPU_ADDR, MPU_GYRO_CFG, 0x08);                 // ±500 dps (FS_SEL=1)
  wr(MPU_ADDR, MPU_ACCEL_CFG, 0x08);                // ±4 g (AFS_SEL=1)
  wr(MPU_ADDR, MPU_USER_CTRL, 0x00);                // I2C master off (bypass usable)
  wr(MPU_ADDR, MPU_INT_PIN_CFG, 0x02);              // BYPASS_EN
  delay(10);

  s_info.mpu_who = rd1(MPU_ADDR, MPU_WHOAMI);
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
  s_info.present = (s_info.mpu_who == 0x71 || s_info.mpu_who == 0x73);
  return s_info.present;
}

// Read one sample WITHOUT taking the mutex (caller holds it).
static bool read_locked(Tb3ImuSample &o) {
  o.t_us = micros();
  uint8_t b[14];
  if (!rd(MPU_ADDR, MPU_ACCEL_XOUT_H, b, 14)) return false;
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
```

> Note: delete the vestigial `ak8963_init` stub and its `(void)ak8963_init;` line — it is a leftover; `tb3_imu_begin` does the AK8963 init inline. (Left here only to flag: no dead helpers in the final file.)

- [ ] **Step 3: Compile**

Run: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && cd /Volumes/ExtData2/coding/TB3-ESP32 && pio run -e esp32-s3-devkitc-1`
Expected: `[SUCCESS]`. (Not wired into the build's call graph yet beyond the file compiling — the `.ino`/`tb3_web` wiring is Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/tb3_imu.h src/tb3_imu.cpp
git commit -m "feat(imu): MPU-9250/AK8963/BMP280 driver module"
```

---

## Task 5: Firmware — wire the driver into telemetry + endpoint

**Files:**
- Modify: `src/TB3_Black_109_Release1.ino:961` (setup)
- Modify: `src/tb3_web.cpp` (add `#include "tb3_imu.h"`, `/api/imu`, live fields; remove `/api/i2c_scan`)

**Interfaces:**
- Consumes: everything from `tb3_imu.h` (Task 4).
- Produces: `GET /api/imu?n=N` and the live `imu` tick/status fields (Global Constraints shapes). Consumed by Task 3's probe and Task 2's ingestion (already built against the same shapes).

- [ ] **Step 1: Call the driver init in setup**

In `src/TB3_Black_109_Release1.ino`, at line 961–962 the setup calls `tb3_web_begin();` then `tb3_gamepad_begin();`. Add after `tb3_gamepad_begin();`:

```cpp
tb3_imu_begin();
```

And near the other module includes at the top of that `.ino` (with the `#if defined(ESP32)` includes), add:

```cpp
#include "tb3_imu.h"
```

- [ ] **Step 2: Include the driver in the web module**

In `src/tb3_web.cpp`, near the top includes (after `#include <Wire.h>`), add:

```cpp
#include "tb3_imu.h"
```

- [ ] **Step 3: Cache a live sample in the telemetry task**

In `src/tb3_web.cpp`, in `telemetryTask`, add an IMU read once per tick. Add a file-static cache near the other `static` telemetry state (top of file):

```cpp
static Tb3ImuSample s_imu_live = {};
static bool s_imu_live_ok = false;
```

Then in `telemetryTask`'s loop, before `buildTick` is used (i.e. right after `vTaskDelay(...)`), add:

```cpp
    { Tb3ImuSample smp; if (tb3_imu_read(smp)) { s_imu_live = smp; s_imu_live_ok = true; } }
```

- [ ] **Step 4: Add the live `imu` object to `buildTick`**

In `src/tb3_web.cpp`, change `buildTick` to append the `imu` object. Compute sensor-frame pitch/roll from the cached accel and extend the format string + buffer. Replace the `return snprintf(...)` block with:

```cpp
  // Sensor-frame gravity angles (NOT boresight tilt — see the IMU spec).
  float pitch = 0, roll = 0;
  if (s_imu_live_ok) {
    pitch = atan2f(-s_imu_live.ax, sqrtf(s_imu_live.ay * s_imu_live.ay + s_imu_live.az * s_imu_live.az)) * 57.29578f;
    roll  = atan2f(s_imu_live.ay, s_imu_live.az) * 57.29578f;
  }
  return snprintf(buf, len,
    "{\"type\":\"tick\",\"lcd\":[\"%s\",\"%s\"],\"pos\":[%.0f,%.0f,%.0f],"
    "\"moving\":%u,\"prog\":%d,\"fired\":%u,\"total\":%u,\"batt\":%.2f,"
    "\"bt\":{\"c\":%d,\"n\":\"%s\",\"p\":%d},\"sta\":\"%s\","
    "\"imu\":{\"ok\":%d,\"pitch\":%.2f,\"roll\":%.2f,\"tempC\":%.2f,\"pressHpa\":%.2f}}",
    e1, e2, st.pan, st.tilt, st.aux,
    (unsigned)st.moving, st.program_engaged ? 1 : 0,
    st.camera_fired, st.camera_total, st.battery_v,
    tb3_gamepad_connected() ? 1 : 0, btn, tb3_gamepad_pairing() ? 1 : 0, sta,
    s_imu_live_ok ? 1 : 0, pitch, roll,
    s_imu_live_ok ? s_imu_live.tempC : 0.0f, s_imu_live_ok ? s_imu_live.pressHpa : 0.0f);
```

Then enlarge the `telemetryTask` tick buffer from `char buf[400];` to `char buf[512];`.

- [ ] **Step 5: Add the live `imu` object to `/api/status`**

In `src/tb3_web.cpp`, in the `/api/status` handler, before `String out; serializeJson(d, out);`, add:

```cpp
    JsonObject imu = d["imu"].to<JsonObject>();
    imu["ok"] = s_imu_live_ok;
    if (s_imu_live_ok) {
      float pitch = atan2f(-s_imu_live.ax, sqrtf(s_imu_live.ay * s_imu_live.ay + s_imu_live.az * s_imu_live.az)) * 57.29578f;
      float roll  = atan2f(s_imu_live.ay, s_imu_live.az) * 57.29578f;
      imu["pitch"] = pitch; imu["roll"] = roll;
      imu["tempC"] = s_imu_live.tempC; imu["pressHpa"] = s_imu_live.pressHpa;
    }
```

- [ ] **Step 6: Add the `/api/imu` burst endpoint and REMOVE `/api/i2c_scan`**

In `src/tb3_web.cpp`, delete the entire `/api/i2c_scan` handler (the block from its comment through its closing `});`). In its place add the burst endpoint (streamed to avoid a large buffer):

```cpp
  // IMU raw burst for characterization. Reads N samples in a tight mutex-held
  // loop (timing is real), then returns them as one JSON body. Built into a
  // capacity-reserved String (not AsyncResponseStream, whose fixed internal
  // buffer would silently truncate a ~40KB body). See docs/superpowers/specs/
  // 2026-07-18-imu-foundation-design.md.
  s_server.on("/api/imu", HTTP_GET, [](AsyncWebServerRequest *req) {
    static Tb3ImuSample burst[TB3_IMU_BURST_MAX];
    size_t n = 200;
    if (req->hasParam("n")) {
      long v = req->getParam("n")->value().toInt();
      if (v < 1) v = 1; if (v > TB3_IMU_BURST_MAX) v = TB3_IMU_BURST_MAX;
      n = (size_t)v;
    }
    Tb3ImuInfo info = tb3_imu_info();
    size_t got = info.present ? tb3_imu_burst(burst, n) : 0;
    uint32_t span = (got > 1) ? (burst[got - 1].t_us - burst[0].t_us) : 0;

    String out; out.reserve(got * 96 + 256);
    char h[8], row[176];
    out += "{\"info\":{";
    out += info.present ? "\"present\":true," : "\"present\":false,";
    snprintf(h, sizeof(h), "0x%02X", info.mpu_who); out += "\"mpu_who\":\""; out += h; out += "\",";
    snprintf(h, sizeof(h), "0x%02X", info.mag_who); out += "\"mag_who\":\""; out += h; out += "\",";
    snprintf(h, sizeof(h), "0x%02X", info.bmp_id);  out += "\"bmp_id\":\""; out += h; out += "\",";
    snprintf(row, sizeof(row), "\"accel_fs_g\":%u,\"gyro_fs_dps\":%u},", info.accel_fs_g, info.gyro_fs_dps); out += row;
    snprintf(row, sizeof(row), "\"n\":%u,\"span_us\":%u,\"read_errors\":%u,\"samples\":[",
             (unsigned)got, (unsigned)span, (unsigned)(n - got)); out += row;
    for (size_t i = 0; i < got; i++) {
      const Tb3ImuSample &s = burst[i];
      if (i) out += ",";
      if (isnan(s.mx))
        snprintf(row, sizeof(row), "[%u,%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,null,null,null,%.3f,%.3f]",
                 s.t_us, s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.tempC, s.pressHpa);
      else
        snprintf(row, sizeof(row), "[%u,%.5f,%.5f,%.5f,%.4f,%.4f,%.4f,%.3f,%.3f,%.3f,%.3f,%.3f]",
                 s.t_us, s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.mx, s.my, s.mz, s.tempC, s.pressHpa);
      out += row;
    }
    out += "]}";
    AsyncWebServerResponse *r = req->beginResponse(200, "application/json", out);
    r->addHeader("Cache-Control", "no-store");
    req->send(r);
  });
```

- [ ] **Step 7: Compile**

Run: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && cd /Volumes/ExtData2/coding/TB3-ESP32 && pio run -e esp32-s3-devkitc-1`
Expected: `[SUCCESS]`.

- [ ] **Step 8: Commit**

```bash
git add src/TB3_Black_109_Release1.ino src/tb3_web.cpp
git commit -m "feat(imu): /api/imu burst + live imu telemetry; drop i2c_scan probe"
```

---

## Task 6: Bench validation (live, camera-removed)

**Files:** none — this is the acceptance step. Requires the physical rig reachable (DHCP; currently `192.168.4.56`, else its AP `10.31.31.1`). OTA over WiFi is slow (~60–70 s) and a `curl: (56) connection reset` at the end is the post-flash restart, i.e. success — confirm via the new build date in `/api/info`.

- [ ] **Step 1: Flash the firmware**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32
curl -s http://<IP>/api/ota                                                # expect {"safe":true}
curl -F "firmware=@.pio/build/esp32-s3-devkitc-1/firmware.bin" http://<IP>/api/ota
# wait for reboot, confirm a new build date:
curl -s http://<IP>/api/info
```

- [ ] **Step 2: Confirm the driver came up**

```bash
curl -s "http://<IP>/api/imu?n=1" | python3 -m json.tool
```
Expected: `info.present: true`, `mpu_who "0x71"`, `mag_who "0x48"`, `bmp_id "0x58"`.

- [ ] **Step 3: Build the daemon and characterize AT REST**

```bash
cd tb3-mcp && npm run build
node scripts/imu-probe.mjs <IP> 200 rest
```
Expected: `rate` ~100–400 Hz, `read_errors` low, **accel `|a|` ≈ 1.00 g** (the end-to-end proof the driver/conversions/bus all work). Record accel per-axis std (the noise floor), gyro means (bias), mag `|m|` + `valid` count.

- [ ] **Step 4: Characterize DURING A JOG and with steppers moving**

Trigger a slow jog from your MCP client / the web UI, then during the motion:
```bash
node scripts/imu-probe.mjs <IP> 200 jog
```
Compare `jog` vs `rest`: accel std rise = vibration coupling; mag `valid`/stability change = stepper-field impact. This comparison is the deliverable — it's the input the next (fusion/integration) increment's design needs.

- [ ] **Step 5: Confirm live telemetry ingestion**

```bash
curl -s http://<IP>/api/status | python3 -c "import sys,json;print(json.load(sys.stdin)['imu'])"
```
Expected: `{'ok': True, 'pitch': ..., 'roll': ..., 'tempC': ..., 'pressHpa': ...}`.

- [ ] **Step 6: Record findings**

Append the measured numbers (rest vs jog: accel noise floor, gyro bias, mag behavior, read-error rate, effective sample rate) to the memory note `tb3-rig-hardware-facts.md` — they seed the fusion/integration increment.

---

## Self-Review

**Spec coverage:**
- Firmware driver on GPIO8/9, mutex, core-0 → Task 4. ✓
- `GET /api/imu?n=N` burst → Task 5 step 6. ✓
- Live `imu` fields in tick + `/api/status` → Task 5 steps 4–5. ✓
- Remove `/api/i2c_scan` → Task 5 step 6. ✓
- `imu-probe.mjs` + labeled runs → Task 3, Task 6 steps 3–4. ✓
- `DeviceState.imu` ingestion + mock + test → Task 2. ✓
- Pure stats fn tested offline → Task 1. ✓
- Physical units, ±4 g / ±500 dps, 100 kHz → Task 4. ✓
- Fail-safe (present=false, NaN mag, mutex, setTimeOut, N cap) → Task 4/5. ✓
- Deferred items (fusion, frame alignment, mag heading, MCP tool, GPS) → none present. ✓

**Placeholder scan:** no TBD/TODO; every code step has complete code. The one flagged leftover (`ak8963_init` stub) is explicitly called out for deletion in Task 4's note.

**Type consistency:** wire shapes (`imu` object, burst sample order) are fixed in Global Constraints and reused verbatim in Tasks 1/2/3/5. `Tb3ImuSample`/`Tb3ImuInfo`/`TB3_IMU_BURST_MAX` defined in Task 4, consumed in Task 5. `DeviceState.imu` (`pitchDeg`/`rollDeg`) defined in Task 2 and mapped from the tick's `pitch`/`roll`.
