# Reboot Re-zero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a rig's calibration and taught limits after a power cycle by solving two scalars (Δtilt from gravity, Δpan from a landmark) instead of re-running the whole calibration.

**Architecture:** The firmware does not persist step position, so every reboot moves the origin while the tripod, camera and IMU stay put. That perturbation folds exactly into `R` (pan) and `cHead` (tilt). A boot watcher detects the origin change, a gravity solve recovers Δtilt with no operator action, and a landmark or aircraft sighting recovers Δpan.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod schemas, Vitest, `@modelcontextprotocol/sdk`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-02-reboot-rezero-design.md`

## Global Constraints

- **No new npm dependencies.** Everything needed is already present.
- **Rotation convention is fixed by existing code:** `mountHeadRotation(panDeg, tiltDeg) = matMul(rotZ(deg2rad(-panDeg)), rotX(deg2rad(tiltDeg)))` in `src/geo/boresight.ts`. Note the **negative** on pan. Derive all fold-ins from this, never from intuition.
- **Boresight model:** `boresightEnu = matVec(matMul(R, mountHeadRotation(geoPanSign * panDeg, tiltDeg)), cHead)`.
- `Vec3` and `Mat3` are `readonly` tuples from `src/geo/vec3.ts`. Build new values, never mutate.
- **Rejection thresholds:** `MAX_TILT_RESIDUAL_DEG = 3.0`, `MAX_PAN_RESIDUAL_DEG = 3.0`.
- All new persisted schema fields are `.optional()` so profiles written before this change still parse.
- Tests run with `npx vitest run <file>` from `tb3-mcp/`.
- Typecheck with `npx tsc -p tsconfig.build.json --noEmit`. Pre-existing `TS7016` errors are expected; introduce no new error codes.
- Never bypass git hooks (`--no-verify` is blocked).

---

### Task 1: Pure re-zero math

The heart of the feature. Everything else is plumbing around these four functions.

**Files:**
- Create: `tb3-mcp/src/geo/rezero.ts`
- Test: `tb3-mcp/test/geo-rezero.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `rotX`, `rotZ`, `matMul`, `matVec`, `deg2rad`, `angleBetweenDeg`, `normalize` from `./vec3.js`; `mountHeadRotation` from `./boresight.js`; `dBaseFromGravity` from `./imu-orientation.js`.
- Produces:
  - `applyPanOffset(R: Mat3, deltaPanDeg: number, geoPanSign: number): Mat3`
  - `applyTiltOffset(cHead: Vec3, deltaTiltDeg: number): Vec3`
  - `solveTiltOffset(rS, dBaseStored, panDeg, tiltDeg, gravity, geoPanSign): { deltaTiltDeg: number; residualDeg: number }`
  - `solvePanOffset(R, cHead, geoPanSign, refEnu, panDeg, tiltDeg): { deltaPanDeg: number; residualDeg: number }`
  - `MAX_TILT_RESIDUAL_DEG`, `MAX_PAN_RESIDUAL_DEG`

**Why the fold-ins take this form** (state this in a comment; an implementer who guesses will get the sign wrong):

`Rz(a)·Rz(b) = Rz(a+b)` and rotations about a shared axis commute, so
`mountHeadRotation(gp·(pan+Δpan), tilt) = rotZ(-gp·Δpan) · mountHeadRotation(gp·pan, tilt)`.
Left-multiplying by `R` gives `R' = matMul(R, mountHeadRotation(gp·Δpan, 0))`, since
`mountHeadRotation(x, 0) = rotZ(-x)`.

For tilt, `Rx(tilt+Δtilt) = Rx(tilt)·Rx(Δtilt)`, and that trailing factor lands
immediately left of `cHead`, so `cHead' = matVec(rotX(deg2rad(Δtilt)), cHead)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/geo-rezero.test.ts
import { describe, it, expect } from "vitest";
import { Mat3, Vec3, matMul, matVec, normalize, angleBetweenDeg, rotX, rotZ, deg2rad } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";
import { dBaseFromGravity } from "../src/geo/imu-orientation.js";
import {
  applyPanOffset, applyTiltOffset, solveTiltOffset, solvePanOffset,
} from "../src/geo/rezero.js";

// A deliberately non-trivial mount orientation: yaw 20deg, small lean.
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C_HEAD: Vec3 = normalize([0.02, 0.99, 0.08]);
const R_S: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const GP = -1; // geoPanSign as configured on this rig

function boresight(R_: Mat3, cHead: Vec3, pan: number, tilt: number): Vec3 {
  return matVec(matMul(R_, mountHeadRotation(GP * pan, tilt)), cHead);
}

// Gravity the IMU would report at a posture, given a true base-down vector.
function gravityAt(dBase: Vec3, pan: number, tilt: number): Vec3 {
  // Invert dBaseFromGravity: g_s = R_s^T · M^T · d_base
  const M = mountHeadRotation(GP * pan, tilt);
  const Mt: Mat3 = [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
  const Rst: Mat3 = [[R_S[0][0], R_S[1][0], R_S[2][0]], [R_S[0][1], R_S[1][1], R_S[2][1]], [R_S[0][2], R_S[1][2], R_S[2][2]]];
  return matVec(matMul(Rst, Mt), dBase);
}

const D_BASE: Vec3 = normalize([-0.008, -0.024, -0.9997]);

describe("applyPanOffset / applyTiltOffset", () => {
  it("a pan offset folded into R equals reading pan shifted by that offset", () => {
    const dPan = 37.5;
    const truePan = -12, tilt = 21;
    // Rig now REPORTS (truePan - dPan) for the same physical posture.
    const reported = truePan - dPan;
    const folded = applyPanOffset(R, dPan, GP);
    expect(angleBetweenDeg(boresight(folded, C_HEAD, reported, tilt),
                           boresight(R, C_HEAD, truePan, tilt))).toBeLessThan(1e-6);
  });

  it("a tilt offset folded into cHead equals reading tilt shifted by that offset", () => {
    const dTilt = -14.25;
    const trueTilt = 30, pan = 5;
    const reported = trueTilt - dTilt;
    const folded = applyTiltOffset(C_HEAD, dTilt);
    expect(angleBetweenDeg(boresight(R, folded, pan, reported),
                           boresight(R, C_HEAD, pan, trueTilt))).toBeLessThan(1e-6);
  });
});

describe("solveTiltOffset", () => {
  it("recovers an injected tilt-origin shift", () => {
    for (const dTilt of [-42, -7.5, 0, 3.25, 23.33, 55]) {
      const truePan = 18, trueTilt = 12;
      const g = gravityAt(D_BASE, truePan, trueTilt);
      const reportedTilt = trueTilt - dTilt;
      const out = solveTiltOffset(R_S, D_BASE, truePan, reportedTilt, g, GP);
      expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
      expect(out.residualDeg).toBeLessThan(0.05);
    }
  });

  // The assumption the whole design rests on: gravity sees tilt, not pan.
  it("is insensitive to pan-origin error", () => {
    const truePan = 18, trueTilt = 12, dTilt = 23.33;
    const g = gravityAt(D_BASE, truePan, trueTilt);
    const clean = solveTiltOffset(R_S, D_BASE, truePan, trueTilt - dTilt, g, GP);
    for (const dPan of [-90, -20, 20, 90]) {
      const dirty = solveTiltOffset(R_S, D_BASE, truePan - dPan, trueTilt - dTilt, g, GP);
      expect(Math.abs(dirty.deltaTiltDeg - clean.deltaTiltDeg)).toBeLessThan(0.5);
    }
  });

  it("reports a large residual when the tripod itself moved", () => {
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]); // ~21deg of real base lean change
    const g = gravityAt(moved, 18, 12);
    const out = solveTiltOffset(R_S, D_BASE, 18, 12, g, GP);
    expect(out.residualDeg).toBeGreaterThan(3.0);
  });
});

describe("solvePanOffset", () => {
  it("recovers an injected pan-origin shift", () => {
    for (const dPan of [-150, -33, 0, 16.4, 78, 150]) {
      const truePan = -25, tilt = 19;
      const refEnu = boresight(R, C_HEAD, truePan, tilt);
      const out = solvePanOffset(R, C_HEAD, GP, refEnu, truePan - dPan, tilt);
      expect(out.deltaPanDeg).toBeCloseTo(dPan, 1);
      expect(out.residualDeg).toBeLessThan(0.05);
    }
  });

  it("round-trips: solved offsets restore pointing for an independent target", () => {
    const dPan = 16.4, dTilt = 23.33;
    const gTrue = gravityAt(D_BASE, 40, 8);
    const t = solveTiltOffset(R_S, D_BASE, 40, 8 - dTilt, gTrue, GP);
    const cHead2 = applyTiltOffset(C_HEAD, t.deltaTiltDeg);
    const refEnu = boresight(R, C_HEAD, -25, 19);
    const p = solvePanOffset(R, cHead2, GP, refEnu, -25 - dPan, 19 - dTilt + t.deltaTiltDeg);
    const R2 = applyPanOffset(R, p.deltaPanDeg, GP);
    // An INDEPENDENT posture must now point where it did before the reboot.
    const before = boresight(R, C_HEAD, 60, 33);
    const after = boresight(R2, cHead2, 60 - dPan, 33 - dTilt);
    expect(angleBetweenDeg(before, after)).toBeLessThan(0.2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/geo-rezero.test.ts`
Expected: FAIL — cannot resolve `../src/geo/rezero.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/geo/rezero.ts
//
// Reboot re-zero: recovering a lost step origin without recalibrating.
//
// The firmware does not persist step position, so every power cycle (and every
// OTA flash, which reboots the ESP32) moves the origin while the tripod, the
// camera on the head and the IMU on the mount all stay put. That perturbation
// is exactly two scalars, and it folds into the existing calibration rather
// than invalidating it.
import {
  Mat3, Vec3, rotX, matMul, matVec, deg2rad, angleBetweenDeg, normalize,
} from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { dBaseFromGravity } from "./imu-orientation.js";

// Above this the "only the origin moved" assumption is false -- the tripod was
// disturbed, or rS is stale. Applying an offset then would bake in a wrong
// answer that looks precise, so callers must fall back to full recalibration.
export const MAX_TILT_RESIDUAL_DEG = 3.0;
export const MAX_PAN_RESIDUAL_DEG = 3.0;

// boresight = R · M(gp·pan, tilt) · cHead, with
// M(pan,tilt) = mountHeadRotation = rotZ(-pan)·rotX(tilt)  -- note the NEGATIVE pan.
//
// Rotations about a shared axis commute, so
//   M(gp·(pan+d), tilt) = rotZ(-gp·d) · M(gp·pan, tilt)
// and rotZ(-gp·d) is exactly mountHeadRotation(gp·d, 0). Left-multiplying by R:
export function applyPanOffset(R: Mat3, deltaPanDeg: number, geoPanSign: number): Mat3 {
  return matMul(R, mountHeadRotation(geoPanSign * deltaPanDeg, 0));
}

// Rx(tilt+d) = Rx(tilt)·Rx(d), and that trailing factor sits immediately left
// of cHead, so the tilt offset is absorbed by the boresight vector itself.
export function applyTiltOffset(cHead: Vec3, deltaTiltDeg: number): Vec3 {
  return normalize(matVec(rotX(deg2rad(deltaTiltDeg)), cHead));
}

// Coarse sweep then golden-section refine. The objective is the angle between a
// fixed vector and one rotated about a single axis, so it has one minimum over
// the interval; the coarse pass exists only to land inside the right basin.
function minimise(f: (x: number) => number, lo: number, hi: number, coarseStep: number):
  { x: number; f: number } {
  let bx = lo, bf = f(lo);
  for (let x = lo + coarseStep; x <= hi; x += coarseStep) {
    const v = f(x);
    if (v < bf) { bf = v; bx = x; }
  }
  let a = bx - coarseStep, b = bx + coarseStep;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < 80 && b - a > 1e-4; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
  }
  const x = (a + b) / 2;
  return { x, f: f(x) };
}

// Delta-tilt from ONE gravity read. Needs no operator action: gravity is
// absolute, and rS/dBase are still valid because neither the sensor nor the
// tripod moved. dBase lies almost along the pan axis, so this is nearly
// independent of any pan-origin error -- see the decoupling test.
export function solveTiltOffset(
  rS: Mat3, dBaseStored: Vec3, panDeg: number, tiltDeg: number,
  gravity: Vec3, geoPanSign: number,
): { deltaTiltDeg: number; residualDeg: number } {
  const f = (d: number) =>
    angleBetweenDeg(dBaseFromGravity(rS, panDeg, tiltDeg + d, gravity, geoPanSign), dBaseStored);
  const { x, f: r } = minimise(f, -90, 90, 1);
  return { deltaTiltDeg: x, residualDeg: r };
}

// Delta-pan from a reference of known ENU direction, centred by the operator.
// Callers MUST pass a tiltDeg already corrected by deltaTilt, so this is
// genuinely one unknown.
export function solvePanOffset(
  R: Mat3, cHead: Vec3, geoPanSign: number,
  refEnu: Vec3, panDeg: number, tiltDeg: number,
): { deltaPanDeg: number; residualDeg: number } {
  const f = (d: number) => {
    const b = matVec(matMul(applyPanOffset(R, d, geoPanSign),
                            mountHeadRotation(geoPanSign * panDeg, tiltDeg)), cHead);
    return angleBetweenDeg(b, refEnu);
  };
  const { x, f: r } = minimise(f, -180, 180, 1);
  return { deltaPanDeg: x, residualDeg: r };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tb3-mcp && npx vitest run test/geo-rezero.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Prove the tests are load-bearing**

Change `applyPanOffset` to `matMul(R, mountHeadRotation(-geoPanSign * deltaPanDeg, 0))` (flip the sign) and re-run. The pan and round-trip tests MUST fail. Revert.

This is the mutation that matters: a sign error here produces a *mirrored* mapping rather than an offset, which is exactly the `geoPanSign` class of bug that cost a full session on 2026-08-02.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/geo/rezero.ts tb3-mcp/test/geo-rezero.test.ts
git commit -m "feat(rezero): solve pan/tilt origin offsets after a reboot"
```

---

### Task 2: Calibration profile fields

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts` (append; create if absent)

**Interfaces:**
- Produces on `CalibrationStore`:
  - `getBootId(): number | undefined`
  - `markRezeroNeeded(bootId: number): void`
  - `needsRezero(): boolean`
  - `setLandmark(l: Landmark): void` / `getLandmark(): Landmark | undefined`
  - `applyRezero(R: Mat3, cHead: Vec3, bootId: number): void` — sets both, clears `needsRezero`, stamps `bootId`
- `export interface Landmark { label: string; enu: Vec3; panDeg: number; tiltDeg: number; recordedAt: string }`

- [ ] **Step 1: Write the failing test**

```ts
// append to tb3-mcp/test/calibration.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { Mat3, Vec3 } from "../src/geo/vec3.js";

function store(): CalibrationStore {
  const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
  s.load();
  return s;
}
const I: Mat3 = [[1,0,0],[0,1,0],[0,0,1]];

describe("re-zero profile fields", () => {
  it("markRezeroNeeded sets the flag and stamps the boot id", () => {
    const s = store();
    expect(s.needsRezero()).toBe(false);
    s.markRezeroNeeded(7);
    expect(s.needsRezero()).toBe(true);
    expect(s.getBootId()).toBe(7);
  });

  it("applyRezero clears the flag and persists orientation and cHead", () => {
    const s = store();
    s.markRezeroNeeded(7);
    const c: Vec3 = [0, 1, 0];
    s.applyRezero(I, c, 7);
    expect(s.needsRezero()).toBe(false);
    expect(s.getOrientation()).toEqual(I);
    expect(s.getCHead()).toEqual(c);
  });

  it("a landmark round-trips through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    const a = new CalibrationStore(path); a.load();
    a.setLandmark({ label: "south tower", enu: [0, 1, 0], panDeg: 12, tiltDeg: 3, recordedAt: "2026-08-02T00:00:00Z" });
    const b = new CalibrationStore(path); b.load();
    expect(b.getLandmark()?.label).toBe("south tower");
    expect(b.getLandmark()?.enu).toEqual([0, 1, 0]);
  });

  it("a profile written before these fields existed still parses", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    writeFileSync(path, JSON.stringify({ version: 1, sightings: [] }));
    const s = new CalibrationStore(path);
    expect(() => s.load()).not.toThrow();
    expect(s.needsRezero()).toBe(false);
  });
});
```

Add `import { writeFileSync } from "node:fs";` to the test imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: FAIL — `markRezeroNeeded is not a function`.

- [ ] **Step 3: Implement**

In `ProfileSchema`, after `cHead`:

```ts
  // Origin generation this profile was solved under. The firmware does not
  // persist step position, so a reboot silently moves the origin; comparing
  // this against the live bootId is what makes that visible in the file
  // itself rather than inferred at read time.
  bootId: z.number().optional(),
  needsRezero: z.boolean().optional(),
  // A fixed distant object recorded while calibration was trusted. Stored as
  // an ENU DIRECTION, not lat/lon: a terrestrial reference only needs a
  // bearing, and requiring the operator to know a tower's coordinates would
  // make the feature unusable.
  landmark: z.object({
    label: z.string(),
    enu: z.array(z.number()).length(3),
    panDeg: z.number(), tiltDeg: z.number(),
    recordedAt: z.string(),
  }).optional(),
```

Add the exported type and methods:

```ts
export interface Landmark {
  label: string; enu: Vec3; panDeg: number; tiltDeg: number; recordedAt: string;
}

  getBootId(): number | undefined { return this.profile.bootId; }

  needsRezero(): boolean { return this.profile.needsRezero === true; }

  markRezeroNeeded(bootId: number): void {
    this.profile = { ...this.profile, bootId, needsRezero: true };
    this.save();
  }

  setLandmark(l: Landmark): void {
    this.profile = { ...this.profile, landmark: { ...l, enu: [l.enu[0], l.enu[1], l.enu[2]] } };
    this.save();
  }

  getLandmark(): Landmark | undefined {
    const l = this.profile.landmark;
    if (!l) return undefined;
    return { label: l.label, enu: [l.enu[0], l.enu[1], l.enu[2]], panDeg: l.panDeg, tiltDeg: l.tiltDeg, recordedAt: l.recordedAt };
  }

  // Both offsets land at once: applying one without the other leaves the rig
  // in a state that is neither the old calibration nor a valid new one.
  applyRezero(R: Mat3, cHead: Vec3, bootId: number): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, cHead: [cHead[0], cHead[1], cHead[2]],
      bootId, needsRezero: undefined,
    };
    this.save();
  }
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/test/calibration.test.ts
git commit -m "feat(rezero): bootId, needsRezero and landmark on the calibration profile"
```

---

### Task 3: Limits store — boot stamp and edge shifting

**Files:**
- Modify: `tb3-mcp/src/limits-store.ts`
- Test: `tb3-mcp/test/limits-store.test.ts` (append; create if absent)

**Interfaces:**
- Produces: `LimitsStore.getBootId(): number | undefined`, `LimitsStore.setBootId(id: number): void`, `LimitsStore.shiftAxis(axis: "pan" | "tilt", deltaDeg: number): void`, `LimitsStore.clearAxis(axis: "pan" | "tilt"): void`

- [ ] **Step 1: Write the failing test**

```ts
// append to tb3-mcp/test/limits-store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsStore } from "../src/limits-store.js";

function store(): LimitsStore {
  const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json"));
  s.load();
  return s;
}

describe("re-zero limit maintenance", () => {
  it("shiftAxis moves only the named axis", () => {
    const s = store();
    s.setEdge("panMin", -90); s.setEdge("panMax", 36);
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    s.shiftAxis("tilt", 23.33);
    expect(s.get().tiltMin).toBeCloseTo(3.33, 6);
    expect(s.get().tiltMax).toBeCloseTo(57.33, 6);
    expect(s.get().panMin).toBe(-90);
    expect(s.get().panMax).toBe(36);
  });

  it("clearAxis drops one axis and leaves the other taught", () => {
    const s = store();
    s.setEdge("panMin", -90); s.setEdge("tiltMin", -20);
    s.clearAxis("pan");
    expect(s.get().panMin).toBeUndefined();
    expect(s.get().tiltMin).toBe(-20);
  });

  it("shiftAxis on an untaught axis is a no-op, not a NaN", () => {
    const s = store();
    s.shiftAxis("pan", 10);
    expect(s.get().panMin).toBeUndefined();
    expect(s.get().panMax).toBeUndefined();
  });

  it("shifting preserves where the rig sits relative to its limits", () => {
    // The escape guarantee in track/control.ts's axisBlocked depends only on
    // where `cur` sits relative to min/max -- it permits the direction that
    // moves back into range. Shifting both edges by the same offset preserves
    // that relationship exactly, so a rig parked outside its range before the
    // shift is still outside, and still able to escape, after it.
    const s = store();
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    const before = -28.64;              // measured 2026-08-02: parked below tiltMin
    const d = 23.33;
    s.shiftAxis("tilt", d);
    expect(before < -20).toBe(true);
    expect(before + d < (s.get().tiltMin as number)).toBe(true);
    expect((s.get().tiltMax as number) - (s.get().tiltMin as number)).toBeCloseTo(54, 6);
  });

  it("bootId round-trips", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json");
    const a = new LimitsStore(path); a.load(); a.setBootId(4);
    const b = new LimitsStore(path); b.load();
    expect(b.getBootId()).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/limits-store.test.ts`
Expected: FAIL — `shiftAxis is not a function`.

- [ ] **Step 3: Implement**

Add `bootId: z.number().optional()` to `TaughtLimitsSchema`, then:

```ts
  getBootId(): number | undefined { return this.limits.bootId; }

  setBootId(id: number): void {
    this.limits = { ...this.limits, bootId: id };
    this.save();
  }

  // Taught limits are stored in degrees against a step origin the firmware
  // does not persist. Once the origin shift is known, the limits move with it
  // -- so a reboot does not cost the operator a re-teach.
  shiftAxis(axis: "pan" | "tilt", deltaDeg: number): void {
    const lo = axis === "pan" ? "panMin" : "tiltMin";
    const hi = axis === "pan" ? "panMax" : "tiltMax";
    const next = { ...this.limits };
    if (next[lo] !== undefined) next[lo] = (next[lo] as number) + deltaDeg;
    if (next[hi] !== undefined) next[hi] = (next[hi] as number) + deltaDeg;
    this.limits = next;
    this.save();
  }

  // Used when an axis's origin shift is not yet known. A stale limit is worse
  // than none: it can block escape in one direction while permitting a drive
  // into the hard stop in the other.
  clearAxis(axis: "pan" | "tilt"): void {
    const next = { ...this.limits };
    if (axis === "pan") { delete next.panMin; delete next.panMax; }
    else { delete next.tiltMin; delete next.tiltMax; }
    this.limits = next;
    this.save();
  }
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/limits-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/limits-store.ts tb3-mcp/test/limits-store.test.ts
git commit -m "feat(rezero): shift and clear taught limits per axis, stamp bootId"
```

---

### Task 4: Boot watcher

**Files:**
- Create: `tb3-mcp/src/boot-watch.ts`
- Test: `tb3-mcp/test/boot-watch.test.ts`

**Interfaces:**
- Produces:
  - `export interface BootState { bootId: number; lastUptimeMs: number; lastSeenAtMs: number }`
  - `export function detectBoot(prev: BootState | undefined, uptimeMs: number, nowMs: number): { state: BootState; rebooted: boolean }`
  - `export class BootWatcher { constructor(filePath: string); load(): void; observe(uptimeMs: number, nowMs: number): boolean; bootId(): number }`

`detectBoot` is pure so the two reboot cases can be tested without files or a device.

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/boot-watch.test.ts
import { describe, it, expect } from "vitest";
import { detectBoot, BootState } from "../src/boot-watch.js";

describe("detectBoot", () => {
  it("first ever observation is not a reboot", () => {
    const r = detectBoot(undefined, 5_000, 1_000_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(1);
  });

  it("uptime going backwards is a reboot", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    const r = detectBoot(prev, 4_000, 1_010_000);
    expect(r.rebooted).toBe(true);
    expect(r.state.bootId).toBe(2);
  });

  it("uptime advancing normally is not a reboot", () => {
    const prev: BootState = { bootId: 3, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    const r = detectBoot(prev, 910_000, 1_010_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(3);
  });

  // The case polling alone cannot see: the daemon was down across the reboot.
  it("detects a reboot that happened while the daemon was not watching", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    // 10 minutes of wall clock elapsed, but the device claims only 30s of uptime.
    const r = detectBoot(prev, 30_000, 1_000_000 + 600_000);
    expect(r.rebooted).toBe(true);
    expect(r.state.bootId).toBe(2);
  });

  it("does not false-positive when the daemon restarts but the device did not", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    // 60s elapsed, uptime advanced by ~60s: same boot.
    const r = detectBoot(prev, 960_000, 1_060_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/boot-watch.test.ts`
Expected: FAIL — cannot resolve `../src/boot-watch.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/boot-watch.ts
//
// Detects that the device's step origin has been lost.
//
// The firmware does not persist step position: current_steps starts at zero
// wherever the head physically sits at boot. Every power cycle and every OTA
// flash therefore invalidates the taught limits and the calibration, and until
// this existed nothing noticed -- on 2026-08-02 the guard drove tilt into its
// mechanical stop while enforcing the previous origin's numbers.
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface BootState { bootId: number; lastUptimeMs: number; lastSeenAtMs: number }

// Wall-clock slack before "elapsed exceeds uptime" counts as an unobserved
// reboot. Absorbs poll jitter and small clock steps; well under any real
// power cycle, which shows up as minutes of discrepancy.
const UNOBSERVED_SLACK_MS = 30_000;

export function detectBoot(
  prev: BootState | undefined, uptimeMs: number, nowMs: number,
): { state: BootState; rebooted: boolean } {
  if (!prev) return { state: { bootId: 1, lastUptimeMs: uptimeMs, lastSeenAtMs: nowMs }, rebooted: false };

  // Case 1: we watched it happen -- uptime went backwards.
  const wentBackwards = uptimeMs < prev.lastUptimeMs;
  // Case 2: we were down across it. The device has been up for less time than
  // has elapsed since we last looked, so it restarted in the gap. Without this
  // check, restarting the daemon after a power cycle silently adopts the stale
  // calibration as current -- the exact failure this module exists to prevent.
  const elapsed = nowMs - prev.lastSeenAtMs;
  const wasDownAcross = elapsed - uptimeMs > UNOBSERVED_SLACK_MS;

  const rebooted = wentBackwards || wasDownAcross;
  return {
    state: { bootId: prev.bootId + (rebooted ? 1 : 0), lastUptimeMs: uptimeMs, lastSeenAtMs: nowMs },
    rebooted,
  };
}

export class BootWatcher {
  private state: BootState | undefined;
  constructor(private readonly filePath: string) {}

  load(): void {
    if (!existsSync(this.filePath)) return;
    try { this.state = JSON.parse(readFileSync(this.filePath, "utf8")) as BootState; }
    catch { this.state = undefined; }   // a corrupt file must not wedge startup
  }

  observe(uptimeMs: number, nowMs: number): boolean {
    const { state, rebooted } = detectBoot(this.state, uptimeMs, nowMs);
    this.state = state;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.filePath);
    return rebooted;
  }

  bootId(): number { return this.state?.bootId ?? 0; }
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/boot-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/boot-watch.ts tb3-mcp/test/boot-watch.test.ts
git commit -m "feat(rezero): detect a lost step origin, including across a daemon restart"
```

---

### Task 5: Re-zero tools

**Files:**
- Create: `tb3-mcp/src/rezero-tools.ts`
- Test: `tb3-mcp/test/rezero-tools.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–4; `enuDirection` from `./geo/wgs84.js`; `currentUserPanTilt` from `./geo-tools.js`; `text`, `errText` from `./tool-helpers.js`.
- Produces:

```ts
// Injected so every path is testable without a rig.
export interface RezeroDeps {
  calib: CalibrationStore;
  limits: LimitsStore;
  boot: BootWatcher;
  cfg: Config;
  gravity: () => Promise<Vec3 | undefined>;  // mean gravity; undefined when the IMU is absent
  posture: () => Promise<{ panDeg: number; tiltDeg: number }>;
  aircraftEnu: (hex: string) => Promise<Vec3 | undefined>;
}

// onReboot and rezeroFromEnu take narrower argument objects than RezeroDeps:
// they need no MCP server, no config, and no aircraft lookup, and keeping them
// narrow is what lets the tests drive them with plain fakes.
export interface OnRebootArgs {
  calib: CalibrationStore;
  limits: LimitsStore;
  boot: BootWatcher;
  geoPanSign: number;
  gravity: () => Promise<Vec3 | undefined>;
  posture: () => Promise<{ panDeg: number; tiltDeg: number }>;
  bootId: number;
}
export interface RezeroArgs {
  calib: CalibrationStore;
  limits: LimitsStore;
  geoPanSign: number;
  bootId: number;
}

export function onReboot(a: OnRebootArgs):
  Promise<{ applied: boolean; deltaTiltDeg?: number; residualDeg?: number; reason?: string }>;
export function rezeroFromEnu(a: RezeroArgs, refEnu: Vec3, posture: { panDeg: number; tiltDeg: number }):
  Promise<{ applied: boolean; deltaPanDeg?: number; residualDeg?: number; reason?: string }>;
export function registerRezeroTools(server: McpServer, deps: RezeroDeps): void;
export function rezeroGuard(calib: CalibrationStore): string | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/rezero-tools.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { onReboot, rezeroFromEnu } from "../src/rezero-tools.js";
import { Mat3, Vec3, matMul, rotX, rotZ, deg2rad, matVec, normalize, angleBetweenDeg } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";

const GP = -1;
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C: Vec3 = normalize([0.02, 0.99, 0.08]);
const RS: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const DB: Vec3 = normalize([-0.008, -0.024, -0.9997]);

function stores() {
  const d = mkdtempSync(join(tmpdir(), "tb3-"));
  const calib = new CalibrationStore(join(d, "calibration.json")); calib.load();
  const limits = new LimitsStore(join(d, "limits.json")); limits.load();
  const boot = new BootWatcher(join(d, "boot.json")); boot.load();
  return { calib, limits, boot };
}

function boresight(R_: Mat3, c: Vec3, pan: number, tilt: number): Vec3 {
  return matVec(matMul(R_, mountHeadRotation(GP * pan, tilt)), c);
}
function gravityAt(pan: number, tilt: number): Vec3 {
  const M = mountHeadRotation(GP * pan, tilt);
  const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
  return matVec(matMul(t(RS), t(M)), DB);
}

describe("onReboot", () => {
  it("corrects tilt limits immediately and clears pan limits", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dTilt = 23.33;
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(18, 12),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 - dTilt }),
      bootId: 2,
    });
    expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(limits.get().tiltMin).toBeCloseTo(-20 - dTilt, 1);
    expect(limits.get().panMin).toBeUndefined();  // unknown until Delta-pan solved
    expect(calib.needsRezero()).toBe(true);
  });

  it("refuses to apply when the tripod moved", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20);
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]);
    const M = mountHeadRotation(GP * 18, 12);
    const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => matVec(matMul(t(RS), t(M)), moved),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(limits.get().tiltMin).toBeUndefined();  // cleared, not shifted by a bad number
  });

  it("falls back to the ceiling when the IMU is absent rather than guessing", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("panMin", -90);
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => undefined,             // /api/imu reports chip "none"
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/no IMU gravity/);
    expect(limits.get().tiltMin).toBeUndefined();
    expect(limits.get().panMin).toBeUndefined();
    expect(calib.needsRezero()).toBe(true);
  });
});

describe("rezeroFromEnu", () => {
  it("restores pointing for an independent posture", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt }), bootId: 2 });
    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt });
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);
    expect(calib.needsRezero()).toBe(false);
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - dPan, 33 - dTilt), boresight(R, C, 60, 33))).toBeLessThan(0.3);
    expect(limits.get().panMin).toBeCloseTo(-90 - dPan, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — cannot resolve `../src/rezero-tools.js`.

- [ ] **Step 3: Implement the core**

```ts
// tb3-mcp/src/rezero-tools.ts (core; MCP wrappers in Step 4)
import {
  solveTiltOffset, solvePanOffset, applyTiltOffset, applyPanOffset,
  MAX_TILT_RESIDUAL_DEG, MAX_PAN_RESIDUAL_DEG,
} from "./geo/rezero.js";

// Ordered so the dangerous axis is protected first: tilt is the axis that
// reached a mechanical stop on 2026-08-02 because the guard was enforcing the
// previous origin's taught limits against the new zero.
export async function onReboot(a: OnRebootArgs) {
  const imu = a.calib.getImuMounting();
  const cHead = a.calib.getCHead();
  const g = await a.gravity();

  // Always mark and stamp, whatever else happens: an unknown origin must be
  // recorded even when we cannot measure the offset.
  const finish = (r: { applied: boolean; deltaTiltDeg?: number; residualDeg?: number; reason?: string }) => {
    a.limits.clearAxis("pan");        // unknown until Delta-pan is solved
    a.limits.setBootId(a.bootId);
    a.calib.markRezeroNeeded(a.bootId);
    return r;
  };

  // No IMU, no characterization, or no cHead => Delta-tilt is unmeasurable.
  // Clear the tilt limits rather than guess: a guessed offset that looks
  // precise is worse than an absent one.
  if (!imu || !cHead || !g) {
    a.limits.clearAxis("tilt");
    return finish({ applied: false, reason: "no IMU gravity or no prior characterization — both axes fall back to the config ceiling" });
  }

  const p = await a.posture();
  const t = solveTiltOffset(imu.rS, imu.dBase, p.panDeg, p.tiltDeg, g, a.geoPanSign);

  if (t.residualDeg > MAX_TILT_RESIDUAL_DEG) {
    a.limits.clearAxis("tilt");
    return finish({
      applied: false, deltaTiltDeg: t.deltaTiltDeg, residualDeg: t.residualDeg,
      reason: `gravity does not fit an origin-only shift (residual ${t.residualDeg.toFixed(2)}deg) — the tripod appears to have moved; full recalibration required`,
    });
  }

  a.calib.setGravityCalibration(
    a.calib.getOrientation()!, applyTiltOffset(cHead, t.deltaTiltDeg), new Date().toISOString());
  a.limits.shiftAxis("tilt", t.deltaTiltDeg);
  return finish({ applied: true, deltaTiltDeg: t.deltaTiltDeg, residualDeg: t.residualDeg });
}

export async function rezeroFromEnu(
  a: RezeroArgs, refEnu: Vec3, posture: { panDeg: number; tiltDeg: number },
) {
  if (!a.calib.needsRezero()) return { applied: false, reason: "no re-zero is pending" };
  const R = a.calib.getOrientation(); const cHead = a.calib.getCHead();
  if (!R || !cHead) return { applied: false, reason: "no calibration to re-zero — solve one first" };

  // posture.tiltDeg is already Delta-tilt-corrected by onReboot, so this is
  // genuinely a one-unknown solve.
  const p = solvePanOffset(R, cHead, a.geoPanSign, refEnu, posture.panDeg, posture.tiltDeg);
  if (p.residualDeg > MAX_PAN_RESIDUAL_DEG) {
    return {
      applied: false, deltaPanDeg: p.deltaPanDeg, residualDeg: p.residualDeg,
      reason: `reference does not fit an origin-only shift (residual ${p.residualDeg.toFixed(2)}deg) — wrong landmark centred, or the tripod moved`,
    };
  }
  a.calib.applyRezero(applyPanOffset(R, p.deltaPanDeg, a.geoPanSign), cHead, a.bootId);
  a.limits.shiftAxis("pan", p.deltaPanDeg);
  return { applied: true, deltaPanDeg: p.deltaPanDeg, residualDeg: p.residualDeg };
}
```

- [ ] **Step 4: Add the four MCP tools**

Thin wrappers over the core, registered in `registerRezeroTools`:

- `set_landmark({ label })` — refuses unless `deps.calib.isCalibrated()`, because
  recording a reference from a provisional orientation bakes the very error being
  corrected into the thing used to correct it. Stores
  `boresightEnu(R, cHead, geoPanSign, panDeg, tiltDeg)` at the current posture via
  `calib.setLandmark({ label, enu, panDeg, tiltDeg, recordedAt: new Date().toISOString() })`.
- `rezero_from_landmark({})` — reads `calib.getLandmark()`, errors with a pointer to
  `set_landmark` and to `rezero_from_aircraft` if absent, else calls `rezeroFromEnu`
  with `landmark.enu` and the current posture.
- `rezero_from_aircraft({ hex })` — `deps.aircraftEnu(hex)`, errors if the target is
  unknown or its fix is stale (reuse the existing `seen_pos` policy), else
  `rezeroFromEnu`.
- `get_rezero_status({})` — returns `needsRezero`, `bootId`, landmark label or
  `null`, which axes currently have taught limits, and the last solved Δtilt/Δpan
  with residuals. This exists because the failure being addressed was *invisible*:
  any state that gates motion must be directly readable.

- [ ] **Step 5: Run tests**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "feat(rezero): set_landmark, rezero_from_landmark/aircraft, get_rezero_status"
```

---

### Task 6: Gate automated motion while the origin is unknown

**Files:**
- Modify: `tb3-mcp/src/geo-tools.ts` (`point_at`, `point_at_azel`)
- Modify: `tb3-mcp/src/track-tools.ts` (`start_tracking`)
- Modify: `tb3-mcp/src/adsb-tools.ts` (`track_aircraft`)
- Test: `tb3-mcp/test/rezero-gating.test.ts`

**Interfaces:**
- Consumes: `CalibrationStore.needsRezero()`.
- Produces: a shared guard `export function rezeroGuard(calib: CalibrationStore): string | undefined` in `tb3-mcp/src/rezero-tools.ts`, returning an error string or `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/rezero-gating.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { rezeroGuard } from "../src/rezero-tools.js";

function calib(): CalibrationStore {
  const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
  s.load();
  return s;
}

describe("rezeroGuard", () => {
  it("passes when the origin is known", () => {
    expect(rezeroGuard(calib())).toBeUndefined();
  });

  it("blocks when a re-zero is pending, and says how to fix it", () => {
    const c = calib();
    c.markRezeroNeeded(2);
    const msg = rezeroGuard(c);
    expect(msg).toBeDefined();
    expect(msg).toMatch(/rezero_from_landmark/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-gating.test.ts`
Expected: FAIL — `rezeroGuard is not exported`.

- [ ] **Step 3: Implement**

```ts
// in tb3-mcp/src/rezero-tools.ts
// Automated motion must fail CLOSED while the origin is unknown; anything the
// operator is actively watching (jog, teach_limit) stays open, because they
// have to be able to drive to the landmark and to re-teach if they choose.
export function rezeroGuard(calib: CalibrationStore): string | undefined {
  if (!calib.needsRezero()) return undefined;
  return "the rig rebooted and its step origin is unknown, so pan/tilt no longer mean " +
    "what the calibration says — centre the stored landmark and call rezero_from_landmark " +
    "(or rezero_from_aircraft <hex>). Jog and teach_limit still work.";
}
```

Then at the top of each gated handler:

```ts
const blocked = rezeroGuard(deps.calib);
if (blocked) return errText(blocked);
```

Apply to `point_at`, `point_at_azel`, `start_tracking`, `track_aircraft`. Do **not** apply to jog or `teach_limit`.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/rezero-gating.test.ts && npx vitest run`
Expected: PASS, and the whole suite still green.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/src/geo-tools.ts tb3-mcp/src/track-tools.ts tb3-mcp/src/adsb-tools.ts tb3-mcp/test/rezero-gating.test.ts
git commit -m "feat(rezero): refuse automated motion while the step origin is unknown"
```

---

### Task 7: Wire it into the server

**Files:**
- Modify: `tb3-mcp/src/server.ts`

**Interfaces:**
- Consumes: `BootWatcher`, `registerRezeroTools`, `onReboot`.

- [ ] **Step 1: Implement**

Next to the existing `calibFile` resolution (`src/server.ts:150`), add:

```ts
const bootFile = cfg.bootFile ?? join(homedir(), ".tb3-mcp", "boot.json");
const boot = new BootWatcher(bootFile);
boot.load();
```

Register the tools with `registerRezeroTools(server, { calib, limits, boot, cfg, gravity, posture, aircraftEnu })`.

Add a poll — reuse the existing status-poll loop if one exists, otherwise a 5 s
`setInterval` — that reads `/api/status`, calls `boot.observe(uptimeMs, Date.now())`,
and on `true` invokes `onReboot(...)`. Log the outcome at info level: the solved
Δtilt and residual, or the refusal reason.

- [ ] **Step 2: Typecheck**

Run: `cd tb3-mcp && npx tsc -p tsconfig.build.json --noEmit`
Expected: only pre-existing `TS7016` errors; no new codes.

- [ ] **Step 3: Full suite**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tb3-mcp/src/server.ts
git commit -m "feat(rezero): watch for lost step origin and auto-correct tilt on boot"
```

---

## Manual verification on the rig

Run after Task 7, with the rig calibrated and limits taught.

1. `set_landmark("<something fixed and distant>")` while calibration is good.
2. Note the current pointing on a known target.
3. Power-cycle the rig.
4. Confirm within ~10 s: `get_rezero_status` reports `needsRezero: true`, a solved Δtilt with a small residual, tilt limits shifted, pan limits cleared.
5. Confirm `track_aircraft` refuses with the guard message, and that jog still works.
6. Centre the landmark, call `rezero_from_landmark`.
7. Confirm `needsRezero` clears, pan limits return shifted, and the target from step 2 is back in frame.

Step 4 is the one that matters most: it is the failure that drove tilt into its mechanical stop on 2026-08-02.
