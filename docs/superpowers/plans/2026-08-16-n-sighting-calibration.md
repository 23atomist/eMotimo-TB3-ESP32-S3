# N-Sighting Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-sighting exact calibration solve — which cannot identify the camera boresight and currently holds a physically impossible 43° value — with a staged N-sighting weighted least-squares fit whose conditioning gate is derived from its own covariance.

**Architecture:** A new pure module `src/geo/calibration-fit.ts` fits three parameters (heading plus two camera-boresight DOF) by Gauss-Newton over weighted tangent-plane residuals. It reports parameter sigmas, and freezes the camera parameters at forward whenever the data does not determine them. `CalibrationStore` grows an unbounded sighting list with per-sighting metadata and re-solves automatically on load and on every add, using a persisted gravity anchor. Three smaller fixes ride along: reachability computed against taught limits, a daemon-side range filter, and nearest-first target selection.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Zod for schema validation, Vitest for tests, Node 24 on the rig host. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-n-sighting-calibration-design.md`

## Global Constraints

- All angles in degrees at module boundaries; radians only inside a function body.
- `Vec3`/`Mat3` from `src/geo/vec3.js` are `readonly` tuple types — never mutate, always construct new.
- New optional Zod fields must be genuinely optional so the deployed profile at `~/.tb3-mcp/calibration.json` parses unchanged.
- `geoPanSign` is `-1` on this rig and is threaded explicitly; never read from a global.
- `DEFAULT_SIGHTING_SIGMA_DEG = 1.0` — the fallback expected angular error for a sighting with no recorded `sigmaDeg`.
- `maxCHeadSigmaDeg` default `3`, `maxCHeadOffAxisDeg` default `15`.
- Outlier rejection requires ≥4 sightings, rejects at most 30%, never leaves fewer than 3 accepted.
- Run tests with `npm test` from `tb3-mcp/`. Run one file with `npx vitest run test/<file>.test.ts`.
- Commit after every task. Conventional commit prefixes: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

---

### Task 1: The calibration fit

**Files:**
- Create: `tb3-mcp/src/geo/calibration-fit.ts`
- Modify: `tb3-mcp/src/geo/imu-orientation.ts` (export `rotAlign`)
- Test: `tb3-mcp/test/calibration-fit.test.ts`

**Interfaces:**
- Consumes: `mountHeadRotation` from `src/geo/boresight.js`; `rotAlign`, `boresightToEnu` from `src/geo/imu-orientation.js`; `inv3`, `rotZ`, `matMul`, `matVec`, `normalize`, `cross`, `dot`, `deg2rad`, `rad2deg` from `src/geo/vec3.js`.
- Produces: `fitCalibration(dBase, sightings, geoPanSign, opts?) => CalibrationFit`, plus the exported types `FitSighting`, `FitOptions`, `CalibrationFit`, and the constant `DEFAULT_SIGHTING_SIGMA_DEG`.

- [ ] **Step 1: Export `rotAlign` from `imu-orientation.ts`**

It is currently a module-private function. Change its declaration only:

```ts
// Rotation aligning unit a → unit b (Rodrigues); used to build R0 from gravity.
export function rotAlign(a: Vec3, b: Vec3): Mat3 {
```

- [ ] **Step 2: Write the failing test**

Create `tb3-mcp/test/calibration-fit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fitCalibration, FitSighting, DEFAULT_SIGHTING_SIGMA_DEG } from "../src/geo/calibration-fit.js";
import { boresightToEnu } from "../src/geo/imu-orientation.js";
import { Vec3, Mat3, normalize, rotZ, matMul, deg2rad, rad2deg, angleBetweenDeg } from "../src/geo/vec3.js";
import { enuDirection } from "../src/geo/wgs84.js";

const GP = -1;
// A base leaning ~1.2° north, matching the real rig.
const D_BASE: Vec3 = normalize([0.0214, -0.0010, -0.9998]);

function cHeadOf(sideDeg: number, upDeg: number): Vec3 {
  const a = deg2rad(sideDeg), e = deg2rad(upDeg);
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

// Build a synthetic sighting: given truth (R, cHead) and a posture, the ENU
// direction the camera actually looks at IS the truth direction.
function synth(R: Mat3, c: Vec3, panDeg: number, tiltDeg: number, sigmaDeg = 0.5): FitSighting {
  return { panDeg, tiltDeg, enuUnit: normalize(boresightToEnu(R, c, GP, panDeg, tiltDeg)), sigmaDeg };
}

describe("fitCalibration", () => {
  it("recovers a known heading and camera offset from well-spread sightings", () => {
    const { rotAlign } = require("../src/geo/imu-orientation.js");
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
    expect(fit.rmsDeg).toBeLessThan(0.1);
    expect(fit.usedCount).toBe(6);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/calibration-fit.test.ts`
Expected: FAIL — cannot resolve `../src/geo/calibration-fit.js`.

- [ ] **Step 4: Implement `calibration-fit.ts`**

Create `tb3-mcp/src/geo/calibration-fit.ts`:

```ts
import {
  Vec3, Mat3, deg2rad, rad2deg, dot, cross, normalize, matVec, matMul, rotZ, inv3,
} from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { rotAlign } from "./imu-orientation.js";

/** Fallback 1σ angular error for a sighting recorded before sigmaDeg existed. */
export const DEFAULT_SIGHTING_SIGMA_DEG = 1.0;

const GN_ITERATIONS = 40;
const GN_STEP_RAD = 1e-6;          // central-difference step for the Jacobian
const GN_CONVERGED_RAD = 1e-10;    // stop when the parameter step is this small
const GN_DAMPING = 1e-12;          // keeps JᵀWJ invertible in degenerate geometry
const MIN_SIGHTINGS_FOR_FULL = 2;  // 3 params need ≥4 residual components
const MIN_SIGHTINGS_FOR_OUTLIERS = 4;
const MAX_REJECT_FRACTION = 0.3;
const MIN_ACCEPTED_AFTER_REJECT = 3;
const OUTLIER_RMS_MULTIPLE = 3;
const OUTLIER_FLOOR_DEG = 2;

export interface FitSighting {
  readonly panDeg: number;
  readonly tiltDeg: number;
  readonly enuUnit: Vec3;   // truth direction, rig → target
  readonly sigmaDeg: number; // 1σ expected angular error of THIS sighting
}

export interface FitOptions {
  readonly maxCHeadSigmaDeg?: number;
  readonly maxCHeadOffAxisDeg?: number;
}

export interface CalibrationFit {
  readonly R: Mat3;
  readonly cHead: Vec3;
  readonly stage: "heading-only" | "full";
  readonly headingSigmaDeg: number;
  readonly cHeadSigmaDeg: number | null;
  readonly residualsDeg: number[];  // per INPUT sighting, input order
  readonly rejected: boolean[];     // per INPUT sighting, input order
  readonly rmsDeg: number;          // over accepted sightings only
  readonly usedCount: number;
  readonly baseLeanDeg: number;
  readonly tiltSpreadDeg: number;
}

/** Camera boresight from its two angular parameters. Unit by construction. */
function cHeadOf(caRad: number, ceRad: number): Vec3 {
  return [Math.sin(caRad) * Math.cos(ceRad), Math.cos(caRad) * Math.cos(ceRad), Math.sin(ceRad)];
}

/** An orthonormal pair spanning the plane perpendicular to unit vector u. */
function tangentBasis(u: Vec3): [Vec3, Vec3] {
  const seed: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(u, seed));
  const e2 = cross(u, e1); // already unit: u ⟂ e1, both unit
  return [e1, e2];
}

/**
 * Predicted boresight direction for parameters p = [heading, cHeadAz, cHeadEl]
 * (all radians) at a given posture.
 */
function predict(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): Vec3 {
  const M = mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg);
  return normalize(matVec(matMul(rotZ(p[0]), matMul(R0, M)), cHeadOf(p[1], p[2])));
}

/**
 * Weighted tangent-plane residual pair for one sighting, in units of sigma.
 * For small errors each component is the angular error (radians) along one
 * tangent direction, so the pair's magnitude is the angular miss.
 */
function residualPair(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): [number, number] {
  const pred = predict(R0, geoPanSign, p, s);
  const [e1, e2] = tangentBasis(s.enuUnit);
  const w = 1 / deg2rad(s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG);
  return [dot(pred, e1) * w, dot(pred, e2) * w];
}

function angularErrorDeg(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): number {
  const pred = predict(R0, geoPanSign, p, s);
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(pred, s.enuUnit)))));
}

/**
 * Gauss-Newton over the free parameters only. `free` selects which of the three
 * parameters may move; the rest stay at their seed value. Returns the solved
 * parameters and the 3×3 normal matrix (JᵀWJ), padded with 1 on frozen
 * diagonals so it stays invertible.
 */
function gaussNewton(
  R0: Mat3, geoPanSign: number, seed: readonly number[], sightings: FitSighting[], free: readonly boolean[],
): { p: number[]; normal: Mat3 } {
  const p = [...seed];
  let normal: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < GN_ITERATIONS; iter++) {
    // Accumulate JᵀJ and Jᵀr over all sightings (weights already folded into r).
    const jtj = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const jtr = [0, 0, 0];
    for (const s of sightings) {
      const r = residualPair(R0, geoPanSign, p, s);
      const cols: number[][] = [[0, 0], [0, 0], [0, 0]];
      for (let k = 0; k < 3; k++) {
        if (!free[k]) continue;
        const up = [...p], dn = [...p];
        up[k] += GN_STEP_RAD; dn[k] -= GN_STEP_RAD;
        const ru = residualPair(R0, geoPanSign, up, s);
        const rd = residualPair(R0, geoPanSign, dn, s);
        cols[k] = [(ru[0] - rd[0]) / (2 * GN_STEP_RAD), (ru[1] - rd[1]) / (2 * GN_STEP_RAD)];
      }
      for (let a = 0; a < 3; a++) {
        if (!free[a]) continue;
        jtr[a] += cols[a][0] * r[0] + cols[a][1] * r[1];
        for (let b = 0; b < 3; b++) {
          if (!free[b]) continue;
          jtj[a][b] += cols[a][0] * cols[b][0] + cols[a][1] * cols[b][1];
        }
      }
    }
    for (let k = 0; k < 3; k++) {
      if (free[k]) jtj[k][k] += GN_DAMPING;
      else jtj[k][k] = 1; // frozen: identity row/col, so inv3 stays well-defined
    }
    normal = [
      [jtj[0][0], jtj[0][1], jtj[0][2]],
      [jtj[1][0], jtj[1][1], jtj[1][2]],
      [jtj[2][0], jtj[2][1], jtj[2][2]],
    ];
    let step: Vec3;
    try {
      step = matVec(inv3(normal), [jtr[0], jtr[1], jtr[2]]);
    } catch {
      break; // singular despite damping — keep the best parameters so far
    }
    let moved = 0;
    for (let k = 0; k < 3; k++) {
      if (!free[k]) continue;
      p[k] -= step[k];
      moved = Math.max(moved, Math.abs(step[k]));
    }
    if (moved < GN_CONVERGED_RAD) break;
  }
  return { p, normal };
}

/** Weighted circular mean of the per-sighting heading disagreement — the seed. */
function seedHeading(R0: Mat3, geoPanSign: number, sightings: FitSighting[]): number {
  let sinSum = 0, cosSum = 0;
  for (const s of sightings) {
    const m = matVec(matMul(R0, mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg)), [0, 1, 0] as Vec3);
    const azModel = Math.atan2(m[0], m[1]);
    const azTruth = Math.atan2(s.enuUnit[0], s.enuUnit[1]);
    const w = 1 / Math.max(deg2rad(s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG) ** 2, 1e-12);
    sinSum += w * Math.sin(azTruth - azModel);
    cosSum += w * Math.cos(azTruth - azModel);
  }
  return Math.atan2(sinSum, cosSum);
}

function fitOnce(
  R0: Mat3, geoPanSign: number, sightings: FitSighting[], opts: Required<FitOptions>,
): { p: number[]; stage: "heading-only" | "full"; headingSigmaDeg: number; cHeadSigmaDeg: number | null } {
  const seed = [seedHeading(R0, geoPanSign, sightings), 0, 0];

  const headingOnly = gaussNewton(R0, geoPanSign, seed, sightings, [true, false, false]);
  const hSigma = (normal: Mat3): number => {
    try { return rad2deg(Math.sqrt(Math.max(0, inv3(normal)[0][0]))); } catch { return Infinity; }
  };

  if (sightings.length < MIN_SIGHTINGS_FOR_FULL) {
    return { p: headingOnly.p, stage: "heading-only", headingSigmaDeg: hSigma(headingOnly.normal), cHeadSigmaDeg: null };
  }

  const full = gaussNewton(R0, geoPanSign, headingOnly.p, sightings, [true, true, true]);
  let cov: Mat3 | null = null;
  try { cov = inv3(full.normal); } catch { cov = null; }
  const cSigma = cov === null
    ? Infinity
    : rad2deg(Math.sqrt(Math.max(0, Math.max(cov[1][1], cov[2][2]))));
  const offAxisDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, cHeadOf(full.p[1], full.p[2])[1]))));

  // Two independent guards. Either one failing means the camera parameters are
  // not trustworthy, so they stay frozen at forward.
  if (!Number.isFinite(cSigma) || cSigma > opts.maxCHeadSigmaDeg || offAxisDeg > opts.maxCHeadOffAxisDeg) {
    return { p: headingOnly.p, stage: "heading-only", headingSigmaDeg: hSigma(headingOnly.normal), cHeadSigmaDeg: null };
  }
  return {
    p: full.p,
    stage: "full",
    headingSigmaDeg: cov === null ? Infinity : rad2deg(Math.sqrt(Math.max(0, cov[0][0]))),
    cHeadSigmaDeg: cSigma,
  };
}

export function fitCalibration(
  dBase: Vec3, sightings: FitSighting[], geoPanSign: number, opts: FitOptions = {},
): CalibrationFit {
  if (sightings.length === 0) throw new Error("fitCalibration: need at least one sighting");
  const resolved: Required<FitOptions> = {
    maxCHeadSigmaDeg: opts.maxCHeadSigmaDeg ?? 3,
    maxCHeadOffAxisDeg: opts.maxCHeadOffAxisDeg ?? 15,
  };
  const dn = normalize(dBase);
  const R0 = rotAlign([-dn[0], -dn[1], -dn[2]], [0, 0, 1]);
  const baseLeanDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, -dn[2]))));

  // Pass 1 over everything, then optionally reject outliers and refit.
  let accepted = sightings.map(() => true);
  let result = fitOnce(R0, geoPanSign, sightings, resolved);

  if (sightings.length >= MIN_SIGHTINGS_FOR_OUTLIERS) {
    const errs = sightings.map((s) => angularErrorDeg(R0, geoPanSign, result.p, s));
    const rms = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / errs.length);
    const threshold = Math.max(OUTLIER_RMS_MULTIPLE * rms, OUTLIER_FLOOR_DEG);
    const maxReject = Math.min(
      Math.floor(sightings.length * MAX_REJECT_FRACTION),
      sightings.length - MIN_ACCEPTED_AFTER_REJECT,
    );
    if (maxReject > 0) {
      // Worst-first, capped. Ties broken by index for determinism.
      const order = errs.map((e, i) => ({ e, i })).sort((a, b) => b.e - a.e || a.i - b.i);
      let dropped = 0;
      for (const { e, i } of order) {
        if (dropped >= maxReject || e <= threshold) break;
        accepted[i] = false;
        dropped++;
      }
      if (dropped > 0) {
        result = fitOnce(R0, geoPanSign, sightings.filter((_, i) => accepted[i]), resolved);
      }
    }
  }

  const residualsDeg = sightings.map((s) => angularErrorDeg(R0, geoPanSign, result.p, s));
  const used = sightings.filter((_, i) => accepted[i]);
  const usedErrs = residualsDeg.filter((_, i) => accepted[i]);
  const tilts = used.map((s) => s.tiltDeg);
  return {
    R: matMul(rotZ(result.p[0]), R0),
    cHead: cHeadOf(result.p[1], result.p[2]),
    stage: result.stage,
    headingSigmaDeg: result.headingSigmaDeg,
    cHeadSigmaDeg: result.cHeadSigmaDeg,
    residualsDeg,
    rejected: accepted.map((a) => !a),
    rmsDeg: Math.sqrt(usedErrs.reduce((a, b) => a + b * b, 0) / usedErrs.length),
    usedCount: used.length,
    baseLeanDeg,
    tiltSpreadDeg: Math.max(...tilts) - Math.min(...tilts),
  };
}
```

- [ ] **Step 5: Fix the test's import style and run it**

Replace the `require(...)` line in the test with a proper ESM import at the top of the file (`import { rotAlign } from "../src/geo/imu-orientation.js";`) and delete the in-test `const { rotAlign } = require(...)` line.

Run: `npx vitest run test/calibration-fit.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the gate, outlier and field-regression tests**

Append to `test/calibration-fit.test.ts`:

```ts
describe("fitCalibration conditioning gate", () => {
  it("refuses the camera offset when two sightings barely span any tilt", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [synth(truthR, truthC, 24, 10), synth(truthR, truthC, -23, 18)];

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
    expect(fit.cHeadSigmaDeg).toBeNull();
  });

  it("never returns a camera offset beyond the physical bound", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    // A genuinely absurd camera mounting; the physical guard must reject it
    // even though the data supports it perfectly.
    const truthC = cHeadOf(43, 4);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.2));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
  });
});

describe("fitCalibration outlier rejection", () => {
  it("rejects one gross outlier and recovers the true fit", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));
    // Corrupt one sighting's recorded posture by 15° — an operator who
    // centred the wrong aircraft.
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected[2]).toBe(true);
    expect(fit.rejected.filter(Boolean)).toHaveLength(1);
    expect(fit.usedCount).toBe(5);
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("retains every sighting when there are too few to judge an outlier", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const s = [
      synth(truthR, cHeadOf(4, -3), 40, 5),
      synth(truthR, cHeadOf(4, -3), -20, 38),
      synth(truthR, cHeadOf(4, -3), 10, 20),
    ];
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.rejected).toEqual([false, false, false]);
  });
});

describe("fitCalibration against the 2026-08-16 field profile", () => {
  // The exact rig position and the two sightings that produced the 43.4°
  // cHead in ~/.tb3-mcp/calibration.json. This must never solve to a
  // sideways camera again.
  const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 341 };
  const field = [
    { lat: 33.48862875499936, lon: -112.19274762587969, height: 2590.9658112, panDeg: 23.92202392202392, tiltDeg: 10.22176022176022 },
    { lat: 33.410182683296966, lon: -112.12529990150021, height: 1322.22678912, panDeg: -22.58102258102258, tiltDeg: 18.474768474768474 },
  ];
  const s: FitSighting[] = field.map((f) => ({
    panDeg: f.panDeg, tiltDeg: f.tiltDeg,
    enuUnit: enuDirection(rig, { lat: f.lat, lon: f.lon, height: f.height }).unit,
    sigmaDeg: DEFAULT_SIGHTING_SIGMA_DEG,
  }));

  it("falls back to heading-only instead of a 43° camera offset", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
  });

  it("keeps every sighting within a few degrees", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    for (const r of fit.residualsDeg) expect(r).toBeLessThan(3);
  });

  it("reports the short tilt baseline that caused the problem", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.tiltSpreadDeg).toBeGreaterThan(8);
    expect(fit.tiltSpreadDeg).toBeLessThan(9);
  });
});
```

- [ ] **Step 7: Run the full file**

Run: `npx vitest run test/calibration-fit.test.ts`
Expected: PASS, all cases.

- [ ] **Step 8: Commit**

```bash
git add tb3-mcp/src/geo/calibration-fit.ts tb3-mcp/src/geo/imu-orientation.ts tb3-mcp/test/calibration-fit.test.ts
git commit -m "feat(calib): N-sighting fit with a covariance-derived conditioning gate

Three parameters (heading + 2 camera-boresight DOF) by Gauss-Newton over
weighted tangent-plane residuals. The camera parameters stay frozen at
forward unless the data determines them, judged by their own 1-sigma from
the covariance and by a physical off-axis bound.

Pinned against the 2026-08-16 field profile: those two sightings must
solve heading-only, never the 43.4-degree sideways camera they currently
produce."
```

---

### Task 2: Unbounded sighting list with per-sighting metadata

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Sighting` gains optional `id`, `atIso`, `sigmaDeg`. New methods `CalibrationStore.removeSighting(id: string): boolean` and `CalibrationStore.clearSightings(): void`. `addSighting` returns the new total count.

- [ ] **Step 1: Write the failing tests**

Add to `tb3-mcp/test/calibration.test.ts`:

```ts
describe("CalibrationStore sighting list", () => {
  it("keeps more than two sightings", () => {
    const s = new CalibrationStore(tmpFile());
    for (let i = 0; i < 5; i++) s.addSighting({ lat: i, lon: 2, height: 3, panDeg: i, tiltDeg: 5 });
    expect(s.get().sightings).toHaveLength(5);
  });

  it("assigns a stable id and timestamp to every sighting", () => {
    const s = new CalibrationStore(tmpFile());
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.addSighting({ lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10 });
    const [a, b] = s.get().sightings;
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toEqual(b.id);
    expect(Date.parse(a.atIso!)).not.toBeNaN();
  });

  it("removes a sighting by id and reports whether it matched", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.addSighting({ lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10 });
    const id = s.get().sightings[0].id!;

    expect(s.removeSighting(id)).toBe(true);
    expect(s.get().sightings).toHaveLength(1);
    expect(s.removeSighting("nope")).toBe(false);

    const reloaded = new CalibrationStore(f);
    reloaded.load();
    expect(reloaded.get().sightings).toHaveLength(1);
  });

  it("clearSightings empties the list but keeps the rig location", () => {
    const s = new CalibrationStore(tmpFile());
    s.setRigLocation(33, -112, 341);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.clearSightings();
    expect(s.get().sightings).toEqual([]);
    expect(s.get().rig).toEqual({ lat: 33, lon: -112, height: 341 });
  });

  it("migrates a legacy two-sighting profile with no ids", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      version: 1,
      rig: { lat: 33, lon: -112, height: 341 },
      sightings: [
        { lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5, label: "OLD1" },
        { lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10, label: "OLD2" },
      ],
    }));
    const s = new CalibrationStore(f);
    s.load();
    const got = s.get().sightings;
    expect(got).toHaveLength(2);
    expect(got[0].id).toBeTruthy();
    expect(got[1].id).toBeTruthy();
    expect(got[0].label).toBe("OLD1");
  });
});
```

- [ ] **Step 2: Delete the obsolete cap test**

`test/calibration.test.ts` contains `it("addSighting keeps only the last two", ...)`. That behaviour is exactly what this plan removes. Delete that whole `it(...)` block.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/calibration.test.ts`
Expected: FAIL — `removeSighting is not a function`, and the >2 case truncates to 2.

- [ ] **Step 4: Update the schema and store**

In `tb3-mcp/src/calibration.ts`, replace the `SightingSchema` and the `sightings` field of `ProfileSchema`:

```ts
const SightingSchema = z.object({
  lat: z.number(), lon: z.number(), height: z.number(),
  label: z.string().optional(),
  panDeg: z.number(), tiltDeg: z.number(),
  // All three are optional so a profile written before this existed parses
  // unchanged; load() backfills `id` and leaves the rest absent.
  id: z.string().optional(),
  atIso: z.string().optional(),
  // 1σ expected angular error, computed once at sighting time from slant
  // range, ground speed and ADS-B report age. Absent → DEFAULT_SIGHTING_SIGMA_DEG.
  sigmaDeg: z.number().positive().optional(),
});
```

```ts
  // Was .max(2). The two-sighting cap could not identify the camera boresight
  // and is the root cause of the 2026-08-16 43° cHead — see
  // docs/superpowers/specs/2026-08-16-n-sighting-calibration-design.md.
  // 200 is a file-size/solve-time bound, not a modelling one.
  sightings: z.array(SightingSchema).max(200).default([]),
```

Add a module-level id generator above `function empty()`:

```ts
// Monotonic within a process, random across processes: enough to key a
// dashboard delete button, and it never collides inside one profile.
let sightingSeq = 0;
function newSightingId(): string {
  sightingSeq += 1;
  return `s${Date.now().toString(36)}${sightingSeq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
```

Replace `addSighting` (the `.slice(-2)` and the orientation-clearing both go):

```ts
  // Appends. Unlike the old two-sighting version this does NOT clear a solved
  // orientation: callers re-solve from the full list instead (see Task 3's
  // resolve()), so there is never a window with sightings but no orientation.
  // That window was the 2026-07-29 field bug — taking a sighting killed every
  // [Track] button.
  addSighting(s: Sighting): number {
    const stamped: Sighting = {
      ...s,
      id: s.id ?? newSightingId(),
      atIso: s.atIso ?? new Date().toISOString(),
    };
    this.profile = { ...this.profile, sightings: [...this.profile.sightings, stamped] };
    this.save();
    return this.profile.sightings.length;
  }

  /** Remove one sighting by id. Returns false when nothing matched. */
  removeSighting(id: string): boolean {
    const before = this.profile.sightings.length;
    const sightings = this.profile.sightings.filter((s) => s.id !== id);
    if (sightings.length === before) return false;
    this.profile = { ...this.profile, sightings };
    this.save();
    return true;
  }

  /** Drop every sighting, keeping the rig location. The "rig moved" action. */
  clearSightings(): void {
    this.profile = { ...this.profile, sightings: [] };
    this.save();
  }
```

In `load()`, backfill ids after parsing so every stored sighting is addressable:

```ts
      const parsed = ProfileSchema.parse(raw);
      this.profile = {
        ...parsed,
        sightings: parsed.sightings.map((s) => (s.id ? s : { ...s, id: newSightingId() })),
      };
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/calibration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/test/calibration.test.ts
git commit -m "feat(calib): unbounded sighting list with id, timestamp and sigma

Lifts the .max(2)/.slice(-2) cap, stamps every sighting with a stable id
and an ISO timestamp, and adds removeSighting/clearSightings for the
dashboard. addSighting no longer clears a solved orientation."
```

---

### Task 3: Gravity anchor and automatic re-solve

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts`

**Interfaces:**
- Consumes: `fitCalibration`, `FitSighting`, `DEFAULT_SIGHTING_SIGMA_DEG` from Task 1; the sighting list from Task 2.
- Produces: profile field `baseDown?: [number, number, number]`; `setBaseDown(v: Vec3)`; `resolve(): CalibrationFit | null`; `getLastFit(): CalibrationFit | null`. `load()` and `addSighting()` both call `resolve()`.

- [ ] **Step 1: Write the failing test**

Add to `tb3-mcp/test/calibration.test.ts` (add `import { fitCalibration } from "../src/geo/calibration-fit.js";` is NOT needed — only the store API is exercised):

```ts
describe("CalibrationStore auto re-solve", () => {
  const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 341 };
  const baseDown: [number, number, number] = [0.021361137701469406, -0.0010018516612047034, -0.9997713228980655];
  const field = [
    { lat: 33.48862875499936, lon: -112.19274762587969, height: 2590.9658112, panDeg: 23.92202392202392, tiltDeg: 10.22176022176022 },
    { lat: 33.410182683296966, lon: -112.12529990150021, height: 1322.22678912, panDeg: -22.58102258102258, tiltDeg: 18.474768474768474 },
  ];

  it("discards a stored 43-degree cHead on load", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      version: 1, rig, sightings: field, baseDown,
      geoPanSign: -1,
      orientation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      cHead: [0.6835144319358544, 0.7268922696083266, 0.06660067356312523],
    }));
    const s = new CalibrationStore(f, -1);
    s.load();
    const c = s.getCHead();
    expect(c).toEqual([0, 1, 0]);
    expect(s.getLastFit()?.stage).toBe("heading-only");
  });

  it("re-solves when a sighting is added", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f, -1);
    s.setRigLocation(rig.lat, rig.lon, rig.height);
    s.setBaseDown(baseDown);
    for (const x of field) s.addSighting({ ...x });
    expect(s.getOrientation()).toBeDefined();
    expect(s.getLastFit()?.usedCount).toBe(2);
  });

  it("is a no-op with no gravity anchor", () => {
    const s = new CalibrationStore(tmpFile(), -1);
    s.setRigLocation(rig.lat, rig.lon, rig.height);
    s.addSighting({ ...field[0] });
    expect(s.getLastFit()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/calibration.test.ts`
Expected: FAIL — the `CalibrationStore` constructor takes one argument, and `setBaseDown`/`getLastFit` do not exist.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/calibration.ts`, add imports:

```ts
import { fitCalibration, FitSighting, CalibrationFit, DEFAULT_SIGHTING_SIGMA_DEG } from "./geo/calibration-fit.js";
import { enuDirection } from "./geo/wgs84.js";
```

Add to `ProfileSchema`, after `imuMounting`:

```ts
  // The gravity anchor solve_calibration verified, in the mount frame.
  // Recorded separately from imuMounting.dBase so that characterize_imu's own
  // record stays untouched and its "live read disagrees with the stored
  // characterization" staleness check keeps its exact meaning.
  baseDown: z.array(z.number()).length(3).optional(),
```

Give the constructor the pan handedness and add the fit cache:

```ts
export class CalibrationStore {
  private profile: CalibrationProfile = empty();
  private lastFit: CalibrationFit | null = null;
  // geoPanSign is needed to re-solve; defaulted so existing tests that
  // construct a store with just a path keep compiling.
  constructor(private readonly filePath: string, private readonly geoPanSign: number = 1) {}
```

Add the anchor accessors and the re-solve, after `getImuMounting()`:

```ts
  setBaseDown(v: Vec3): void {
    this.profile = { ...this.profile, baseDown: [v[0], v[1], v[2]] };
    this.save();
    this.resolve();
  }

  /** baseDown if solve_calibration has verified one, else characterize_imu's. */
  private gravityAnchor(): Vec3 | null {
    const b = this.profile.baseDown;
    if (b) return [b[0], b[1], b[2]];
    const m = this.getImuMounting();
    return m ? m.dBase : null;
  }

  getLastFit(): CalibrationFit | null { return this.lastFit; }

  /**
   * Re-fit heading and cHead from every stored sighting and persist the
   * result. The stored R/cHead are a cache of this fit, never independent
   * state, so this is the ONE place a calibration is produced.
   *
   * A no-op (returns null, touches nothing) without a rig location, without
   * sightings, or without a gravity anchor — a profile carrying only a
   * set_north_zero provisional seed is left exactly as it is.
   */
  resolve(): CalibrationFit | null {
    const rig = this.profile.rig;
    const anchor = this.gravityAnchor();
    if (!rig || anchor === null || this.profile.sightings.length === 0) return null;

    const fitInput: FitSighting[] = this.profile.sightings.map((s) => ({
      panDeg: s.panDeg,
      tiltDeg: s.tiltDeg,
      enuUnit: enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height }).unit,
      sigmaDeg: s.sigmaDeg ?? DEFAULT_SIGHTING_SIGMA_DEG,
    }));

    let fit: CalibrationFit;
    try {
      fit = fitCalibration(anchor, fitInput, this.geoPanSign);
    } catch {
      return null;   // a degenerate list must never destroy a working profile
    }
    this.lastFit = fit;
    this.setGravityCalibration(fit.R, fit.cHead, new Date().toISOString());
    return fit;
  }
```

Call it from `load()` (last line of the `try`) and from `addSighting()` (before `return`):

```ts
      // in load(), after this.profile is assigned:
      this.resolve();
```

```ts
      // in addSighting(), replacing `this.save(); return ...`:
      this.save();
      this.resolve();
      return this.profile.sightings.length;
```

Also call `this.resolve()` at the end of `removeSighting` (when it returns true) and `clearSightings`. In `clearSightings`, an empty list makes `resolve()` a no-op, so additionally clear the cached fit there: `this.lastFit = null;`.

- [ ] **Step 4: Update the construction site**

In `tb3-mcp/src/server.ts` around line 508, pass the sign:

```ts
  const calibFile = cfg.calibrationFile ?? join(homedir(), ".tb3-mcp", "calibration.json");
  const store = new CalibrationStore(calibFile, cfg.geoPanSign);
```

(Keep whatever the existing variable name is; only the constructor argument changes.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/calibration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/src/server.ts tb3-mcp/test/calibration.test.ts
git commit -m "feat(calib): re-solve automatically from a persisted gravity anchor

load(), addSighting(), removeSighting() and setBaseDown() all re-fit from
the full sighting list, so the stored R/cHead are a cache of the fit
rather than independent state. The anchor is the baseDown that
solve_calibration verified, falling back to characterize_imu's dBase, so
the re-solve needs no live gravity read and works at startup.

A profile with only a set_north_zero seed is left untouched."
```

---

### Task 4: Rewire the calibration tools

**Files:**
- Modify: `tb3-mcp/src/geo-tools.ts`
- Modify: `tb3-mcp/src/geo/imu-orientation.ts` (delete `solveCalibrationWithGravity` and `GravityCalibration`)
- Modify: `tb3-mcp/test/imu-calibration-solve.test.ts`
- Test: `tb3-mcp/test/geo-tools.test.ts`

**Interfaces:**
- Consumes: `store.resolve()`, `store.getLastFit()`, `store.setBaseDown()`, `store.removeSighting()`, `store.clearSightings()` from Tasks 2–3.
- Produces: `solve_calibration` reports `{stage, heading_sigma_deg, chead_sigma_deg, camera_offset_deg, tilt_spread_deg, used_count, rms_deg, base_tilt_deg}`; `get_calibration` reports `sightings[]` with `{id, label, at_iso, residual_deg, rejected}` plus a `fit` object; new tools `remove_sighting`, `clear_sightings`.

- [ ] **Step 1: Write the failing test**

Add to `tb3-mcp/test/geo-tools.test.ts` a case asserting the new `solve_calibration` output shape. Follow the harness already used in that file for registering tools against a fake device and calling them; assert:

```ts
// After seeding the store with the two 2026-08-16 field sightings, a rig
// location and an IMU mounting, solve_calibration must report heading-only
// rather than a large camera offset.
expect(out.stage).toBe("heading-only");
expect(out.camera_offset_deg).toBeCloseTo(0, 3);
expect(out.tilt_spread_deg).toBeGreaterThan(8);
expect(out).not.toHaveProperty("heading_residual_deg");
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/geo-tools.test.ts`
Expected: FAIL — the output still carries `heading_residual_deg` and no `stage`.

- [ ] **Step 3: Replace the gravity branch of `solve_calibration`**

In `tb3-mcp/src/geo-tools.ts`, inside the `if (imu) { ... }` branch: keep everything up to and including the `imuDisagreeDeg` computation and the movement check — that is the base re-anchoring, and it stays. Replace from `const toSighting = ...` through the end of the branch with:

```ts
        // Persist the verified anchor, then let the store re-fit from the FULL
        // sighting list. setBaseDown calls resolve() itself, so this is the
        // same code path load()/addSighting() use — there is exactly one
        // place a calibration is produced.
        store.setBaseDown(dBase);
        const fit = store.getLastFit();
        if (!fit) return errText("solve failed: no usable sightings for the fit");

        const imuNote = imuDisagreeDeg > 2
          ? ` WARNING: the live gravity read disagrees with the stored IMU characterization by ${imuDisagreeDeg.toFixed(1)}° — that should be ~0° regardless of posture, so R_s is stale (the IMU moved, or characterize_imu was run on a different setup). Re-run characterize_imu.`
          : "";
        const R = fit.R;
        const upUnit: Vec3 = [R[0][2], R[1][2], R[2][2]];
        const baseTilt = 90 - rad2deg(Math.asin(Math.max(-1, Math.min(1, upUnit[2]))));
        const note = fit.stage === "full"
          ? "solved with gravity anchor + camera offset."
          : `solved heading-only: ${fit.usedCount} sighting(s) spanning ${fit.tiltSpreadDeg.toFixed(1)}° of tilt do not determine the camera offset, so it is held at forward. Add sightings with more tilt spread (one high and close, one low and distant) to unlock it.`;
        return text(JSON.stringify({
          mode: "gravity-anchored",
          stage: fit.stage,
          used_count: fit.usedCount,
          rejected_count: fit.rejected.filter(Boolean).length,
          heading_sigma_deg: Number(fit.headingSigmaDeg.toFixed(3)),
          chead_sigma_deg: fit.cHeadSigmaDeg === null ? null : Number(fit.cHeadSigmaDeg.toFixed(3)),
          camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, fit.cHead[1])))).toFixed(2)),
          tilt_spread_deg: Number(fit.tiltSpreadDeg.toFixed(1)),
          rms_deg: Number(fit.rmsDeg.toFixed(3)),
          base_tilt_deg: Number(baseTilt.toFixed(2)),
          note: `${note}${imuNote}`,
        }, null, 2));
```

Also relax the arity gate near the top of the tool — one sighting is enough for a heading-only fit:

```ts
      if (p.sightings.length < 1) return errText("need at least one sighting to solve");
```

- [ ] **Step 4: Update `get_calibration`**

Replace the `sightings: p.sightings,` line and add a `fit` block:

```ts
        sightings: p.sightings.map((s, i) => ({
          id: s.id ?? null,
          label: s.label ?? null,
          at_iso: s.atIso ?? null,
          pan_deg: Number(s.panDeg.toFixed(3)),
          tilt_deg: Number(s.tiltDeg.toFixed(3)),
          residual_deg: fit ? Number(fit.residualsDeg[i].toFixed(2)) : null,
          rejected: fit ? fit.rejected[i] : false,
        })),
        fit: fit === null ? null : {
          stage: fit.stage,
          used_count: fit.usedCount,
          heading_sigma_deg: Number(fit.headingSigmaDeg.toFixed(3)),
          chead_sigma_deg: fit.cHeadSigmaDeg === null ? null : Number(fit.cHeadSigmaDeg.toFixed(3)),
          camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, fit.cHead[1])))).toFixed(2)),
          tilt_spread_deg: Number(fit.tiltSpreadDeg.toFixed(1)),
          rms_deg: Number(fit.rmsDeg.toFixed(3)),
          base_lean_deg: Number(fit.baseLeanDeg.toFixed(2)),
        },
```

with `const fit = store.getLastFit();` added beside the existing `const imu = store.getImuMounting();`.

- [ ] **Step 5: Add the two management tools**

Register beside `clear_calibration`:

```ts
  server.registerTool(
    "remove_sighting",
    {
      description: "Delete one calibration sighting by id (see get_calibration) and re-solve from the rest.",
      inputSchema: { id: z.string().min(1).describe("sighting id from get_calibration") },
    },
    async ({ id }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (!store.removeSighting(id)) return errText(`no sighting with id ${id}`);
      const fit = store.getLastFit();
      return text(JSON.stringify({
        removed: id,
        remaining: store.get().sightings.length,
        stage: fit?.stage ?? null,
      }));
    },
  );

  server.registerTool(
    "clear_sightings",
    {
      description: "Delete every calibration sighting, keeping the rig location and IMU characterization. Use after physically moving the rig.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      store.clearSightings();
      return text(JSON.stringify({ cleared: true, remaining: 0 }));
    },
  );
```

- [ ] **Step 6: Record `sigmaDeg` in `sight_aircraft`**

In `sight_aircraft`, replace the `store.addSighting({...})` call:

```ts
      // 1σ angular error for this sighting: the operator's centring error,
      // plus the residual position uncertainty after extrapolation converted
      // to an angle at this range. A close, fast, stale target is worth less
      // than a distant, fresh one, and the fit weights accordingly.
      const OPERATOR_AIM_SIGMA_DEG = 0.5;
      const speedMs = (ac.gsKt ?? 250) * 0.514444;
      const residualAgeSec = Math.max(0.5, extrap.positionAgeSec * 0.25);
      const posSigmaM = speedMs * residualAgeSec;
      const rangeMeters = rangeM(rig, extrap.geodetic);
      const sigmaDeg = Math.hypot(
        OPERATOR_AIM_SIGMA_DEG,
        rangeMeters > 1 ? rad2deg(posSigmaM / rangeMeters) : OPERATOR_AIM_SIGMA_DEG,
      );
      const slot = store.addSighting({
        lat: extrap.geodetic.lat, lon: extrap.geodetic.lon, height: extrap.geodetic.height,
        label, panDeg, tiltDeg, sigmaDeg,
      });
```

`rig` here is `store.get().rig!` — bind it above the call if the surrounding scope does not already have it.

Then delete the `if (slot === 2) { ... }` separation block entirely, including the `store.replaceSightings([a])` undo: with N sightings there is no degenerate *pair* to refuse, and the conditioning gate now reports the same information as a real number. Replace the note string:

```ts
        note: `${slot} sighting(s) recorded.${moveWarn}`,
```

Do the same `note` change in `sight_landmark` (it reads `${slot}/2 sightings recorded.`).

- [ ] **Step 7: Delete the dead solver**

From `tb3-mcp/src/geo/imu-orientation.ts` remove `solveCalibrationWithGravity`, the `GravityCalibration` interface and the `GravitySighting` interface if nothing else imports them (`solveNorthZero`, `solveImuMounting`, `dBaseFromGravity`, `boresightToEnu`, `enuToPanTiltOffset*`, `rotAlign` all stay). Remove the now-unused imports from `geo-tools.ts`.

In `tb3-mcp/test/imu-calibration-solve.test.ts`, delete the `describe("solveCalibrationWithGravity", ...)` block — it pins `cHead = [-0.52, 0.735, 0.434]`, a 47°-off-forward camera, as a "golden result". That expectation encodes the bug. Keep the `solveImuMounting` coverage in that file. Then add, in `test/calibration-fit.test.ts`, a case that runs the same `test/fixtures/imu-calib-field.json` sightings through `fitCalibration` and asserts `stage === "heading-only"`.

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS. Fix any other call sites the compiler flags.

- [ ] **Step 9: Commit**

```bash
git add tb3-mcp/src tb3-mcp/test
git commit -m "feat(calib): rewire the tools onto the N-sighting fit

solve_calibration keeps the live gravity read as the base re-anchoring
step, then delegates to the store's single re-solve path. It now reports
stage, both parameter sigmas, tilt spread and rms instead of
headingResidualDeg, which read a healthy 1.15 degrees while the answer
was 43 degrees wrong.

Adds remove_sighting/clear_sightings, records a per-sighting sigma from
range, speed and report age, and deletes the two-sighting solver along
with the golden test that pinned its 47-degree camera offset as correct."
```

---

### Task 5: Reachability against taught limits

**Files:**
- Modify: `tb3-mcp/src/adsb/enrich.ts`
- Modify: `tb3-mcp/src/adsb-tools.ts`
- Modify: `tb3-mcp/src/server.ts`
- Test: `tb3-mcp/test/adsb-enrich.test.ts`

**Interfaces:**
- Consumes: `effectiveLimits`, `TaughtEdges` from `src/limits-store.js`.
- Produces: `enrichAircraft(ac, rig, R, cfg, nowMs, sector?, cHead?, limits?)`; `scanAircraft(snap, rig, R, cfg, nowMs, p, sector?, cHead?, limits?)`.

- [ ] **Step 1: Write the failing test**

Add to `tb3-mcp/test/adsb-enrich.test.ts`:

```ts
it("marks a high-elevation target unreachable when taught limits are tighter than config", () => {
  // Config allows tilt to 90; the taught ceiling is 40. A target that needs
  // ~60° of tilt must come back unreachable, because that is what the
  // tracking session will decide.
  const enriched = enrichAircraft(
    highTarget, rig, R, cfg, NOW, DISABLED_SECTOR, [0, 1, 0],
    { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 40 },
  );
  expect(enriched!.reachable).toBe(false);
});
```

Build `highTarget` from the fixtures already in that file, positioned near-overhead.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/adsb-enrich.test.ts`
Expected: FAIL — `enrichAircraft` takes 7 parameters and ignores the 8th, returning `reachable: true`.

- [ ] **Step 3: Thread the limits through**

In `tb3-mcp/src/adsb/enrich.ts`, add a trailing defaulted parameter to `enrichAircraft`, `isTrackableAt` and `estimateTrackSec`, replacing every `limitsOf(cfg)` / `cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax` use inside them:

```ts
export function enrichAircraft(
  ac: Aircraft, rig: Geodetic, R: Mat3 | null, cfg: Config, nowMs: number,
  sector: TrackSector = DISABLED_SECTOR,
  cHead: Vec3 = [0, 1, 0],
  // The EFFECTIVE (taught-or-config) range. Defaults to the config ceiling so
  // every existing caller and test keeps its exact prior behaviour. Production
  // callers pass the taught range, because that is what TrackingSession and
  // SunSupervisor enforce — a row that says [Track] and then parks the session
  // in waiting/below_tilt_limit is a promise the tracker cannot keep.
  limits: { panMin: number; panMax: number; tiltMin: number; tiltMax: number } = limitsOf(cfg),
): EnrichedAircraft | null {
```

and inside:

```ts
    const { panDeg, tiltDeg } = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limits);
    const reach = reachablePanTilt(panDeg, tiltDeg, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    reachable = !("error" in reach);
    estTrackSec = estimateTrackSec(enu, vel, R, cfg, sEnu, slewOk, cHead, limits);
```

Mirror the same trailing parameter on `scanAircraft` in `tb3-mcp/src/adsb-tools.ts` and pass it into `enrichAircraft`.

- [ ] **Step 4: Supply the taught limits at the call sites**

`registerAdsbTools` gains a `limitsProvider: () => TaughtEdges` parameter (defaulting to `() => ({})`, matching how `TrackingSession` and `SunSupervisor` already take theirs), and both `scan_aircraft` and `track_aircraft` pass:

```ts
        effectiveLimits(
          { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax },
          limitsProvider(),
        )
```

In `tb3-mcp/src/server.ts`, pass the same provider already handed to `TrackingSession` into `registerAdsbTools`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src tb3-mcp/test
git commit -m "fix(adsb): judge reachability against taught limits, not the config ceiling

enrichAircraft used cfg.panMin/panMax/tiltMin/tiltMax (+/-180, +/-90) while
TrackingSession and SunSupervisor both use effectiveLimits(). On this rig
the taught tilt ceiling is 53.6 degrees, so rows offered [Track] and the
session then sat in waiting/below_tilt_limit."
```

---

### Task 6: Daemon-side range filter

**Files:**
- Create: `tb3-mcp/src/range-store.ts`
- Create: `tb3-mcp/src/range-tools.ts`
- Modify: `tb3-mcp/src/config.ts`, `tb3-mcp/src/adsb-tools.ts`, `tb3-mcp/src/server.ts`
- Test: `tb3-mcp/test/range-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class RangeStore { load(); get(): number; set(km: number): void }`; `registerRangeTools(server, store)` exposing `get_track_range`/`set_track_range`; config key `trackMaxRangeKm` (default 25).

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/range-store.test.ts`, mirroring the structure of the existing sector-store test:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { RangeStore } from "../src/range-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3rng-"));
  return join(dir, "sub", "range.json");
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

describe("RangeStore", () => {
  it("returns the default when no file exists", () => {
    const s = new RangeStore(tmpFile(), 25);
    s.load();
    expect(s.get()).toBe(25);
  });

  it("persists and reloads a set value", () => {
    const f = tmpFile();
    const a = new RangeStore(f, 25);
    a.set(12);
    const b = new RangeStore(f, 25);
    b.load();
    expect(b.get()).toBe(12);
  });

  it("falls back to the default on a corrupt file", () => {
    const f = tmpFile();
    const a = new RangeStore(f, 25);
    a.set(12);
    require("node:fs").writeFileSync(f, "{ not json");
    const b = new RangeStore(f, 25);
    b.load();
    expect(b.get()).toBe(25);
  });

  it("rejects a non-positive range", () => {
    const s = new RangeStore(tmpFile(), 25);
    expect(() => s.set(0)).toThrow();
    expect(() => s.set(-5)).toThrow();
  });
});
```

Replace the inline `require` with a top-level `import { writeFileSync } from "node:fs";`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/range-store.test.ts`
Expected: FAIL — cannot resolve `../src/range-store.js`.

- [ ] **Step 3: Implement the store**

Create `tb3-mcp/src/range-store.ts`:

```ts
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const RangeSchema = z.object({ maxRangeKm: z.number().positive() });

/**
 * The operator's maximum tracking range, in km. Daemon-side rather than
 * dashboard-side on purpose: the autonomous agent runs in its own process and
 * must apply the same bound the operator set in the browser, so this has to be
 * one shared source of truth. Same shape as SectorStore.
 */
export class RangeStore {
  private maxRangeKm: number;
  constructor(private readonly filePath: string, private readonly defaultKm: number) {
    this.maxRangeKm = defaultKm;
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.maxRangeKm = this.defaultKm; return; }
      this.maxRangeKm = RangeSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))).maxRangeKm;
    } catch {
      this.maxRangeKm = this.defaultKm;   // missing/corrupt → default; never throw
    }
  }

  get(): number { return this.maxRangeKm; }

  set(km: number): void {
    const parsed = RangeSchema.parse({ maxRangeKm: km });
    this.maxRangeKm = parsed.maxRangeKm;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ maxRangeKm: this.maxRangeKm }, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
```

- [ ] **Step 4: Implement the tools**

Create `tb3-mcp/src/range-tools.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RangeStore } from "./range-store.js";
import { text } from "./tool-helpers.js";

export function registerRangeTools(server: McpServer, rangeStore: RangeStore): void {
  server.registerTool(
    "get_track_range",
    { description: "Report the maximum slant range (km) an aircraft may be at to count as trackable.", inputSchema: {} },
    async () => text(JSON.stringify({ max_range_km: rangeStore.get() })),
  );
  server.registerTool(
    "set_track_range",
    {
      description: "Set the maximum slant range (km) for trackability. Aircraft beyond it are excluded from the trackable list and from autonomous selection; the map still shows them.",
      inputSchema: { max_range_km: z.number().positive().max(500).describe("max slant range in km") },
    },
    async ({ max_range_km }) => {
      rangeStore.set(max_range_km);
      return text(JSON.stringify({ max_range_km: rangeStore.get() }));
    },
  );
}
```

- [ ] **Step 5: Add the config key**

In `tb3-mcp/src/config.ts`, beside `adsbMaxRangeKm`:

```ts
    // Operator-facing trackability bound, distinct from adsbMaxRangeKm (which
    // is the outer bound on what the feed is parsed for at all). Persisted and
    // adjustable at runtime via set_track_range; this is only the initial value.
    trackMaxRangeKm: z.number().positive().default(25),
    rangeFile: z.string().optional(),
```

and in `loadConfig`:

```ts
  set("trackMaxRangeKm", num(env.TB3_TRACK_MAX_RANGE_KM));
  set("rangeFile", env.TB3_RANGE_FILE);
```

- [ ] **Step 6: Apply it to trackability**

In `tb3-mcp/src/adsb-tools.ts`, `registerAdsbTools` gains a `rangeStore: RangeStore` parameter. `scan_aircraft` uses it as the default when the caller supplies no explicit bound, and `track_aircraft` always applies it:

```ts
        maxRangeKm: max_range_km ?? rangeStore.get(),
```

```ts
        { maxRangeKm: rangeStore.get(), onlyTrackable: true, limit: 1000 },
```

In `tb3-mcp/src/server.ts`, construct and load it beside the sector store, and pass it to `registerAdsbTools` and `registerRangeTools`:

```ts
  const rangeFile = cfg.rangeFile ?? join(homedir(), ".tb3-mcp", "range.json");
  const rangeStore = new RangeStore(rangeFile, cfg.trackMaxRangeKm);
  rangeStore.load();
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tb3-mcp/src tb3-mcp/test
git commit -m "feat(adsb): daemon-side max tracking range

The dashboard slider has to bound the autonomous agent too, and the agent
runs in its own process, so the setting lives in the daemon behind
get_track_range/set_track_range -- the same shape SectorStore already
uses for the azimuth sector. Bounds trackability, not the map."
```

---

### Task 7: Nearest-first target selection

**Files:**
- Modify: `tb3-mcp/src/agent/loop.ts`, `tb3-mcp/src/agent/decide.ts`, `tb3-mcp/src/agent/agent.ts`
- Delete: `tb3-mcp/src/agent/llm.ts`
- Modify: `tb3-mcp/src/config.ts`
- Test: `tb3-mcp/test/adsb-follower.test.ts` or a new `tb3-mcp/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `scanAircraft`'s nearest-first ordering.
- Produces: `selectNearest(trackable, currentHex, switchMarginFraction) => string | null`; `runOnce` no longer takes a `choose` dependency; `AircraftBrief` moves into `loop.ts`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/agent-loop.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectNearest } from "../src/agent/loop.js";

const ac = (hex: string, rangeKm: number) => ({ hex, range_km: rangeKm } as never);

describe("selectNearest", () => {
  it("picks the nearest when nothing is tracked", () => {
    expect(selectNearest([ac("aaa", 30), ac("bbb", 8), ac("ccc", 19)], null, 0.2)).toBe("bbb");
  });

  it("holds the current target against a marginally closer one", () => {
    // 11.0 vs 12.0 is only 8% closer — under the 20% margin, so hold.
    expect(selectNearest([ac("aaa", 11), ac("bbb", 12)], "bbb", 0.2)).toBe("bbb");
  });

  it("switches when a candidate is decisively closer", () => {
    expect(selectNearest([ac("aaa", 4), ac("bbb", 12)], "bbb", 0.2)).toBe("aaa");
  });

  it("drops a target that is no longer trackable", () => {
    expect(selectNearest([ac("aaa", 30)], "bbb", 0.2)).toBe("aaa");
  });

  it("returns null when nothing is trackable", () => {
    expect(selectNearest([], "bbb", 0.2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agent-loop.test.ts`
Expected: FAIL — `selectNearest` is not exported.

- [ ] **Step 3: Rewrite `loop.ts`**

Replace `tb3-mcp/src/agent/loop.ts`:

```ts
import { Action, decideAction, failSafeAction } from "./decide.js";

/** The subset of a scan_aircraft row the selector needs. */
export interface AircraftBrief {
  hex: string;
  callsign: string | null;
  range_km: number;
}

export interface RigMcpClient {
  scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]>;
  getTracked(): Promise<{ hex: string | null }>;
  getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }>;
  track(hex: string): Promise<void>;
  stop(): Promise<void>;
}

export interface LoopState { lastSwitchMs: number; }

export interface LoopDeps {
  client: RigMcpClient;
  cfg: { maxRangeKm: number; minDwellMs: number; switchMarginFraction: number };
  now: () => number;
}

/**
 * Nearest trackable aircraft, with hysteresis.
 *
 * A bare argmin would ping-pong between two aircraft a few hundred metres
 * apart in range, so a candidate must be closer than the current target by
 * `switchMarginFraction` before it wins. A current target that has left the
 * trackable list has no claim at all.
 */
export function selectNearest(
  trackable: AircraftBrief[], currentHex: string | null, switchMarginFraction: number,
): string | null {
  if (trackable.length === 0) return null;
  const nearest = trackable.reduce((a, b) => (b.range_km < a.range_km ? b : a));
  if (currentHex === null) return nearest.hex;
  const current = trackable.find((a) => a.hex.toLowerCase() === currentHex.toLowerCase());
  if (!current) return nearest.hex;                     // no longer trackable
  if (nearest.hex.toLowerCase() === currentHex.toLowerCase()) return current.hex;
  return nearest.range_km < current.range_km * (1 - switchMarginFraction) ? nearest.hex : current.hex;
}

export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  const trackable = await deps.client.scanAircraft({ maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, limit: 20 });
  const tracked = await deps.client.getTracked();

  const trackableHexes = new Set(trackable.map((a) => a.hex.toLowerCase()));
  const currentHex = tracked.hex ? tracked.hex.toLowerCase() : null;
  const currentHealthy = currentHex !== null && trackableHexes.has(currentHex);

  let action: Action;
  try {
    const pick = selectNearest(trackable, currentHex, deps.cfg.switchMarginFraction);
    action = pick === null
      ? failSafeAction(currentHex, currentHealthy)
      : decideAction({
          decision: { action: "track", hex: pick, reason: "nearest trackable" },
          trackableHexes, currentHex, currentHealthy,
          msSinceLastSwitch: deps.now() - state.lastSwitchMs, minDwellMs: deps.cfg.minDwellMs,
        });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  return { action, state: { lastSwitchMs } };
}
```

- [ ] **Step 4: Move the `Decision` type into `decide.ts`**

`decide.ts` currently imports `Decision` from `./llm.js`. Define it locally instead and drop the import:

```ts
export interface Decision {
  action: "track" | "keep" | "stop";
  hex?: string | null;
  reason: string;
}
```

- [ ] **Step 5: Update `agent.ts` and delete `llm.ts`**

In `tb3-mcp/src/agent/agent.ts`, remove the `chooseTarget` import and the `choose` dependency, and pass the new config:

```ts
      cfg: {
        maxRangeKm: cfg.trackMaxRangeKm,
        minDwellMs: cfg.agentMinDwellSec * 1000,
        switchMarginFraction: 0.2,
      },
```

Also drop the `LLM ${cfg.llmUrl}` text from the startup log line. Then:

```bash
git rm tb3-mcp/src/agent/llm.ts
```

Remove `llmUrl` and `llmModel` from `ConfigSchema` and their two `set(...)` lines in `loadConfig`. Zod strips unknown keys, so the values already present in the deployed `config.json` remain harmless.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS. Delete or rewrite any existing test that imports `llm.js`.

- [ ] **Step 7: Commit**

```bash
git add -A tb3-mcp/src tb3-mcp/test
git commit -m "feat(agent): nearest-first target selection

The LLM prompt ranked by interestingness and never mentioned range, so
the agent reliably chose distant traffic near the horizon over the close
overhead passes the operator actually wants. Selection is now the nearest
trackable aircraft, with a 20% switch margin so two aircraft at similar
range cannot ping-pong. Deletes llm.ts and the llmUrl/llmModel config."
```

---

### Task 8: Dashboard — sightings panel and range slider

**Files:**
- Modify: `tb3-mcp/src/dashboard/client.ts`, `tb3-mcp/src/dashboard/state.ts`, `tb3-mcp/src/dashboard/server.ts`, `tb3-mcp/src/dashboard/controls.ts`
- Modify: `tb3-mcp/dashboard/public/index.html`, `dashboard/public/step-gate.js`, `dashboard/public/minimap.js`
- Create: `tb3-mcp/dashboard/public/sightings.js`
- Test: `tb3-mcp/test/dashboard-aircraft.test.ts`

**Interfaces:**
- Consumes: `get_calibration`'s new `fit` and `sightings[]` shape (Task 4); `get_track_range`/`set_track_range` (Task 6).
- Produces: `DashboardState.calibration.fit`, `DashboardState.calibration.sightings` as typed rows, `DashboardState.range: { maxRangeKm: number }`.

- [ ] **Step 1: Extend the dashboard client**

Add Zod row/fit schemas to `client.ts` matching Task 4's output, plus `getTrackRange()`/`setTrackRange(km)` calling the Task 6 tools. Follow the existing non-strict-schema convention documented at the top of that file.

- [ ] **Step 2: Extend `DashboardState`**

In `state.ts`, replace `sightings: unknown[]` with a typed `SightingRow[]`, add the `fit` object, and add a top-level `range: { maxRangeKm: number }`. Thread both through `mergeState` following the existing collapsing-to-null convention for a failed poll leg.

- [ ] **Step 3: Add the control routes**

In `controls.ts`, add POST handlers for `set_track_range`, `remove_sighting` and `clear_sightings`, following the existing handler shape in that file.

- [ ] **Step 4: Build the sightings panel**

Create `dashboard/public/sightings.js` rendering one row per sighting: label, age from `at_iso`, pan/tilt, residual, a `rejected` badge, and a delete button wired to `remove_sighting`. Add a "clear all — rig moved" button wired to `clear_sightings`, behind a confirm. Show the fit summary above the list: stage, used count, tilt spread, rms, and — when `stage === "heading-only"` — the sentence explaining that more tilt spread is needed.

- [ ] **Step 5: Add the range slider and ring**

Add a range slider to the aircraft column in `index.html`, wired to `set_track_range`, showing the current km. In `minimap.js`, draw a ring at the current range so the bound is visible against the traffic that is still displayed beyond it.

- [ ] **Step 6: Update the step gate**

`step-gate.js` reads `heading_residual_deg` today. Point it at `fit.stage` and `fit.rms_deg`, and treat `heading-only` as a *complete but improvable* step rather than a failure — the rig tracks fine in that stage.

- [ ] **Step 7: Verify**

Run: `npm test`, then `npm run dashboard` locally and confirm the panel renders against a daemon. Expected: PASS, panel lists sightings with residuals, slider changes the list bound.

- [ ] **Step 8: Commit**

```bash
git add tb3-mcp/src/dashboard tb3-mcp/dashboard tb3-mcp/test
git commit -m "feat(dashboard): sightings panel, fit readout and range slider"
```

---

### Task 9: Build, verify and deploy

**Files:** none changed; this task ships what the previous eight built.

- [ ] **Step 1: Full local verification**

```bash
cd tb3-mcp && npm test && npm run build
```
Expected: all tests pass, `tsc` clean.

- [ ] **Step 2: Re-run the field diagnostic against the new code**

Confirm the stored profile now yields a sane pointing model — commanded tilt should track true elevation within ~2° across the sky, and nothing should be blocked below the taught 53.6° ceiling.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/n-sighting-calibration
```

- [ ] **Step 4: Deploy to the rig host**

```bash
ssh atomist@192.168.4.71 'cd ~/TB3-ESP32 && git fetch origin && git checkout feat/n-sighting-calibration && cd tb3-mcp && npm ci && npm run build'
```

The host carries uncommitted local edits to `tb3-mcp/deploy/*.service` and `config.json`. Those are load-bearing — **do not** check them out, stash them, or clean the tree. `git checkout <branch>` preserves them; if git refuses the branch switch because of a conflicting tracked file, stop and report rather than forcing it.

- [ ] **Step 5: Restart the services**

`sudo` on the host requires a password, so this step is the operator's:

```
sudo systemctl restart tb3-mcp tb3-dashboard
```

- [ ] **Step 6: Verify on the rig**

Confirm from the daemon that the calibration re-solved on startup:

```bash
ssh atomist@192.168.4.71 'python3 -c "import json;d=json.load(open(\"/home/atomist/.tb3-mcp/calibration.json\"));print(d[\"cHead\"])"'
```

Expected: `[0.0, 1.0, 0.0]` — the 43° value gone. Then check the dashboard shows `stage: heading-only`, and track one aircraft through a pass, watching that the pointing error stays within a few degrees instead of sweeping ±12°.

- [ ] **Step 7: Commit any deployment fixes and report**

Report the observed pointing error across a real pass, and whether high-elevation aircraft are now reachable.

---

## Notes for the operator

- After this lands, `TB3_MAX_AIM_OFFSET_DEG=35` in the host's systemd unit should come back to about `5`. It is almost certainly compensation for the broken calibration, and at 35 against a `trackReacquireDeg` of 10 a converged offset reads as a lost target. That file has uncommitted host-local edits, so it is yours to change.
- To reach `stage: "full"` and tighten past ~2°, sightings need real tilt spread — deliberately sight a **high, close** aircraft and a **low, distant** one. The current pair spans 8.25° of tilt; 30°+ is what makes the camera offset identifiable.
