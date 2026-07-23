# IMU-Aided Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the near-horizon-degenerate 2-point TRIAD calibration with a gravity-anchored solve that also recovers the camera boresight offset, so above-horizon targets point *up* instead of into the ground.

**Architecture:** The IMU accelerometer supplies the vertical the two near-horizon landmarks cannot. A one-time `characterize_imu` sweep solves the IMU→head mounting `R_s`; thereafter one gravity reading gives the base-frame down vector `d_base`, which anchors the vertical (2 DOF), and the landmark sightings fix the heading (1 DOF) *and* the camera boresight offset `c_head` (the camera does not look down the mechanical axis). All ENU↔pan/tilt mapping routes through one offset-aware model so pointing, tracking, sun-guard, and ADS-B stay consistent. A geo-layer pan-handedness sign (`geoPanSign`) corrects the inverted pan convention the gravity anchor exposes, without touching the jog/tracking motion path.

**Tech Stack:** TypeScript/Node ESM, vitest (`fileParallelism:false`), Zod. No new runtime dependencies (linear algebra is hand-rolled, matching the existing `src/geo/vec3.ts`).

## Global Constraints

- No `any`; all imports use `.js` specifiers; ESM throughout.
- The existing test suite (85 tests as of `cac1281`) must stay green — the new model is **backward-compatible by construction**: with `cHead` absent it defaults to `[0,1,0]` and with `geoPanSign` at its default `+1` the forward/inverse reduce *exactly* to today's `panTiltToMount` / `enuToPanTilt`.
- Golden reference for every numeric assertion: `tb3-mcp/scripts/imu-calib-validate.py` (run: `cd tb3-mcp && python3 scripts/imu-calib-validate.py`). Its printed numbers are the oracle. The convention assertion `M(pan,tilt)·[0,1,0] == panTiltToMount(pan,tilt)` must hold in TS too.
- Firmware emits bare `nan` in `/api/imu` sample arrays (absent baro on the 6-DOF MPU-6050). Sanitize `nan`/`inf`→`null` before `JSON.parse` — for arrays use `.replace(/nan/gi,"null")` (NOT `/inf/`, which matches "info").
- `geoPanSign` default stays `+1` (keeps the 85 tests unchanged); the **host** sets `TB3_GEO_PAN_SIGN=-1` (the validated value) via env. Do not change the default in this plan.
- Motion tools (`characterize_imu`) must respect pan/tilt limits, the sun guard, and the deadman — same as the existing motion tools.
- Build/test from `tb3-mcp/`: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"`; single file `npx vitest run test/<file>.ts`; full `npm test`; type-check `npm run build` (tsc).

**Field data (used verbatim in fixtures):**
- Rig: `lat 33.38317744521082, lon -112.14130929961672, height 331`.
- Sighting A_towers: `lat 33.3335, lon -112.0632, height 931, panDeg -26.0, tiltDeg -31.0` → ENU `az 127.1365°, el 3.7219°`.
- Sighting B_peak: `lat 33.2742, lon -112.2763, height 1375, panDeg -125.2, tiltDeg -27.3` → ENU `az 226.1561°, el 3.3475°`.
- 7-position gravity sweep `(pan, tilt, ax, ay, az)`:
  `(-102,0, -0.1061,0.5724,0.9454) (-102,25, -0.1135,0.8702,0.6172) (-102,-25, -0.0862,0.1615,1.1132) (-65,10, -0.0976,0.7375,0.8062) (-140,10, -0.0965,0.6774,0.8599) (-65,-15, -0.0839,0.3775,1.0546) (-140,25, -0.1007,0.8497,0.6503)`

**Golden results (winning convention `geoPanSign=-1`):**
- `R_s = [[0.986919,0.106064,0.121417],[0.028234,-0.855185,0.517554],[0.158728,-0.507355,-0.846992]]`, det `+1`, per-sample rms `1.50°`.
- `d_base = [-0.014936,-0.073272,-0.9972]`, tripod tilt `4.29°`.
- `c_head = [-0.520849,0.735122,0.433949]`, heading residual `0.404°`, landmark reproduction `0.20°`.
- `R = [[-0.674129,0.737297,-0.044077],[-0.738462,-0.671583,0.060407],[0.014936,0.073272,0.9972]]`.
- Inverse checks: A_towers → pan `-26.20`/tilt `-31.01`; B_peak → pan `-125.00`/tilt `-27.32`.
- High-target regression: `az154/el+10` → tilt `-23.78°` (in-range); `az127/el+30` → `+0.21°`; `az90/el+45` → `+21.59°`.

---

## File Structure

- **Create `src/geo/wahba.ts`** — `wahbaRotation(src, dst)`: optimal rotation aligning two vector sets, via Higham polar decomposition (no SVD dependency). Plus `det3`, `inv3` moved/added here or in `vec3.ts`.
- **Modify `src/geo/vec3.ts`** — add `rotX`, `rotZ` (3×3 basic rotations), `det3`, `inv3`.
- **Modify `src/geo/boresight.ts`** — add `mountHeadRotation(panDeg, tiltDeg): Mat3` (= `Rz(-pan)·Rx(tilt)`), the full head rotation matrix `panTiltToMount` is the `+Y` column of.
- **Create `src/geo/imu-orientation.ts`** — the IMU-aided solve + offset-aware pointing: `solveImuMounting`, `solveCalibrationWithGravity`, `boresightToEnu`, `enuToPanTiltOffset`.
- **Create `src/geo/gravity.ts`** — `gravityFromBurst(burst): Vec3` (normalize the mean accel) — pure, testable without a device.
- **Modify `src/device.ts`** — `getGravity(n): Promise<Vec3>` (fetch `/api/imu?n`, sanitize, `gravityFromBurst`).
- **Modify `src/calibration.ts`** — persist `imuMounting` (`rS`, `dBase`) and `cHead`; getters.
- **Create `src/imu-tools.ts`** — `characterize_imu` MCP tool.
- **Modify `src/config.ts`** — add `geoPanSign` (default `+1`, env `TB3_GEO_PAN_SIGN`).
- **Modify `src/geo-tools.ts`** — `solve_calibration` gravity path; `point_at`/`point_at_azel` use the offset-aware inverse.
- **Modify `src/track/session.ts`, `src/track/control.ts`, `src/track/sunguard.ts`, `src/track/supervisor.ts`, `src/adsb/enrich.ts`** — route ENU↔pan/tilt through the offset-aware model (no-op at defaults).
- **Create `test/fixtures/imu-calib-field.json`** — the field data above, shared by the math tests.

Order: Tasks 1→2 (primitives) → 3→5 (pure math) → 6→7 (I/O + persistence) → 8→9 (tools) → 10 (propagation). Each task is independently testable.

---

### Task 1: Wahba rotation solver

**Files:**
- Create: `tb3-mcp/src/geo/wahba.ts`
- Modify: `tb3-mcp/src/geo/vec3.ts` (add `det3`, `inv3`)
- Test: `tb3-mcp/test/wahba.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `matMul`, `transpose`, `matVec` from `./vec3.js`.
- Produces: `wahbaRotation(src: Vec3[], dst: Vec3[], weights?: number[]): Mat3` — the proper rotation `R` minimizing `Σ wᵢ|R·srcᵢ − dstᵢ|²`. Also `det3(m: Mat3): number`, `inv3(m: Mat3): Mat3` (exported from `vec3.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/wahba.test.ts
import { describe, it, expect } from "vitest";
import { wahbaRotation } from "../src/geo/wahba.js";
import { rotX, rotZ, matMul, matVec, det3, normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

describe("wahbaRotation", () => {
  it("recovers a known rotation from clean vector pairs", () => {
    const R = matMul(rotZ(0.6), rotX(-0.4)); // arbitrary known rotation
    const src: Vec3[] = [normalize([1, 0.2, -0.3]), normalize([0.1, 1, 0.4]), normalize([-0.2, 0.3, 1])];
    const dst = src.map((v) => matVec(R, v));
    const est = wahbaRotation(src, dst);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(est[i][j]).toBeCloseTo(R[i][j], 6);
    expect(det3(est)).toBeCloseTo(1, 6);
  });

  it("returns a proper rotation (det +1) even from two pairs", () => {
    const R = rotX(0.5);
    const src: Vec3[] = [normalize([0.3, 1, 0.1]), normalize([1, -0.2, 0.5])];
    const dst = src.map((v) => matVec(R, v));
    expect(det3(wahbaRotation(src, dst))).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/wahba.test.ts`
Expected: FAIL — `wahbaRotation`/`rotX`/`rotZ`/`det3` not exported.

- [ ] **Step 3: Add matrix primitives to `vec3.ts`**

Append to `tb3-mcp/src/geo/vec3.ts`:

```typescript
export function rotX(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
export function inv3(m: Mat3): Mat3 {
  const d = det3(m);
  if (Math.abs(d) < 1e-15) throw new Error("inv3: singular matrix");
  const c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1];
  const c01 = m[1][2] * m[2][0] - m[1][0] * m[2][2];
  const c02 = m[1][0] * m[2][1] - m[1][1] * m[2][0];
  const c10 = m[0][2] * m[2][1] - m[0][1] * m[2][2];
  const c11 = m[0][0] * m[2][2] - m[0][2] * m[2][0];
  const c12 = m[0][1] * m[2][0] - m[0][0] * m[2][1];
  const c20 = m[0][1] * m[1][2] - m[0][2] * m[1][1];
  const c21 = m[0][2] * m[1][0] - m[0][0] * m[1][2];
  const c22 = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  // inverse = adjugate / det ; adjugate = transpose of cofactor matrix
  return [
    [c00 / d, c10 / d, c20 / d],
    [c01 / d, c11 / d, c21 / d],
    [c02 / d, c12 / d, c22 / d],
  ];
}
```

- [ ] **Step 4: Implement `wahba.ts` (Higham polar decomposition)**

```typescript
// tb3-mcp/src/geo/wahba.ts
import { Vec3, Mat3, matMul, transpose, inv3, det3, scale as scaleM } from "./vec3.js";

// Optimal proper rotation R minimizing Σ wᵢ|R·srcᵢ − dstᵢ|² (Wahba's problem).
// R is the orthogonal polar factor of M = Σ wᵢ·dstᵢ·srcᵢᵀ, computed by Higham's
// iteration Xₖ₊₁ = ½(Xₖ + Xₖ⁻ᵀ). For near-aligned data det(M)>0 so the polar
// factor is already a proper rotation; we assert det>0 to catch degenerate input.
export function wahbaRotation(src: Vec3[], dst: Vec3[], weights?: number[]): Mat3 {
  if (src.length !== dst.length || src.length === 0) {
    throw new Error("wahbaRotation: src/dst must be equal-length and non-empty");
  }
  let M: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < src.length; k++) {
    const w = weights ? weights[k] : 1;
    const d = dst[k], s = src[k];
    M = [
      [M[0][0] + w * d[0] * s[0], M[0][1] + w * d[0] * s[1], M[0][2] + w * d[0] * s[2]],
      [M[1][0] + w * d[1] * s[0], M[1][1] + w * d[1] * s[1], M[1][2] + w * d[1] * s[2]],
      [M[2][0] + w * d[2] * s[0], M[2][1] + w * d[2] * s[1], M[2][2] + w * d[2] * s[2]],
    ];
  }
  let X = M;
  for (let it = 0; it < 100; it++) {
    const Xit = transpose(inv3(X)); // X⁻ᵀ
    const next: Mat3 = [
      [0.5 * (X[0][0] + Xit[0][0]), 0.5 * (X[0][1] + Xit[0][1]), 0.5 * (X[0][2] + Xit[0][2])],
      [0.5 * (X[1][0] + Xit[1][0]), 0.5 * (X[1][1] + Xit[1][1]), 0.5 * (X[1][2] + Xit[1][2])],
      [0.5 * (X[2][0] + Xit[2][0]), 0.5 * (X[2][1] + Xit[2][1]), 0.5 * (X[2][2] + Xit[2][2])],
    ];
    let diff = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) diff += Math.abs(next[i][j] - X[i][j]);
    X = next;
    if (diff < 1e-14) break;
  }
  if (det3(X) < 0) throw new Error("wahbaRotation: degenerate input (reflection, det < 0)");
  return X;
}
```

Note: remove the unused `scaleM` import if tsc complains — it is only listed to signal `vec3` is the source; keep the import list to what compiles.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/wahba.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/wahba.ts tb3-mcp/src/geo/vec3.ts tb3-mcp/test/wahba.test.ts && git commit -m "feat(geo): Wahba rotation solver (Higham polar) + 3x3 det/inv"
```

---

### Task 2: Mount head-rotation matrix

**Files:**
- Modify: `tb3-mcp/src/geo/boresight.ts`
- Test: `tb3-mcp/test/mount-head-rotation.test.ts`

**Interfaces:**
- Consumes: `rotX`, `rotZ`, `matMul`, `matVec` from `./vec3.js`; `panTiltToMount` (existing).
- Produces: `mountHeadRotation(panDeg: number, tiltDeg: number): Mat3` — the full head-in-mount rotation `Rz(-pan)·Rx(tilt)`, whose `+Y` column equals `panTiltToMount(pan,tilt)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/mount-head-rotation.test.ts
import { describe, it, expect } from "vitest";
import { mountHeadRotation, panTiltToMount } from "../src/geo/boresight.js";
import { matVec } from "../src/geo/vec3.js";

describe("mountHeadRotation", () => {
  it("its +Y column equals panTiltToMount (convention matches boresight.ts / validate.py)", () => {
    for (const [p, t] of [[-26, -31], [12, 40], [-125.2, -27.3]] as const) {
      const col = matVec(mountHeadRotation(p, t), [0, 1, 0]);
      const pt = panTiltToMount(p, t);
      expect(col[0]).toBeCloseTo(pt[0], 12);
      expect(col[1]).toBeCloseTo(pt[1], 12);
      expect(col[2]).toBeCloseTo(pt[2], 12);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/mount-head-rotation.test.ts`
Expected: FAIL — `mountHeadRotation` not exported.

- [ ] **Step 3: Implement**

Append to `tb3-mcp/src/geo/boresight.ts`:

```typescript
import { Mat3, matMul, rotX, rotZ, deg2rad as _deg2rad } from "./vec3.js";

// Full head-in-mount rotation: pan about mount-up (+Z), tilt about mount-X.
// M(pan,tilt) = Rz(-pan)·Rx(tilt).  M·[0,1,0] == panTiltToMount(pan,tilt).
export function mountHeadRotation(panDeg: number, tiltDeg: number): Mat3 {
  return matMul(rotZ(_deg2rad(-panDeg)), rotX(_deg2rad(tiltDeg)));
}
```

(`deg2rad` is already imported in `boresight.ts`; reuse it rather than the aliased import if present — keep imports compiling.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/mount-head-rotation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/boresight.ts tb3-mcp/test/mount-head-rotation.test.ts && git commit -m "feat(geo): mountHeadRotation matrix (Rz(-pan)Rx(tilt))"
```

---

### Task 3: Solve IMU mounting `R_s` from the sweep

**Files:**
- Create: `tb3-mcp/src/geo/imu-orientation.ts`
- Create: `tb3-mcp/test/fixtures/imu-calib-field.json`
- Test: `tb3-mcp/test/imu-mounting.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `matVec`, `transpose`, `normalize`, `dot`, `rad2deg` from `./vec3.js`; `mountHeadRotation` from `./boresight.js`; `wahbaRotation` from `./wahba.js`.
- Produces:
  ```typescript
  export interface GravitySample { panDeg: number; tiltDeg: number; gravity: Vec3; } // gravity = normalized sensor-frame accel
  export interface ImuMounting { rS: Mat3; dBase: Vec3; residualsDeg: number[]; rmsDeg: number; }
  export function solveImuMounting(samples: GravitySample[], geoPanSign: number): ImuMounting;
  ```

- [ ] **Step 1: Create the field fixture**

Create `tb3-mcp/test/fixtures/imu-calib-field.json`:

```json
{
  "rig": { "lat": 33.38317744521082, "lon": -112.14130929961672, "height": 331 },
  "sightings": [
    { "label": "A_towers", "lat": 33.3335, "lon": -112.0632, "height": 931, "panDeg": -26.0, "tiltDeg": -31.0 },
    { "label": "B_peak", "lat": 33.2742, "lon": -112.2763, "height": 1375, "panDeg": -125.2, "tiltDeg": -27.3 }
  ],
  "sweep": [
    { "pan": -102, "tilt": 0,   "ax": -0.1061, "ay": 0.5724, "az": 0.9454 },
    { "pan": -102, "tilt": 25,  "ax": -0.1135, "ay": 0.8702, "az": 0.6172 },
    { "pan": -102, "tilt": -25, "ax": -0.0862, "ay": 0.1615, "az": 1.1132 },
    { "pan": -65,  "tilt": 10,  "ax": -0.0976, "ay": 0.7375, "az": 0.8062 },
    { "pan": -140, "tilt": 10,  "ax": -0.0965, "ay": 0.6774, "az": 0.8599 },
    { "pan": -65,  "tilt": -15, "ax": -0.0839, "ay": 0.3775, "az": 1.0546 },
    { "pan": -140, "tilt": 25,  "ax": -0.1007, "ay": 0.8497, "az": 0.6503 }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tb3-mcp/test/imu-mounting.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, GravitySample } from "../src/geo/imu-orientation.js";
import { normalize, rad2deg, dot } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

describe("solveImuMounting (winning convention geoPanSign=-1)", () => {
  const samples: GravitySample[] = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
    panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
  }));

  it("recovers R_s matching the numpy golden matrix", () => {
    const { rS } = solveImuMounting(samples, -1);
    const gold = [[0.986919, 0.106064, 0.121417], [0.028234, -0.855185, 0.517554], [0.158728, -0.507355, -0.846992]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(rS[i][j]).toBeCloseTo(gold[i][j], 2);
  });

  it("reads the tripod as ~4.3° from vertical, NOT 144°", () => {
    const { dBase, rmsDeg } = solveImuMounting(samples, -1);
    // d_base points down; tripod tilt = angle between -d_base and world up [0,0,1].
    const tilt = rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(normalize([-dBase[0], -dBase[1], -dBase[2]]), [0, 0, 1])))));
    expect(tilt).toBeCloseTo(4.29, 1);
    expect(rmsDeg).toBeLessThan(1.7);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-mounting.test.ts`
Expected: FAIL — module `imu-orientation.js` does not exist.

- [ ] **Step 4: Implement `solveImuMounting`**

Create `tb3-mcp/src/geo/imu-orientation.ts`:

```typescript
import { Vec3, Mat3, matVec, transpose, normalize, dot, rad2deg } from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { wahbaRotation } from "./wahba.js";

export interface GravitySample { panDeg: number; tiltDeg: number; gravity: Vec3; }
export interface ImuMounting { rS: Mat3; dBase: Vec3; residualsDeg: number[]; rmsDeg: number; }

// The model: M(gp·pan, tilt)·R_s·g_s = d_base  (constant across all samples),
// where g_s is the normalized sensor-frame gravity. Alternate:
//   given d_base, target wᵢ = normalize(Mᵢᵀ·d_base); R_s = wahba(g_s → w);
//   update d_base = normalize(mean_i Mᵢ·R_s·g_sᵢ). Iterate to a fixpoint.
function angleDeg(a: Vec3, b: Vec3): number {
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))));
}

export function solveImuMounting(samples: GravitySample[], geoPanSign: number): ImuMounting {
  if (samples.length < 4) throw new Error("solveImuMounting: need ≥4 samples spanning pan and tilt");
  const Ms = samples.map((s) => mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg));
  const gs = samples.map((s) => normalize(s.gravity));

  const fitRs = (dBase: Vec3): Mat3 => {
    const w = Ms.map((M) => normalize(matVec(transpose(M), dBase)));
    return wahbaRotation(gs, w);
  };

  let dBase: Vec3 = [0, 0, -1];
  let rS = fitRs(dBase);
  for (let it = 0; it < 500; it++) {
    rS = fitRs(dBase);
    const acc: number[] = [0, 0, 0];
    for (let i = 0; i < samples.length; i++) {
      const v = matVec(Ms[i], matVec(rS, gs[i]));
      acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2];
    }
    const nv = normalize([acc[0], acc[1], acc[2]]);
    const moved = angleDeg(nv, dBase);
    dBase = nv;
    if (moved < 1e-9) break;
  }
  rS = fitRs(dBase);
  const residualsDeg = samples.map((_, i) => angleDeg(matVec(rS, gs[i]), normalize(matVec(transpose(Ms[i]), dBase))));
  const rmsDeg = Math.sqrt(residualsDeg.reduce((a, b) => a + b * b, 0) / residualsDeg.length);
  return { rS, dBase, residualsDeg, rmsDeg };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-mounting.test.ts`
Expected: PASS. If `R_s` signs are transposed/mirrored, re-check the `wahba(gs → w)` direction (it maps sensor→target) and that `M` uses `geoPanSign*pan`.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/imu-orientation.ts tb3-mcp/test/fixtures/imu-calib-field.json tb3-mcp/test/imu-mounting.test.ts && git commit -m "feat(geo): solveImuMounting — R_s + tripod attitude from gravity sweep"
```

---

### Task 4: Gravity-anchored calibration solve (`R` + `c_head`)

**Files:**
- Modify: `tb3-mcp/src/geo/imu-orientation.ts`
- Test: `tb3-mcp/test/imu-calibration-solve.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `matVec`, `matMul`, `cross`, `dot`, `normalize`, `rotZ`, `deg2rad`, `rad2deg` from `./vec3.js`; `mountHeadRotation`; the WGS84 helpers `enuDirection`, `azElRange` from `./wgs84.js` (tests build ENU/el from the fixture).
- Produces:
  ```typescript
  export interface GravitySighting { panDeg: number; tiltDeg: number; enuUnit: Vec3; elevationDeg: number; }
  export interface GravityCalibration { R: Mat3; cHead: Vec3; headingResidualDeg: number; }
  export function solveCalibrationWithGravity(dBase: Vec3, sightings: [GravitySighting, GravitySighting], geoPanSign: number): GravityCalibration;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/imu-calibration-solve.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, solveCalibrationWithGravity, boresightToEnu, GravitySample, GravitySighting } from "../src/geo/imu-orientation.js";
import { enuDirection, azElRange } from "../src/geo/wgs84.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
const rig = field.rig;

function sighting(idx: number): GravitySighting {
  const s = field.sightings[idx];
  const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
  const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
}

describe("solveCalibrationWithGravity", () => {
  const samples: GravitySample[] = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
    panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
  }));
  const { dBase } = solveImuMounting(samples, -1);
  const A = sighting(0), B = sighting(1);

  it("recovers c_head and heading matching the numpy golden result", () => {
    const { cHead, headingResidualDeg } = solveCalibrationWithGravity(dBase, [A, B], -1);
    expect(cHead[0]).toBeCloseTo(-0.520849, 2);
    expect(cHead[1]).toBeCloseTo(0.735122, 2);
    expect(cHead[2]).toBeCloseTo(0.433949, 2);
    expect(cHead[1]).toBeGreaterThan(0); // disambiguation: camera looks forward
    expect(headingResidualDeg).toBeLessThan(1.0);
  });

  it("reproduces both landmarks to < 0.5°", () => {
    const { R, cHead } = solveCalibrationWithGravity(dBase, [A, B], -1);
    for (const s of [A, B]) {
      const bw = boresightToEnu(R, cHead, -1, s.panDeg, s.tiltDeg);
      const cos = (bw[0] * s.enuUnit[0] + bw[1] * s.enuUnit[1] + bw[2] * s.enuUnit[2]) /
        Math.hypot(bw[0], bw[1], bw[2]);
      expect(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toBeLessThan(0.5);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-calibration-solve.test.ts`
Expected: FAIL — `solveCalibrationWithGravity`/`boresightToEnu` not exported.

- [ ] **Step 3: Implement `solveCalibrationWithGravity`**

Append to `tb3-mcp/src/geo/imu-orientation.ts` (imports: add `matMul`, `cross`, `rotZ`, `deg2rad` to the existing `./vec3.js` import; `boresightToEnu` is added in Task 5 but is imported by this test — define a minimal forward here if Task 5 not yet present, then Task 5 supersedes. To avoid duplication, implement `boresightToEnu` now as part of this task and Task 5 only adds the inverse):

```typescript
import { matMul, cross, rotZ, deg2rad } from "./vec3.js"; // extend the existing import line instead of re-importing

export interface GravitySighting { panDeg: number; tiltDeg: number; enuUnit: Vec3; elevationDeg: number; }
export interface GravityCalibration { R: Mat3; cHead: Vec3; headingResidualDeg: number; }

// Rotation aligning unit a → unit b (Rodrigues); used to build R0 from gravity.
function rotAlign(a: Vec3, b: Vec3): Mat3 {
  const an = normalize(a), bn = normalize(b);
  const v = cross(an, bn);
  const c = dot(an, bn);
  const s = Math.hypot(v[0], v[1], v[2]);
  if (s < 1e-12) {
    if (c > 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // 180°: rotate about any axis ⟂ a.
    const axis = Math.abs(an[0]) < 0.9 ? cross(an, [1, 0, 0]) : cross(an, [0, 1, 0]);
    const u = normalize(axis);
    return [
      [2 * u[0] * u[0] - 1, 2 * u[0] * u[1], 2 * u[0] * u[2]],
      [2 * u[1] * u[0], 2 * u[1] * u[1] - 1, 2 * u[1] * u[2]],
      [2 * u[2] * u[0], 2 * u[2] * u[1], 2 * u[2] * u[2] - 1],
    ];
  }
  const vx: Mat3 = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
  const k = (1 - c) / (s * s);
  const vx2 = matMul(vx, vx);
  return [
    [1 + vx[0][0] + k * vx2[0][0], vx[0][1] + k * vx2[0][1], vx[0][2] + k * vx2[0][2]],
    [vx[1][0] + k * vx2[1][0], 1 + vx[1][1] + k * vx2[1][1], vx[1][2] + k * vx2[1][2]],
    [vx[2][0] + k * vx2[2][0], vx[2][1] + k * vx2[2][1], 1 + vx[2][2] + k * vx2[2][2]],
  ];
}

// Forward boresight in ENU for a user-frame pan/tilt (offset-aware).
export function boresightToEnu(R: Mat3, cHead: Vec3, geoPanSign: number, panDeg: number, tiltDeg: number): Vec3 {
  return matVec(matMul(R, mountHeadRotation(geoPanSign * panDeg, tiltDeg)), cHead);
}

export function solveCalibrationWithGravity(
  dBase: Vec3, sightings: [GravitySighting, GravitySighting], geoPanSign: number,
): GravityCalibration {
  const R0 = rotAlign([-dBase[0], -dBase[1], -dBase[2]], [0, 0, 1]); // R = Rz(heading)·R0
  const rows: Vec3[] = [];
  const sel: number[] = [];
  for (const s of sightings) {
    const M = mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg);
    const R0M = matMul(R0, M);
    rows.push([R0M[2][0], R0M[2][1], R0M[2][2]]); // z-row: (R0·M·c)_z is linear in c
    sel.push(Math.sin(deg2rad(s.elevationDeg)));
  }
  // Minimum-norm solution c0 of N·c = sel (N is 2×3): c0 = Nᵀ(N Nᵀ)⁻¹ sel.
  const N = rows;
  const nnt: [[number, number], [number, number]] = [
    [dot(N[0], N[0]), dot(N[0], N[1])],
    [dot(N[1], N[0]), dot(N[1], N[1])],
  ];
  const det = nnt[0][0] * nnt[1][1] - nnt[0][1] * nnt[1][0];
  const inv: [[number, number], [number, number]] = [
    [nnt[1][1] / det, -nnt[0][1] / det],
    [-nnt[1][0] / det, nnt[0][0] / det],
  ];
  const y = [inv[0][0] * sel[0] + inv[0][1] * sel[1], inv[1][0] * sel[0] + inv[1][1] * sel[1]];
  const c0: Vec3 = [
    N[0][0] * y[0] + N[1][0] * y[1],
    N[0][1] * y[0] + N[1][1] * y[1],
    N[0][2] * y[0] + N[1][2] * y[1],
  ];
  const nz = normalize(cross(N[0], N[1])); // null direction: c = c0 + t·nz on the unit sphere
  const disc = 1 - dot(c0, c0);
  if (disc < 0) throw new Error("solveCalibrationWithGravity: no real c_head (|c0|>1) — degenerate sightings");
  const roots = [Math.sqrt(disc), -Math.sqrt(disc)];
  const candidates = roots.map((t) => {
    const c: Vec3 = [c0[0] + t * nz[0], c0[1] + t * nz[1], c0[2] + t * nz[2]];
    // per-landmark heading = az(enu) − az(R0·M·c); average, and measure disagreement.
    const hs = sightings.map((s) => {
      const p = matVec(matMul(R0, mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg)), c);
      const azp = rad2deg(Math.atan2(p[0], p[1]));
      const azw = rad2deg(Math.atan2(s.enuUnit[0], s.enuUnit[1]));
      return ((azp - azw) % 360 + 360) % 360;
    });
    const dh = Math.abs(((hs[0] - hs[1] + 180) % 360 + 360) % 360 - 180);
    const hz = ((rad2deg(Math.atan2(
      hs.reduce((a, h) => a + Math.sin(deg2rad(h)), 0),
      hs.reduce((a, h) => a + Math.cos(deg2rad(h)), 0),
    )) % 360) + 360) % 360;
    const R = matMul(rotZ(deg2rad(hz)), R0);
    return { c, R, dh };
  });
  // Disambiguate: prefer the physical branch (camera forward: c·+Y > 0), then best heading agreement.
  const physical = candidates.filter((k) => k.c[1] > 0);
  const pool = physical.length ? physical : candidates;
  const best = pool.reduce((a, b) => (b.dh < a.dh ? b : a));
  return { R: best.R, cHead: best.c, headingResidualDeg: best.dh };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-calibration-solve.test.ts`
Expected: PASS (2 tests). Cross-check the printed golden in `python3 scripts/imu-calib-validate.py` if `c_head` differs.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/imu-orientation.ts tb3-mcp/test/imu-calibration-solve.test.ts && git commit -m "feat(geo): solveCalibrationWithGravity — gravity-anchored R + camera offset c_head"
```

---

### Task 5: Offset-aware inverse (`enuToPanTiltOffset`)

**Files:**
- Modify: `tb3-mcp/src/geo/imu-orientation.ts`
- Test: `tb3-mcp/test/enu-to-pantilt-offset.test.ts`

**Interfaces:**
- Consumes: everything in `imu-orientation.ts`; `enuToPanTilt` from `./orientation.js` and `panTiltToMount` for the backward-compat assertion.
- Produces:
  ```typescript
  export interface InversePosture { panDeg: number; tiltDeg: number; inRange: boolean; errDeg: number; }
  export function enuToPanTiltOffsetAll(R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: { panMin: number; panMax: number; tiltMin: number; tiltMax: number }): InversePosture[];
  export function enuToPanTiltOffset(R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: {...}, preferTiltDeg?: number): { panDeg: number; tiltDeg: number; inRange: boolean };
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/enu-to-pantilt-offset.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, solveCalibrationWithGravity, enuToPanTiltOffset, GravitySample, GravitySighting } from "../src/geo/imu-orientation.js";
import { enuToPanTilt } from "../src/geo/orientation.js";
import { enuDirection, azElRange } from "../src/geo/wgs84.js";
import { normalize, deg2rad } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
const rig = field.rig;
const LIM = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };
const unitFromAzEl = (az: number, el: number): Vec3 => [Math.sin(deg2rad(az)) * Math.cos(deg2rad(el)), Math.cos(deg2rad(az)) * Math.cos(deg2rad(el)), Math.sin(deg2rad(el))];
function sighting(idx: number): GravitySighting {
  const s = field.sightings[idx];
  const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
  const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
}

describe("enuToPanTiltOffset", () => {
  const samples: GravitySample[] = field.sweep.map((s: any) => ({ panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3) }));
  const { dBase } = solveImuMounting(samples, -1);
  const { R, cHead } = solveCalibrationWithGravity(dBase, [sighting(0), sighting(1)], -1);

  it("regression: a high target maps to a sane UPWARD tilt, not into the ground", () => {
    const r = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(154, 10), LIM);
    expect(r.inRange).toBe(true);
    expect(r.tiltDeg).toBeCloseTo(-23.78, 0); // was -63 (broken TRIAD) / -87 (level assumption)
    expect(r.tiltDeg).toBeGreaterThan(-50);
    const hi = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(90, 45), LIM);
    expect(hi.tiltDeg).toBeGreaterThan(15); // el+45 must tilt well up
  });

  it("recovers each sighting's own posture from its landmark direction", () => {
    const a = enuToPanTiltOffset(R, cHead, -1, sighting(0).enuUnit, LIM, -31);
    expect(a.panDeg).toBeCloseTo(-26.2, 0);
    expect(a.tiltDeg).toBeCloseTo(-31.0, 0);
  });

  it("is backward-compatible: cHead=[0,1,0], geoPanSign=+1 equals the legacy enuToPanTilt", () => {
    const Rid: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const u = normalize([0.3, 0.8, 0.5] as Vec3);
    const legacy = enuToPanTilt(Rid, u);
    const off = enuToPanTiltOffset(Rid, [0, 1, 0], 1, u, LIM);
    expect(off.panDeg).toBeCloseTo(legacy.panDeg, 6);
    expect(off.tiltDeg).toBeCloseTo(legacy.tiltDeg, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/enu-to-pantilt-offset.test.ts`
Expected: FAIL — `enuToPanTiltOffset` not exported.

- [ ] **Step 3: Implement the inverse**

Append to `tb3-mcp/src/geo/imu-orientation.ts` (add `rotX`, `transpose` to the `./vec3.js` import if not present):

```typescript
export interface InversePosture { panDeg: number; tiltDeg: number; inRange: boolean; errDeg: number; }
interface Limits { panMin: number; panMax: number; tiltMin: number; tiltMax: number; }

// All (pan,tilt) postures whose offset boresight hits enuUnit (both tilt roots).
// Inverts R·M(gp·pan,tilt)·cHead = w. With m = Rᵀ·w and cHead=(cx,cy,cz):
//   Rx(T)·cHead has z = |(cy,cz)|·sin(T+φ) ⇒ two T roots; then the pan rotation
//   Rz(-gp·pan) aligns the xy parts.
export function enuToPanTiltOffsetAll(R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: Limits): InversePosture[] {
  const w = normalize(enuUnit);
  const m = matVec(transpose(R), w);
  const cy = cHead[1], cz = cHead[2];
  const Rmag = Math.hypot(cy, cz);
  const phi = Math.atan2(cz, cy);
  const val = Math.max(-1, Math.min(1, m[2] / Rmag));
  const out: InversePosture[] = [];
  for (const base of [Math.asin(val), Math.PI - Math.asin(val)]) {
    const T = ((base - phi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // geo tilt (rad)
    const u = matVec(rotX(T), cHead);
    const P = Math.atan2(m[0], m[1]) - Math.atan2(u[0], u[1]); // geo pan (rad, mount frame)
    const panDeg = (((rad2deg(P) * geoPanSign + 180) % 360) + 360) % 360 - 180;
    const tiltDeg = rad2deg(T);
    const bw = boresightToEnu(R, cHead, geoPanSign, panDeg, tiltDeg);
    const bwn = normalize(bw);
    const errDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(bwn, w)))));
    const inRange = tiltDeg >= limits.tiltMin && tiltDeg <= limits.tiltMax && panDeg >= limits.panMin && panDeg <= limits.panMax;
    out.push({ panDeg, tiltDeg, inRange, errDeg });
  }
  return out;
}

export function enuToPanTiltOffset(
  R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: Limits, preferTiltDeg?: number,
): { panDeg: number; tiltDeg: number; inRange: boolean } {
  const sols = enuToPanTiltOffsetAll(R, cHead, geoPanSign, enuUnit, limits);
  const ranged = sols.filter((s) => s.inRange);
  const pool = ranged.length ? ranged : sols;
  const sorted = preferTiltDeg !== undefined && ranged.length
    ? [...pool].sort((a, b) => Math.abs(a.tiltDeg - preferTiltDeg) - Math.abs(b.tiltDeg - preferTiltDeg))
    : [...pool].sort((a, b) => a.errDeg - b.errDeg || Math.abs(a.tiltDeg) - Math.abs(b.tiltDeg));
  const s = sorted[0];
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, inRange: s.inRange };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/enu-to-pantilt-offset.test.ts`
Expected: PASS (3 tests). The `az154/el10 → -23.78` and backward-compat cases are the load-bearing ones.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/imu-orientation.ts tb3-mcp/test/enu-to-pantilt-offset.test.ts && git commit -m "feat(geo): enuToPanTiltOffset — offset-aware inverse (both tilt roots, in-range preference)"
```

---

### Task 6: Gravity from an `/api/imu` burst + device fetch

**Files:**
- Create: `tb3-mcp/src/geo/gravity.ts`
- Modify: `tb3-mcp/src/device.ts`
- Test: `tb3-mcp/test/gravity.test.ts`

**Interfaces:**
- Consumes: `ImuBurst`, `computeImuStats` from `../imu-stats.js`; `Vec3`, `normalize` from `./vec3.js`; `sanitizeTickJson` from `../device.js`.
- Produces: `gravityFromBurst(burst: ImuBurst): Vec3` (normalized mean accel); `Device.getGravity(n = 100): Promise<Vec3>`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/gravity.test.ts
import { describe, it, expect } from "vitest";
import { gravityFromBurst } from "../src/geo/gravity.js";
import { sanitizeTickJson } from "../src/device.js";
import type { ImuBurst } from "../src/imu-stats.js";

describe("gravityFromBurst", () => {
  it("returns the normalized mean accel direction", () => {
    const burst: ImuBurst = {
      info: { present: true, mpu_who: "0x68", mag_who: "0x00", bmp_id: "0x00", accel_fs_g: 4, gyro_fs_dps: 500 },
      n: 2, span_us: 200000, read_errors: 0,
      samples: [
        [0, 0.10, 0.60, 0.90, 0, 0, 0, null, null, null, null, null],
        [1000, 0.12, 0.62, 0.92, 0, 0, 0, null, null, null, null, null],
      ],
    };
    const g = gravityFromBurst(burst);
    expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
    // direction of mean [0.11, 0.61, 0.91]
    const n = Math.hypot(0.11, 0.61, 0.91);
    expect(g[0]).toBeCloseTo(0.11 / n, 6);
    expect(g[2]).toBeCloseTo(0.91 / n, 6);
  });

  it("survives bare-nan baro columns after sanitize (the field JSON shape)", () => {
    const raw = '{"info":{"present":true,"mpu_who":"0x68","mag_who":"0x00","bmp_id":"0x00","accel_fs_g":4,"gyro_fs_dps":500},"n":1,"span_us":1000,"read_errors":0,"samples":[[0,0.1,0.6,0.9,0,0,0,null,null,null,nan,nan]]}';
    const burst = JSON.parse(sanitizeTickJson(raw.replace(/nan/gi, "null"))) as ImuBurst;
    const g = gravityFromBurst(burst);
    expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/gravity.test.ts`
Expected: FAIL — `gravityFromBurst` not found.

- [ ] **Step 3: Implement `gravity.ts`**

```typescript
// tb3-mcp/src/geo/gravity.ts
import { Vec3, normalize } from "./vec3.js";
import { ImuBurst, computeImuStats } from "../imu-stats.js";

// Normalized gravity direction in the SENSOR frame from a burst's mean accel.
// Magnitude is irrelevant (the accel is uncalibrated ~16% high); only direction
// matters for gravity-anchoring, so we normalize.
export function gravityFromBurst(burst: ImuBurst): Vec3 {
  const s = computeImuStats(burst);
  const g: Vec3 = [s.accel.x.mean, s.accel.y.mean, s.accel.z.mean];
  if (!Number.isFinite(g[0]) || !Number.isFinite(g[1]) || !Number.isFinite(g[2])) {
    throw new Error("gravityFromBurst: non-finite mean accel (empty or bad burst)");
  }
  return normalize(g);
}
```

- [ ] **Step 4: Add `getGravity` to `device.ts`**

Add a method to the `Device` class (near the other `/api/*` calls, after `post`). It reuses the burst-fetch retry pattern from `scripts/imu-probe.mjs` but simpler (one attempt with a generous timeout; the caller in `characterize_imu` handles retries per position):

```typescript
import { gravityFromBurst } from "./geo/gravity.js";
import { Vec3 } from "./geo/vec3.js";
import { ImuBurst } from "./imu-stats.js";

// (inside class Device)
async getGravity(n = 100): Promise<Vec3> {
  const res = await fetch(`${this.httpBase()}/api/imu?n=${n}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GET /api/imu failed: HTTP ${res.status}`);
  // /api/imu sample ARRAYS carry bare `nan` for the absent baro columns — invalid
  // JSON. Sanitize both the object form (:nan) and the array form (,nan,) first.
  const raw = await res.text();
  const burst = JSON.parse(sanitizeTickJson(raw).replace(/\bnan\b/gi, "null")) as ImuBurst;
  if (!burst.info?.present) throw new Error("IMU not present");
  return gravityFromBurst(burst);
}
```

- [ ] **Step 5: Run the test + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/gravity.test.ts && npm test`
Expected: gravity tests PASS; full suite still green.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo/gravity.ts tb3-mcp/src/device.ts tb3-mcp/test/gravity.test.ts && git commit -m "feat(device): getGravity — normalized gravity from /api/imu burst"
```

---

### Task 7: Persist `R_s` + `d_base` + `c_head`

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts` (extend; if absent, create)

**Interfaces:**
- Consumes: `Mat3`, `Vec3` from `./geo/vec3.js`.
- Produces (on `CalibrationStore`): `setImuMounting(rS: Mat3, dBase: Vec3): void`, `getImuMounting(): { rS: Mat3; dBase: Vec3 } | undefined`, `setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string): void`, `getCHead(): Vec3 | undefined`. Profile schema gains optional `imuMounting: { rS: number[9]; dBase: number[3] }` and `cHead: number[3]`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/calibration.test.ts  (add these; keep existing tests)
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";

describe("CalibrationStore IMU fields", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");

  it("persists and reloads R_s, d_base, and c_head", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    a.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    a.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");
    const b = new CalibrationStore(f);
    b.load();
    expect(b.getImuMounting()?.dBase).toEqual([0, 0, -1]);
    expect(b.getCHead()).toEqual([-0.52, 0.735, 0.434]);
    expect(b.isCalibrated()).toBe(true);
  });

  it("loads a legacy profile without the new fields (backward compatible)", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    a.setOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], "2026-01-01T00:00:00Z");
    const b = new CalibrationStore(f);
    b.load();
    expect(b.getCHead()).toBeUndefined();
    expect(b.getImuMounting()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/calibration.test.ts`
Expected: FAIL — `setImuMounting`/`getCHead` not defined.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/calibration.ts`: extend `ProfileSchema` and add methods.

```typescript
// add to imports:
import { Mat3, Vec3 } from "./geo/vec3.js";

// extend ProfileSchema (inside z.object({...})):
  imuMounting: z.object({
    rS: z.array(z.number()).length(9),
    dBase: z.array(z.number()).length(3),
  }).optional(),
  cHead: z.array(z.number()).length(3).optional(),

// add methods to CalibrationStore:
  setImuMounting(rS: Mat3, dBase: Vec3): void {
    const flat = [rS[0][0], rS[0][1], rS[0][2], rS[1][0], rS[1][1], rS[1][2], rS[2][0], rS[2][1], rS[2][2]];
    this.profile = { ...this.profile, imuMounting: { rS: flat, dBase: [dBase[0], dBase[1], dBase[2]] } };
    this.save();
  }

  getImuMounting(): { rS: Mat3; dBase: Vec3 } | undefined {
    const m = this.profile.imuMounting;
    if (!m) return undefined;
    const r = m.rS;
    return { rS: [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]], dBase: [m.dBase[0], m.dBase[1], m.dBase[2]] };
  }

  setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, cHead: [cHead[0], cHead[1], cHead[2]], solvedAt: solvedAtIso };
    this.save();
  }

  getCHead(): Vec3 | undefined {
    const c = this.profile.cHead;
    return c ? [c[0], c[1], c[2]] : undefined;
  }
```

Note: `addSighting` already clears `orientation`; also clear `cHead` there (`cHead: undefined`) so a new sighting invalidates the offset. `invalidateCalibration` likewise clears `cHead`. `imuMounting` survives all of these (the IMU stays mounted; `characterize_imu` is what refreshes it).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/calibration.test.ts && npm test`
Expected: PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/calibration.ts tb3-mcp/test/calibration.test.ts && git commit -m "feat(calib): persist R_s + d_base + c_head (backward-compatible schema)"
```

---

### Task 8: `characterize_imu` MCP tool + `geoPanSign` config

**Files:**
- Create: `tb3-mcp/src/imu-tools.ts`
- Modify: `tb3-mcp/src/config.ts`
- Test: `tb3-mcp/test/imu-tools.test.ts`, `tb3-mcp/test/config.test.ts` (extend)
- Register: `tb3-mcp/src/server.ts` (wherever `registerGeoTools` is called — add `registerImuTools`)

**Interfaces:**
- Consumes: `solveImuMounting`, `GravitySample` from `./geo/imu-orientation.js`; `Device.getGravity`, `moveToUserAngle` from `./move.js`; `CalibrationStore.setImuMounting`; `Config.geoPanSign`; `SunSupervisor.isSunLocked`.
- Produces: `registerImuTools(server, device, cfg, store, supervisor)`; a `characterize_imu` tool that sweeps a fixed set of pan/tilt positions, reads gravity at each, solves `R_s`, and persists it. Config gains `geoPanSign` (default `1`, env `TB3_GEO_PAN_SIGN`).

- [ ] **Step 1: Add `geoPanSign` config + failing config test**

In `tb3-mcp/src/config.ts`: add to the schema next to `panSign`:

```typescript
    // Pan handedness INTO the geo mount kinematics (separate from panSign, which
    // is the device↔user boundary sign used by jog/tracking motion). The rig's
    // pan axis is inverted relative to panTiltToMount (az = 101 − pan); the host
    // sets TB3_GEO_PAN_SIGN=-1 (validated). Default +1 keeps legacy geo behavior.
    geoPanSign: sign.default(1),
```

And in the env-override block (next to `set("panSign", ...)`):

```typescript
  set("geoPanSign", num(env.TB3_GEO_PAN_SIGN));
```

Add to `tb3-mcp/test/config.test.ts`:

```typescript
it("geoPanSign defaults to +1 and TB3_GEO_PAN_SIGN overrides it", () => {
  expect(loadConfig(undefined, {}).geoPanSign).toBe(1);
  expect(loadConfig(undefined, { TB3_GEO_PAN_SIGN: "-1" }).geoPanSign).toBe(-1);
});
```

(Match the existing `loadConfig` call signature in `config.test.ts` — adjust the arg shape to how other tests call it.)

- [ ] **Step 2: Run config test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/config.test.ts`
Expected: FAIL — `geoPanSign` unknown.

- [ ] **Step 3: Write the `characterize_imu` failing test**

```typescript
// tb3-mcp/test/imu-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCharacterizeImu, SWEEP_POSITIONS } from "../src/imu-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

describe("characterize_imu core (runCharacterizeImu)", () => {
  it("sweeps, reads gravity, solves R_s, and persists it", async () => {
    // Map each swept position to the field gravity sample so the solve is exercised
    // end-to-end against the golden R_s.
    const byPos = new Map<string, Vec3>();
    for (const s of field.sweep) byPos.set(`${s.pan},${s.tilt}`, normalize([s.ax, s.ay, s.az] as Vec3));
    const positions = field.sweep.map((s: { pan: number; tilt: number }) => ({ panDeg: s.pan, tiltDeg: s.tilt }));

    const move = vi.fn(async (_p: number, _t: number) => {});
    const getGravity = vi.fn(async () => byPos.get(`${cur.pan},${cur.tilt}`)!);
    let cur = { pan: 0, tilt: 0 };
    const moveTo = vi.fn(async (p: number, t: number) => { cur = { pan: p, tilt: t }; });

    const f = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");
    const store = new CalibrationStore(f); store.load();

    const res = await runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store,
    });
    expect(res.rmsDeg).toBeLessThan(1.7);
    const gold = [[0.986919, 0.106064, 0.121417], [0.028234, -0.855185, 0.517554], [0.158728, -0.507355, -0.846992]];
    const rS = store.getImuMounting()!.rS;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(rS[i][j]).toBeCloseTo(gold[i][j], 2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-tools.test.ts`
Expected: FAIL — `runCharacterizeImu` not found.

- [ ] **Step 5: Implement `imu-tools.ts`**

Split the testable core (`runCharacterizeImu`, pure of the MCP server and Device wiring) from the tool registration.

```typescript
// tb3-mcp/src/imu-tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { SunSupervisor } from "./track/supervisor.js";
import { moveToUserAngle } from "./move.js";
import { solveImuMounting, GravitySample } from "./geo/imu-orientation.js";
import { Vec3 } from "./geo/vec3.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

export interface SweepPosition { panDeg: number; tiltDeg: number; }

// Diverse pan+tilt geometry so R_s is well-conditioned (the sweep MUST span both
// axes — clustering near the horizon leaves R_s under-constrained). Matches the
// characterization geometry used to validate the solve.
export const SWEEP_POSITIONS: SweepPosition[] = [
  { panDeg: -102, tiltDeg: 0 }, { panDeg: -102, tiltDeg: 25 }, { panDeg: -102, tiltDeg: -25 },
  { panDeg: -65, tiltDeg: 10 }, { panDeg: -140, tiltDeg: 10 }, { panDeg: -65, tiltDeg: -15 },
  { panDeg: -140, tiltDeg: 25 },
];

export interface CharacterizeDeps {
  positions: SweepPosition[];
  geoPanSign: number;
  samplesPerPos: number;
  moveTo: (panDeg: number, tiltDeg: number) => Promise<void>;
  getGravity: (n: number) => Promise<Vec3>;
  store: CalibrationStore;
}

export async function runCharacterizeImu(deps: CharacterizeDeps): Promise<{ rmsDeg: number; residualsDeg: number[] }> {
  const samples: GravitySample[] = [];
  for (const p of deps.positions) {
    await deps.moveTo(p.panDeg, p.tiltDeg);
    const gravity = await deps.getGravity(deps.samplesPerPos);
    samples.push({ panDeg: p.panDeg, tiltDeg: p.tiltDeg, gravity });
  }
  const { rS, dBase, residualsDeg, rmsDeg } = solveImuMounting(samples, deps.geoPanSign);
  deps.store.setImuMounting(rS, dBase);
  return { rmsDeg, residualsDeg };
}

export function registerImuTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, supervisor: SunSupervisor,
): void {
  server.registerTool(
    "characterize_imu",
    {
      description: "Sweep the rig through a fixed pan+tilt geometry, read gravity at each, and solve the one-time IMU→head mounting (R_s). Needed once while the IMU stays bolted on; persists R_s for gravity-anchored calibration. Motion tool — respects limits, sun guard, deadman.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      try {
        const res = await runCharacterizeImu({
          positions: SWEEP_POSITIONS,
          geoPanSign: cfg.geoPanSign,
          samplesPerPos: 100,
          moveTo: async (p, t) => { await moveToUserAngle(device, cfg, p, t); },
          getGravity: (n) => device.getGravity(n),
          store,
        });
        return text(JSON.stringify({
          note: `IMU mounting solved from ${SWEEP_POSITIONS.length} positions`,
          rms_deg: Number(res.rmsDeg.toFixed(2)),
          warn: res.rmsDeg > 3 ? "high residual — the IMU mounting may have shifted or the sweep was too clustered; re-run." : undefined,
        }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );
}
```

Register it wherever `registerGeoTools(...)` is called in `src/server.ts` (add `registerImuTools(server, device, cfg, store, supervisor);`).

- [ ] **Step 6: Run tests + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/imu-tools.test.ts test/config.test.ts && npm test`
Expected: PASS; full suite green.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/imu-tools.ts tb3-mcp/src/config.ts tb3-mcp/src/server.ts tb3-mcp/test/imu-tools.test.ts tb3-mcp/test/config.test.ts && git commit -m "feat(calib): characterize_imu tool + geoPanSign config"
```

---

### Task 9: `solve_calibration` gravity path + offset-aware `point_at`

**Files:**
- Modify: `tb3-mcp/src/geo-tools.ts`
- Test: `tb3-mcp/test/geo-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `solveCalibrationWithGravity`, `enuToPanTiltOffset`, `boresightToEnu` from `./geo/imu-orientation.js`; `CalibrationStore.getImuMounting/getCHead/setGravityCalibration`; `Device.getGravity`; `Config.geoPanSign`.
- Produces: `solve_calibration` uses the gravity path when `getImuMounting()` is present (one gravity read → `dBase = M(pan,tilt)·R_s·g_s`… but simpler: reuse the stored `dBase` from `characterize_imu` when the tripod has not moved; take a fresh gravity read and recompute `dBase` from `R_s` for robustness). `point_at`/`point_at_azel` route through `enuToPanTiltOffset` with `cHead` (or `[0,1,0]`) and `cfg.geoPanSign`.

**Design note — computing `dBase` at solve time:** `characterize_imu` already stored `dBase`. But the tripod may have been re-leveled since. Take a fresh gravity read `g_s` at the *current* pan/tilt and compute `dBase = normalize(M(geoPanSign·pan, tilt)·R_s·g_s)`. This is the same constant the sweep found, but current. Add a small helper `dBaseFromGravity(rS, panDeg, tiltDeg, gravity, geoPanSign)` to `imu-orientation.ts`.

- [ ] **Step 1: Add `dBaseFromGravity` + failing test for it**

Append to `imu-orientation.ts`:

```typescript
// Base-frame down vector from ONE gravity read at a known posture: d_base =
// normalize(M(gp·pan,tilt)·R_s·g_s). Constant across postures for a fixed tripod.
export function dBaseFromGravity(rS: Mat3, panDeg: number, tiltDeg: number, gravity: Vec3, geoPanSign: number): Vec3 {
  const M = mountHeadRotation(geoPanSign * panDeg, tiltDeg);
  return normalize(matVec(matMul(M, rS), normalize(gravity)));
}
```

Test (add to `test/imu-mounting.test.ts`):

```typescript
it("dBaseFromGravity at any swept posture matches the solved d_base", () => {
  const { rS, dBase } = solveImuMounting(samples, -1);
  const s = field.sweep[3];
  const d = dBaseFromGravity(rS, s.pan, s.tilt, normalize([s.ax, s.ay, s.az] as Vec3), -1);
  expect(d[0]).toBeCloseTo(dBase[0], 2);
  expect(d[2]).toBeCloseTo(dBase[2], 2);
});
```

Run it (fails until implemented), then passes.

- [ ] **Step 2: Write the failing gravity-path test**

Extend `test/geo-tools.test.ts` with a solve+point flow using a fake device/store. Follow the file's existing harness for building a `Device`/`Config`/`CalibrationStore` (mirror an existing `point_at` test there). The assertion that matters:

```typescript
// Pseudocode shape — adapt to geo-tools.test.ts's existing harness/mocks.
it("gravity path: solve then point_at a high target aims UP, not into the ground", async () => {
  // Arrange: store with rig=field.rig, imuMounting from solveImuMounting(field.sweep,-1),
  // two sightings = field.sightings (panDeg/tiltDeg + lat/lon/height), cfg.geoPanSign=-1,
  // and a device whose getGravity returns the field gravity for the current posture.
  // Act: call the solve_calibration handler, then point_at_azel(154, 10).
  // Assert: solved cHead present; point_at_azel commanded tilt ≈ -23.8 (NOT -63), in range.
});
```

- [ ] **Step 3: Implement the gravity path in `solve_calibration`**

In `registerGeoTools`, inside the `solve_calibration` handler, branch before the TRIAD block:

```typescript
const imu = store.getImuMounting();
if (imu) {
  // Gravity-anchored path: fresh gravity read → dBase → solve R + cHead.
  const cur = currentUserPanTilt(device, cfg);
  let gravity: Vec3;
  try { gravity = await device.getGravity(100); }
  catch (e) { return errText(`gravity read failed: ${(e as Error).message}`); }
  const dBase = dBaseFromGravity(imu.rS, cur.panDeg, cur.tiltDeg, gravity, cfg.geoPanSign);
  const toSighting = (s: typeof sa): GravitySighting => {
    const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
    const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
    return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
  };
  const { R, cHead, headingResidualDeg } = solveCalibrationWithGravity(dBase, [toSighting(sa), toSighting(sb)], cfg.geoPanSign);
  if (headingResidualDeg > 3) {
    return errText(`gravity solve rejected: the two landmarks disagree by ${headingResidualDeg.toFixed(1)}° — sightings are degenerate or mis-aimed; re-sight (ideally add a 3rd/elevation-spread landmark)`);
  }
  store.setGravityCalibration(R, cHead, new Date().toISOString());
  const upUnit: Vec3 = [R[0][2], R[1][2], R[2][2]];
  const baseTilt = 90 - rad2deg(Math.asin(Math.max(-1, Math.min(1, upUnit[2]))));
  return text(JSON.stringify({
    mode: "gravity-anchored",
    heading_residual_deg: Number(headingResidualDeg.toFixed(2)),
    base_tilt_deg: Number(baseTilt.toFixed(2)),
    camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, cHead[1])))).toFixed(1)),
    note: "solved with gravity anchor + camera offset.",
  }));
}
// else: existing TRIAD path unchanged (with the near-horizon warning).
```

Update `point_at` and `point_at_azel` to use the offset-aware inverse:

```typescript
// replace: const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
const cHead = store.getCHead() ?? [0, 1, 0];
const inv = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit,
  { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax });
if (!inv.inRange) return errText(`computed pan ${inv.panDeg.toFixed(2)}°/tilt ${inv.tiltDeg.toFixed(2)}° is outside the reachable range — target is below the horizon, behind a pan limit, or too high`);
const { panDeg, tiltDeg } = inv;
// (the reachablePanTilt ±360 pan wrap can be applied to inv.panDeg as today)
```

Keep `reachablePanTilt` for the ±360 pan-wrap resolution: call it with `inv.panDeg`/`inv.tiltDeg`.

- [ ] **Step 4: Run tests + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/geo-tools.test.ts test/imu-mounting.test.ts && npm test`
Expected: PASS; full suite green (TRIAD-path tests unchanged since they never set `imuMounting`; default `geoPanSign=+1` and absent `cHead` keep legacy `point_at` identical).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/geo-tools.ts tb3-mcp/src/geo/imu-orientation.ts tb3-mcp/test/geo-tools.test.ts tb3-mcp/test/imu-mounting.test.ts && git commit -m "feat(calib): solve_calibration gravity path + offset-aware point_at"
```

---

### Task 10: Propagate the offset model to tracking, sun-guard, and ADS-B

**Files:**
- Modify: `tb3-mcp/src/track/control.ts`, `tb3-mcp/src/track/session.ts`, `tb3-mcp/src/track/sunguard.ts`, `tb3-mcp/src/track/supervisor.ts`, `tb3-mcp/src/adsb/enrich.ts`
- Test: `tb3-mcp/test/track-offset.test.ts` (new) + existing track/sun/adsb suites stay green

**Interfaces:**
- Consumes: `boresightToEnu`, `enuToPanTiltOffset` from `../geo/imu-orientation.js`; `CalibrationStore.getCHead`; `Config.geoPanSign`.
- Produces: every ENU↔pan/tilt conversion that currently calls `matVec(R, panTiltToMount(...))` or `enuToPanTilt(R, ...)` for a *target/boresight* switches to the offset-aware pair, sourcing `cHead = store.getCHead() ?? [0,1,0]` and `cfg.geoPanSign`. **Backward-compatible:** with defaults these are identical, so existing tests pass unchanged.

**Safety note:** the sun guard maps the *sun's* ENU to pan/tilt to know where NOT to point. It must use the SAME offset model as pointing, or the guard and the aim disagree. Route `sunguard.ts` through `enuToPanTiltOffset` too. Keep the boresight-forward (where the camera actually looks) as `boresightToEnu` so sun-separation is measured from the true optical axis.

- [ ] **Step 1: Write the failing test (offset changes the mapping)**

```typescript
// tb3-mcp/test/track-offset.test.ts
import { describe, it, expect } from "vitest";
import { boresightToEnu, enuToPanTiltOffset } from "../src/geo/imu-orientation.js";
import { enuToPanTilt } from "../src/geo/orientation.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

const LIM = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

describe("offset model wiring", () => {
  it("with cHead=[0,1,0]/geoPanSign=+1 the mapping is the legacy one (no behavior change)", () => {
    const u = normalize([0.2, 0.9, 0.3] as Vec3);
    const legacy = enuToPanTilt(I, u);
    const off = enuToPanTiltOffset(I, [0, 1, 0], 1, u, LIM);
    expect(off.panDeg).toBeCloseTo(legacy.panDeg, 9);
    expect(off.tiltDeg).toBeCloseTo(legacy.tiltDeg, 9);
  });

  it("a non-forward cHead shifts the commanded posture (offset is actually applied)", () => {
    const cHead = normalize([-0.52, 0.735, 0.434] as Vec3);
    const u = normalize([0.2, 0.9, 0.3] as Vec3);
    const off = enuToPanTiltOffset(I, cHead, -1, u, LIM);
    const legacy = enuToPanTilt(I, u);
    expect(Math.abs(off.tiltDeg - legacy.tiltDeg)).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/track-offset.test.ts`
Expected: FAIL until the imports resolve (they exist from Task 5, so this test should actually PASS at step 2 — if so, treat it as the guard test and proceed to wire the call sites; its purpose is to lock the invariant before refactoring).

- [ ] **Step 3: Wire the call sites**

For each of these, replace the legacy call with the offset-aware version, sourcing `cHead = this.store.getCHead() ?? [0,1,0]` (or the local store handle) and `this.cfg.geoPanSign`:

- `src/track/control.ts:29` `matVec(R, panTiltToMount(panDeg, tiltDeg))` → `boresightToEnu(R, cHead, geoPanSign, panDeg, tiltDeg)`. This function needs `cHead`/`geoPanSign` threaded in — add them to its signature and pass from the caller (`session.ts`/`supervisor.ts`).
- `src/track/control.ts:49-50` `enuToPanTilt(R, u0)` / `enuToPanTilt(R, normalize(p1))` → `enuToPanTiltOffset(R, cHead, geoPanSign, u0, limits)` returning `{panDeg,tiltDeg}` (ignore `inRange` here; this is a local error-gradient calc — use `enuToPanTiltOffsetAll(...)[0]` or the ranged pick; keep the existing two-point delta semantics).
- `src/track/session.ts:204,308` target pan/tilt from the tracked aircraft ENU → `enuToPanTiltOffset(R, cHead, geoPanSign, aim.enuUnit, limits, preferTilt?)`.
- `src/track/sunguard.ts:103` `enuToPanTilt(R, sunEnu)` → `enuToPanTiltOffset(R, cHead, geoPanSign, sunEnu, limits)` (the sun's posture in the same frame as aim).
- `src/track/supervisor.ts:197,210` boresight forward → `boresightToEnu(...)` via the updated `control.ts` helper.
- `src/adsb/enrich.ts:27,56` `enuToPanTilt(R, unit)` → `enuToPanTiltOffset(R, cHead, geoPanSign, unit, limits)` (enrichment reports the aircraft's pan/tilt for the dashboard/agent; use the in-range pick).

Thread `cHead`/`geoPanSign` from the owning objects (each of these classes already holds `store` and `cfg`). Where a pure helper (`control.ts`) can't reach the store, add `cHead: Vec3` and `geoPanSign: number` parameters and pass from the caller.

- [ ] **Step 4: Run the FULL suite (this is the safety-critical propagation)**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npm test`
Expected: ALL green. Any pre-existing track/sun/adsb test that changed value indicates the default-path (cHead absent, geoPanSign +1) is NOT reducing to the legacy mapping — fix the wiring so defaults are a no-op. New behavior only appears once `cHead` is set + `geoPanSign=-1`.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/track tb3-mcp/src/adsb/enrich.ts tb3-mcp/test/track-offset.test.ts && git commit -m "feat(track): route tracking/sun-guard/ADS-B through the offset-aware pointing model"
```

---

## On-Rig Verification (NOT a code task — operator + hand on E-STOP)

After deploy (`git push` by the operator, host pulls/builds/restarts):
1. Set `TB3_GEO_PAN_SIGN=-1` in the host daemon env; restart `tb3-mcp` (then `tb3-dashboard`).
2. `characterize_imu` (a short pan+tilt sweep) — confirm reported `rms_deg` ≤ ~2°.
3. Re-calibrate: `set_rig_location`, sight **three** landmarks (or two at clearly different elevations — the 2-landmark camera-offset solve has a mirror ambiguity the 3rd resolves), `solve_calibration` — confirm `mode: gravity-anchored`, small `heading_residual_deg`, `base_tilt_deg` ≈ 4°.
4. `point_at` a landmark's own coords → confirm it centers on the crosshair.
5. `point_at_azel` a high target (e.g. el +20°) → confirm a sane upward tilt.
6. Confirm jog direction is still correct (the geo sign is separate from jog; if jog changed, something double-applied — investigate before flying).

---

## Self-Review

**Spec coverage:** Root cause 1 (near-horizon) → Tasks 3-4 (gravity anchor). Root cause 2 (camera offset) → Task 4 (`c_head`) + Task 5 (offset inverse) + Tasks 9-10 (applied). Root cause 3 (pan handedness) → `geoPanSign` (Task 8) threaded through Tasks 4/5/9/10. `R_s` characterization → Tasks 3, 8. Persistence → Task 7. Gravity acquisition → Task 6. Disambiguation + heading-agreement refusal → Task 4 + Task 9 guard. TRIAD fallback preserved → Task 9. Testing (unit golden + regression) → every task. On-rig steps → dedicated section. All spec sections map to a task.

**Placeholder scan:** Task 9 Step 2 is intentionally a shape/pseudocode note ("adapt to geo-tools.test.ts's existing harness") because the exact mock construction depends on that file's current helpers, which the implementer must read; the *assertion* (tilt ≈ −23.8, in range, cHead present) is concrete. All other steps carry complete code.

**Type consistency:** `GravitySample`, `GravitySighting`, `ImuMounting`, `GravityCalibration`, `InversePosture` are defined once (Tasks 3-5) and consumed by name in Tasks 8-10. `boresightToEnu`/`enuToPanTiltOffset`/`solveCalibrationWithGravity`/`solveImuMounting`/`dBaseFromGravity` signatures match across the pure-math tasks and the tool tasks. `geoPanSign` is a `sign` (`1|-1`) consistently. `cHead` is `Vec3` everywhere; the store round-trips it as `number[3]`.

**Known deferral:** `geoPanSign` default stays `+1` (host env sets `-1`) to keep the 85 existing tests green; the physically-correct value is `-1`, applied via env until a future migration flips the default and updates the affected point/track tests.
