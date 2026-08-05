# Vision Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the aim-offset loop automatically — a detector finds the aircraft in the camera frame and corrects the pointing bias the operator currently removes by hand.

**Architecture:** ADS-B keeps driving tracking at 10 Hz, untouched. A ~1 Hz outer loop grabs an exposure-stamped frame, detects the aircraft, converts its pixel offset to an angular error using the posture at exposure and a measured focal length, gates it against the ADS-B prediction, and feeds a fraction of the result into the existing `nudgeOffset`. Every failure path contributes nothing, leaving today's behaviour intact.

**Tech Stack:** TypeScript/Node (existing MCP daemon, vitest), a Python YOLO sidecar over HTTP (pattern already used by `llama-server` and `mediamtx`), ffmpeg for frame decode, RTX 5080 via CUDA.

## Global Constraints

- **No new npm dependencies.** The detector is a separate process reached over HTTP; Node gets no Python and no ML libraries.
- **No build step in `dashboard/public/`** — vanilla ES modules only.
- Corrector gain default **0.3**, runtime adjustable.
- Sanity bound: a proposed correction beyond **half the frame's narrower field of view** is discarded, not clamped.
- Frame source acceptance: **≥ 1 Hz, each frame carrying an exposure timestamp**, latency stable enough for the step-response measurement to pin it.
- `MAX_OFFSET_DEG` clamp still applies underneath every correction.
- Vision **never** writes to the calibration profile in this plan. That is the follow-on spec.
- Existing test suite must stay green. `npx tsc -p tsconfig.build.json --noEmit` 0 errors; `npx tsc -p tsconfig.json --noEmit` at exactly 27× TS7016 with no upward drift.
- Forbidden in worktrees: `git reset`, `git checkout --`, `git clean`, `git stash`, `--no-verify`.

## File Structure

| File | Responsibility |
|---|---|
| `src/vision/posture-history.ts` | Ring buffer of `(tMs, panDeg, tiltDeg)`; answers `postureAt(tMs)` by interpolation. The frame-posture pairing lives here. |
| `src/vision/geometry.ts` | Pure math: pixel offset → angular error, with `cos(tilt)` pan compensation and `atan` focal-length model. |
| `src/vision/gate.ts` | Consistency gate: accept a detection only near the ADS-B prediction; reject none/several/far. |
| `src/vision/detector-client.ts` | HTTP client for the sidecar. |
| `src/vision/frame-source.ts` | Persistent decode producing exposure-stamped frames. |
| `src/vision/scale-calibration.ts` | Step response → `focalPx` and `videoLatencyMs`. |
| `src/vision/corrector.ts` | The 1 Hz loop: gain, sanity bound, failure paths, read-only mode. |
| `services/detector/` | Python YOLO sidecar (`app.py`, `requirements.txt`, systemd unit). |

---

### Task 1: Posture history

**Files:**
- Create: `tb3-mcp/src/vision/posture-history.ts`
- Test: `tb3-mcp/test/vision-posture-history.test.ts`

**Interfaces:**
- Produces:
  - `export interface Posture { panDeg: number; tiltDeg: number }`
  - `export class PostureHistory { constructor(capacity?: number); record(tMs: number, panDeg: number, tiltDeg: number): void; postureAt(tMs: number): Posture | null; oldestMs(): number | null; newestMs(): number | null }`

**Why this exists.** A frame describes the past. Reading the mount's *current* posture to interpret a 2-second-old frame computes a correction between two different pointing directions — the defect shape that has escaped three reviews in this project. `postureAt` is the only sanctioned way to ask.

`postureAt` returns `null` — never a guess — when `tMs` is outside the recorded range. Extrapolating past the ends is exactly how a stale posture becomes a silent wrong answer.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-posture-history.test.ts
import { describe, it, expect } from "vitest";
import { PostureHistory } from "../src/vision/posture-history.js";

describe("PostureHistory", () => {
  it("interpolates between two samples", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(1500)).toEqual({ panDeg: 15, tiltDeg: -6 });
  });

  it("returns an exact sample at an exact timestamp", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(2000)).toEqual({ panDeg: 20, tiltDeg: -8 });
  });

  it("refuses BEFORE the oldest sample rather than guessing", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(999)).toBeNull();
  });

  it("refuses AFTER the newest sample rather than extrapolating", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    // The dangerous case: a frame stamped later than any posture we hold.
    // Returning the newest sample here is what silently pairs a frame with
    // the wrong posture.
    expect(h.postureAt(2001)).toBeNull();
  });

  it("refuses a non-finite timestamp instead of interpolating to NaN", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(NaN)).toBeNull();
    expect(h.postureAt(Infinity)).toBeNull();
  });

  it("refuses on an empty history", () => {
    expect(new PostureHistory().postureAt(1000)).toBeNull();
  });

  it("evicts oldest first at capacity, and refuses what it evicted", () => {
    const h = new PostureHistory(3);
    h.record(1000, 1, 1); h.record(2000, 2, 2);
    h.record(3000, 3, 3); h.record(4000, 4, 4);
    expect(h.postureAt(1000)).toBeNull();
    expect(h.oldestMs()).toBe(2000);
    expect(h.newestMs()).toBe(4000);
  });

  it("interpolates each axis independently (asymmetric, opposite signs)", () => {
    const h = new PostureHistory();
    h.record(0, -30, 12);
    h.record(1000, 10, -8);
    // pan +40 over the window, tilt -20 -- distinct magnitudes AND opposite
    // signs, so an axis swap or a shared-sign bug cannot pass.
    expect(h.postureAt(250)).toEqual({ panDeg: -20, tiltDeg: 7 });
  });

  it("ignores an out-of-order sample rather than corrupting the buffer", () => {
    const h = new PostureHistory();
    h.record(2000, 20, -8);
    h.record(1000, 10, -4);       // late arrival, older timestamp
    expect(h.newestMs()).toBe(2000);
    expect(h.postureAt(2000)).toEqual({ panDeg: 20, tiltDeg: -8 });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-posture-history.test.ts`
Expected: FAIL — cannot resolve `../src/vision/posture-history.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/posture-history.ts
export interface Posture { panDeg: number; tiltDeg: number }

interface Sample { tMs: number; panDeg: number; tiltDeg: number }

const DEFAULT_CAPACITY = 600; // 60s at the 10Hz telemetry rate

export class PostureHistory {
  private buf: Sample[] = [];
  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  record(tMs: number, panDeg: number, tiltDeg: number): void {
    const newest = this.buf[this.buf.length - 1];
    // Out-of-order arrivals are dropped: an unsorted buffer would make the
    // binary search below return neighbours that do not bracket tMs.
    if (newest !== undefined && tMs <= newest.tMs) return;
    this.buf.push({ tMs, panDeg, tiltDeg });
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  oldestMs(): number | null { return this.buf.length ? this.buf[0].tMs : null; }
  newestMs(): number | null { return this.buf.length ? this.buf[this.buf.length - 1].tMs : null; }

  postureAt(tMs: number): Posture | null {
    // NaN defeats BOTH range comparisons below (NaN < a and NaN > b are each
    // false), so without this a NaN exposure time interpolates to a NaN
    // posture that looks like a successful lookup.
    if (!Number.isFinite(tMs)) return null;
    if (this.buf.length === 0) return null;
    // Refuse outside the recorded span. Clamping to an end would hand back a
    // posture from a different pointing direction and look like success.
    if (tMs < this.buf[0].tMs) return null;
    if (tMs > this.buf[this.buf.length - 1].tMs) return null;

    let lo = 0, hi = this.buf.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].tMs <= tMs) lo = mid; else hi = mid;
    }
    const a = this.buf[lo], b = this.buf[hi];
    if (tMs === a.tMs) return { panDeg: a.panDeg, tiltDeg: a.tiltDeg };
    if (tMs === b.tMs) return { panDeg: b.panDeg, tiltDeg: b.tiltDeg };
    const f = (tMs - a.tMs) / (b.tMs - a.tMs);
    return {
      panDeg: a.panDeg + f * (b.panDeg - a.panDeg),
      tiltDeg: a.tiltDeg + f * (b.tiltDeg - a.tiltDeg),
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/vision-posture-history.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Prove the refusals are load-bearing (mutation)**

Change `if (tMs > this.buf[...].tMs) return null;` to clamp to the newest sample instead. The "refuses AFTER the newest sample" test MUST fail. Restore it. If that test still passes, it is not testing the invariant this file exists for.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/posture-history.ts tb3-mcp/test/vision-posture-history.test.ts
git commit -m "feat(vision): posture history with exposure-time lookup"
```

---

### Task 2: Pixel-to-angle geometry

**Files:**
- Create: `tb3-mcp/src/vision/geometry.ts`
- Test: `tb3-mcp/test/vision-geometry.test.ts`

**Interfaces:**
- Consumes: `Posture` from Task 1.
- Produces:
  - `export interface PixelOffset { dxPx: number; dyPx: number }`
  - `export interface AngularError { panDeg: number; tiltDeg: number }`
  - `export function focalPxFromFov(widthPx: number, hfovDeg: number): number`
  - `export function fovDegFromFocalPx(sizePx: number, focalPx: number): number`
  - `export function pixelToAngularError(off: PixelOffset, focalPx: number, tiltDeg: number): AngularError`

**The two things this file must get right.**

*Focal-length model, not linear deg/pixel.* Angle is `atan(dPx / focalPx)`. A linear scale is only valid near centre and drifts at the frame edges — precisely where a detection sits when the bias is largest.

*`cos(tilt)` on the pan axis.* On an alt-az mount, panning by Δpan moves the boresight by about `Δpan × cos(tilt)`. So recovering a pan correction from a horizontal pixel error divides by `cos(tilt)`. At the rig's usual −13° this is a 3% effect and invisible; at 45° elevation it is 30%. Omitting it yields a loop that converges at low elevation and drifts high — which is the same failure shape as the calibration problem this feature exists to reduce.

Guard `cos(tilt)` against zero: near ±90° the pan axis is degenerate and no pan correction is recoverable. Return `panDeg: 0` there rather than dividing by a vanishing number.

Sign convention: `dxPx` positive means the aircraft is RIGHT of frame centre; `dyPx` positive means BELOW centre (image coordinates grow downward). The returned `AngularError` is the correction to ADD to the aim offset.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-geometry.test.ts
import { describe, it, expect } from "vitest";
import { focalPxFromFov, fovDegFromFocalPx, pixelToAngularError } from "../src/vision/geometry.js";

const F = focalPxFromFov(1920, 60); // 1920px wide, 60deg horizontal FOV

describe("focal length <-> fov", () => {
  it("round-trips", () => {
    expect(fovDegFromFocalPx(1920, F)).toBeCloseTo(60, 6);
  });
  it("a longer lens (more zoom) gives a bigger focal length", () => {
    expect(focalPxFromFov(1920, 20)).toBeGreaterThan(focalPxFromFov(1920, 60));
  });

  // ---- ABSOLUTE SCALE PINS -------------------------------------------------
  // Everything else in this file is expressed in terms of F itself, which
  // makes it invariant under a consistent rescaling of the focal length. A
  // wrong-by-2x definition (e.g. width/tan instead of (width/2)/tan) paired
  // with a compensating fovDegFromFocalPx passes the round-trip AND every
  // ratio test, while halving every angle pixelToAngularError returns.
  // These three assertions are the only thing standing between that bug and
  // the rest of the system. Do not express them in terms of F.
  it("pins focalPxFromFov against a hand-computed value", () => {
    // (1920/2) / tan(30deg) = 960 / 0.5773503 = 1662.77
    expect(focalPxFromFov(1920, 60)).toBeCloseTo(1662.77, 1);
  });

  it("pins the vertical FOV absolutely", () => {
    // 2*atan(540/1662.769) = 2*17.99170 = 35.9834deg for a 1080px height.
    // NOTE the LITERAL focal length rather than F. Deriving F through
    // focalPxFromFov makes this assertion structurally blind to the
    // scale mutation: a doubled focalPx cancels exactly against a
    // fovDegFromFocalPx that dropped its own /2, so both the correct and
    // the wrong pair return 35.9834. Against the literal, the wrong pair
    // returns 66.009 and the test bites.
    expect(fovDegFromFocalPx(1080, 1662.768775)).toBeCloseTo(35.9834, 3);
  });
});

describe("pixelToAngularError", () => {
  it("dead centre is zero error", () => {
    expect(pixelToAngularError({ dxPx: 0, dyPx: 0 }, F, -13)).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  // ---- THE ABSOLUTE SCALE PIN FOR THE CONVERSION ITSELF --------------------
  // Half the frame width MUST be half the horizontal FOV. This is pure
  // geometry with no reference to F, so a rescaled focal length cannot
  // satisfy it: the correct 1662.77 gives atan(960/1662.77) = 30.0deg, while
  // a doubled 3325.5 gives 16.1deg.
  it("half the frame width IS half the horizontal FOV", () => {
    const r = pixelToAngularError({ dxPx: 960, dyPx: 0 }, F, 0);
    expect(r.panDeg).toBeCloseTo(30, 4);
  });

  it("half the frame height IS half the vertical FOV", () => {
    const r = pixelToAngularError({ dxPx: 0, dyPx: 540 }, F, 0);
    expect(r.tiltDeg).toBeCloseTo(17.99170, 3);
  });

  it("uses atan, not a linear scale — a quarter-frame offset is MORE than a quarter of the FOV", () => {
    // theta = atan(x/f) is CONCAVE, so an interior point sits ABOVE the chord
    // drawn from the frame edge. The edge (960px) is exactly 30deg; a naive
    // linear share at 480px would be 15deg, but the true value is 16.102deg.
    // A linear implementation would return exactly 15 and fail this.
    const r = pixelToAngularError({ dxPx: 480, dyPx: 0 }, F, 0);
    expect(r.panDeg).toBeGreaterThan(15);
    expect(r.panDeg).toBeCloseTo(16.102, 2);
  });

  it("applies cos(tilt) to the pan axis — the SAME pixel error needs a bigger pan correction when tilted up", () => {
    const low  = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 0);
    const high = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 60);
    // cos(60) = 0.5, so the pan correction must be ~2x the flat case.
    expect(high.panDeg / low.panDeg).toBeCloseTo(2, 3);
  });

  it("does NOT apply cos(tilt) to the tilt axis", () => {
    const low  = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 0);
    const high = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 60);
    expect(high.tiltDeg).toBeCloseTo(low.tiltDeg, 9);
  });

  it("axes are independent and signed — asymmetric, opposite signs", () => {
    // Distinct magnitudes and opposite signs: an axis swap or a shared sign
    // error cannot survive this.
    const r = pixelToAngularError({ dxPx: 400, dyPx: -150 }, F, 0);
    expect(r.panDeg).toBeCloseTo((Math.atan(400 / F) * 180) / Math.PI, 6);
    expect(r.tiltDeg).toBeCloseTo((Math.atan(-150 / F) * 180) / Math.PI, 6);
    expect(r.panDeg).toBeGreaterThan(0);
    expect(r.tiltDeg).toBeLessThan(0);
  });

  it("refuses a pan correction at the degenerate pole instead of exploding", () => {
    const r = pixelToAngularError({ dxPx: 400, dyPx: 100 }, F, 89.999);
    expect(r.panDeg).toBe(0);
    expect(Number.isFinite(r.tiltDeg)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-geometry.test.ts`
Expected: FAIL — cannot resolve `../src/vision/geometry.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/geometry.ts
export interface PixelOffset { dxPx: number; dyPx: number }
export interface AngularError { panDeg: number; tiltDeg: number }

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Below this the pan axis is degenerate: near the pole a pan rotation barely
// moves the boresight, so a horizontal pixel error implies an unbounded pan
// correction. Refuse instead.
const MIN_COS_TILT = 0.05; // ~87.1deg

export function focalPxFromFov(widthPx: number, hfovDeg: number): number {
  return (widthPx / 2) / Math.tan((hfovDeg * RAD) / 2);
}

export function fovDegFromFocalPx(sizePx: number, focalPx: number): number {
  return 2 * Math.atan((sizePx / 2) / focalPx) * DEG;
}

export function pixelToAngularError(off: PixelOffset, focalPx: number, tiltDeg: number): AngularError {
  const tiltErr = Math.atan(off.dyPx / focalPx) * DEG;
  const c = Math.cos(tiltDeg * RAD);
  // Alt-az: a pan of dPan moves the boresight by ~dPan*cos(tilt). Recovering
  // pan from a horizontal pixel error therefore DIVIDES by cos(tilt).
  const panErr = Math.abs(c) < MIN_COS_TILT ? 0 : (Math.atan(off.dxPx / focalPx) * DEG) / c;
  return { panDeg: panErr, tiltDeg: tiltErr };
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/vision-geometry.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Prove the cos(tilt) term AND the absolute scale are load-bearing (mutation)**

Three mutations, each restored after:

1. Delete the `/ c` division (return the bare `atan` result). The "applies cos(tilt) to the pan axis" test MUST fail.
2. Replace `atan(dx/focalPx)` with the linear approximation `dx * (hfov/width)`. The "uses atan, not a linear scale" test MUST fail.
3. **The scale mutation.** Change `focalPxFromFov` to `widthPx / Math.tan(...)` (dropping the `/ 2`) AND `fovDegFromFocalPx` to `2 * Math.atan(sizePx / focalPx)` (dropping its `/ 2`) — a self-consistent pair that a previous attempt at this task actually produced. The round-trip and every ratio test still pass; all four absolute-scale pins MUST fail. If they do not, the scale is unpinned and every angle this file returns could be silently halved.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/geometry.ts tb3-mcp/test/vision-geometry.test.ts
git commit -m "feat(vision): pixel-to-angle with focal-length model and cos(tilt) pan compensation"
```

---

### Task 3: Consistency gate

**Files:**
- Create: `tb3-mcp/src/vision/gate.ts`
- Test: `tb3-mcp/test/vision-gate.test.ts`

**Interfaces:**
- Consumes: `PixelOffset` from Task 2.
- Produces:
  - `export interface Candidate { dxPx: number; dyPx: number; conf: number }`
  - `export type GateResult = { accepted: Candidate } | { rejected: GateReject }`
  - `export type GateReject = "no_candidates" | "none_near_prediction" | "ambiguous"`
  - `export function gateDetections(cands: Candidate[], predicted: PixelOffset, radiusPx: number, minConf: number): GateResult`

**What this is for.** ADS-B already predicts where the aircraft should appear. Accepting only detections near that prediction rejects birds, cloud edges, the trees at the frame margin and the second aircraft in view — on geometry, without the detector needing to be clever. It is what makes a mediocre detector safe.

`ambiguous` (two or more survivors) is a rejection, not a "pick the best". If two candidates both sit near the prediction, the loop has no basis to choose and guessing is how a wrong lock persists. Contribute nothing and try again next cycle.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-gate.test.ts
import { describe, it, expect } from "vitest";
import { gateDetections } from "../src/vision/gate.js";

const PRED = { dxPx: 100, dyPx: -50 };
const R = 80, MINCONF = 0.25;

describe("gateDetections", () => {
  it("accepts a lone confident detection near the prediction", () => {
    const c = { dxPx: 110, dyPx: -40, conf: 0.9 };
    expect(gateDetections([c], PRED, R, MINCONF)).toEqual({ accepted: c });
  });

  it("rejects when there are no candidates at all", () => {
    expect(gateDetections([], PRED, R, MINCONF)).toEqual({ rejected: "no_candidates" });
  });

  it("rejects a HIGH-confidence decoy far from the prediction", () => {
    // The whole point: detector confidence does not override geometry.
    const decoy = { dxPx: 900, dyPx: 400, conf: 0.99 };
    expect(gateDetections([decoy], PRED, R, MINCONF)).toEqual({ rejected: "none_near_prediction" });
  });

  it("keeps the near one and discards the far one", () => {
    const near = { dxPx: 105, dyPx: -55, conf: 0.4 };
    const far  = { dxPx: 900, dyPx: 400, conf: 0.99 };
    expect(gateDetections([far, near], PRED, R, MINCONF)).toEqual({ accepted: near });
  });

  it("rejects as ambiguous when two survive — does NOT pick the higher confidence", () => {
    const a = { dxPx: 105, dyPx: -55, conf: 0.4 };
    const b = { dxPx: 120, dyPx: -30, conf: 0.95 };
    expect(gateDetections([a, b], PRED, R, MINCONF)).toEqual({ rejected: "ambiguous" });
  });

  it("drops sub-threshold confidence before the geometry test", () => {
    const weak = { dxPx: 105, dyPx: -55, conf: 0.1 };
    expect(gateDetections([weak], PRED, R, MINCONF)).toEqual({ rejected: "no_candidates" });
  });

  it("uses radial distance, not per-axis — a corner at r>radius is rejected", () => {
    // dx=+60, dy=+60 from prediction: each axis under 80, radius 84.9 over.
    const corner = { dxPx: 160, dyPx: 10, conf: 0.9 };
    expect(gateDetections([corner], PRED, R, MINCONF)).toEqual({ rejected: "none_near_prediction" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-gate.test.ts`
Expected: FAIL — cannot resolve `../src/vision/gate.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/gate.ts
import { PixelOffset } from "./geometry.js";

export interface Candidate { dxPx: number; dyPx: number; conf: number }
export type GateReject = "no_candidates" | "none_near_prediction" | "ambiguous";
export type GateResult = { accepted: Candidate } | { rejected: GateReject };

export function gateDetections(
  cands: Candidate[], predicted: PixelOffset, radiusPx: number, minConf: number,
): GateResult {
  const confident = cands.filter((c) => c.conf >= minConf);
  if (confident.length === 0) return { rejected: "no_candidates" };

  const near = confident.filter((c) => {
    const dx = c.dxPx - predicted.dxPx, dy = c.dyPx - predicted.dyPx;
    return Math.hypot(dx, dy) <= radiusPx;
  });
  if (near.length === 0) return { rejected: "none_near_prediction" };
  // Two survivors give no basis to choose. Guessing is how a wrong lock
  // persists across cycles; contributing nothing costs one cycle.
  if (near.length > 1) return { rejected: "ambiguous" };
  return { accepted: near[0] };
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/vision-gate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Prove the gate is load-bearing (mutation)**

Change `if (near.length > 1)` to sort by confidence and return the best. The "rejects as ambiguous" test MUST fail. Then remove the radius filter entirely; the "rejects a HIGH-confidence decoy" test MUST fail. Restore both.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/gate.ts tb3-mcp/test/vision-gate.test.ts
git commit -m "feat(vision): consistency gate — geometry outranks detector confidence"
```

---

### Task 4: Detector sidecar and client

**Files:**
- Create: `services/detector/app.py`, `services/detector/requirements.txt`, `services/detector/README.md`, `tb3-mcp/deploy/tb3-detector.service`
- Create: `tb3-mcp/src/vision/detector-client.ts`
- Test: `tb3-mcp/test/vision-detector-client.test.ts`

**Interfaces:**
- Consumes: `Candidate` from Task 3.
- Produces:
  - `export interface DetectResponse { detections: Candidate[]; widthPx: number; heightPx: number; inferMs: number }`
  - `export class DetectorClient { constructor(url: string, timeoutMs: number); detect(jpegBase64: string, minConf: number): Promise<DetectResponse | null> }`

`detect` resolves `null` on ANY failure — unreachable, non-200, malformed body, timeout. It never throws. The corrector treats `null` as "contribute nothing this cycle", and an exception escaping into the tracking loop would be a far worse outcome than a skipped correction.

**Wire contract.** `POST /detect` with `{"image_b64": "...", "min_conf": 0.25}` returns:

```json
{"detections":[{"dxPx":112.0,"dyPx":-38.5,"conf":0.87}],"widthPx":1920,"heightPx":1080,"inferMs":3.1}
```

`dxPx`/`dyPx` are the detection centre **relative to frame centre**, computed sidecar-side, so the conversion lives in one place rather than being repeated by every client.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-detector-client.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { DetectorClient } from "../src/vision/detector-client.js";

let server: Server | null = null;
function serve(handler: (body: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const r = handler(raw);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${a.port}/detect`);
    });
  });
}
afterEach(() => { server?.close(); server = null; });

describe("DetectorClient", () => {
  it("parses a well-formed response", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({
      detections: [{ dxPx: 112, dyPx: -38.5, conf: 0.87 }], widthPx: 1920, heightPx: 1080, inferMs: 3.1,
    })}));
    const r = await new DetectorClient(url, 2000).detect("Zm9v", 0.25);
    expect(r?.detections).toEqual([{ dxPx: 112, dyPx: -38.5, conf: 0.87 }]);
    expect(r?.widthPx).toBe(1920);
  });

  it("sends the image and threshold in the documented shape", async () => {
    let seen = "";
    const url = await serve((body) => { seen = body; return { status: 200, body: JSON.stringify({
      detections: [], widthPx: 1920, heightPx: 1080, inferMs: 1,
    })}; });
    await new DetectorClient(url, 2000).detect("Zm9v", 0.4);
    expect(JSON.parse(seen)).toEqual({ image_b64: "Zm9v", min_conf: 0.4 });
  });

  it("returns null on a non-200 rather than throwing", async () => {
    const url = await serve(() => ({ status: 500, body: "boom" }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on a malformed body rather than throwing", async () => {
    const url = await serve(() => ({ status: 200, body: "{not json" }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on a body that parses but fails the schema", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ detections: "nope" }) }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null when the detector is unreachable", async () => {
    const c = new DetectorClient("http://127.0.0.1:1/detect", 500);
    await expect(c.detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on timeout rather than hanging the loop", async () => {
    const url = await new Promise<string>((resolve) => {
      server = createServer(() => { /* never responds */ });
      server.listen(0, "127.0.0.1", () => {
        const a = server!.address() as { port: number };
        resolve(`http://127.0.0.1:${a.port}/detect`);
      });
    });
    await expect(new DetectorClient(url, 300).detect("Zm9v", 0.25)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-detector-client.test.ts`
Expected: FAIL — cannot resolve `../src/vision/detector-client.js`.

- [ ] **Step 3: Implement the client**

```ts
// tb3-mcp/src/vision/detector-client.ts
import { z } from "zod";
import { Candidate } from "./gate.js";

const ResponseSchema = z.object({
  detections: z.array(z.object({ dxPx: z.number(), dyPx: z.number(), conf: z.number() })),
  widthPx: z.number().positive(),
  heightPx: z.number().positive(),
  inferMs: z.number().nonnegative(),
});

export interface DetectResponse {
  detections: Candidate[]; widthPx: number; heightPx: number; inferMs: number;
}

export class DetectorClient {
  constructor(private readonly url: string, private readonly timeoutMs: number) {}

  // Resolves null on ANY failure. An exception escaping here would take down
  // the tracking loop; a skipped correction costs one cycle.
  async detect(jpegBase64: string, minConf: number): Promise<DetectResponse | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_b64: jpegBase64, min_conf: minConf }),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const parsed = ResponseSchema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Implement the sidecar**

```python
# services/detector/app.py
import base64, io, time
from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

# COCO class 4 is "aeroplane". Fine-tuning for distant specks is a later
# concern; the consistency gate carries the reliability burden for now.
AIRCRAFT_CLASS_ID = 4
model = YOLO("yolov8n.pt")
model.to("cuda")
app = FastAPI()

class DetectRequest(BaseModel):
    image_b64: str
    min_conf: float = 0.25

@app.post("/detect")
def detect(req: DetectRequest):
    t0 = time.perf_counter()
    img = Image.open(io.BytesIO(base64.b64decode(req.image_b64))).convert("RGB")
    w, h = img.size
    cx, cy = w / 2.0, h / 2.0
    res = model.predict(img, conf=req.min_conf, classes=[AIRCRAFT_CLASS_ID], verbose=False)[0]
    dets = []
    for b in res.boxes:
        x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
        # Offset from FRAME CENTRE, computed here so every client agrees.
        dets.append({"dxPx": (x1 + x2) / 2.0 - cx, "dyPx": (y1 + y2) / 2.0 - cy,
                     "conf": float(b.conf[0])})
    return {"detections": dets, "widthPx": w, "heightPx": h,
            "inferMs": (time.perf_counter() - t0) * 1000.0}

@app.get("/health")
def health():
    return {"ok": True}
```

```
# services/detector/requirements.txt
fastapi
uvicorn[standard]
pillow
ultralytics
```

```ini
# tb3-mcp/deploy/tb3-detector.service
[Unit]
Description=TB3 aircraft detector (YOLO on CUDA)
After=network-online.target

[Service]
User=atomist
WorkingDirectory=/home/atomist/TB3-ESP32/services/detector
ExecStart=/home/atomist/TB3-ESP32/services/detector/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`services/detector/README.md` documents: create the venv, `pip install -r requirements.txt`, that the unit file is installed by the operator with sudo (the host requires a password for sudo — never attempt it from an agent), and that the first run downloads `yolov8n.pt`.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, 0 errors. The Python sidecar is not exercised by the TS suite — that is deliberate; its contract is pinned by the client tests above and by the on-rig acceptance step in Task 9.

- [ ] **Step 6: Commit**

```bash
git add services/detector tb3-mcp/deploy/tb3-detector.service tb3-mcp/src/vision/detector-client.ts tb3-mcp/test/vision-detector-client.test.ts
git commit -m "feat(vision): YOLO detector sidecar and a client that never throws"
```

---

### Task 5: Exposure-stamped frame source

**Files:**
- Create: `tb3-mcp/src/vision/frame-source.ts`
- Test: `tb3-mcp/test/vision-frame-source.test.ts`

**Interfaces:**
- Produces:
  - `export interface StampedFrame { jpegBase64: string; exposureMs: number; arrivedMs: number }`
  - `export interface FrameSource { latest(): StampedFrame | null; start(): void; stop(): void }`
  - `export class MjpegPipeSource implements FrameSource { constructor(deps: { spawnPipe: () => FramePipe; now: () => number; latencyMs: () => number }) }`
  - `export interface FramePipe { onFrame(cb: (jpeg: Buffer) => void): void; kill(): void }`

**Why a pipe and not the snapshot path.** `takeSnapshot` measured 1755–2217 ms, dominated by waiting for the next keyframe, and cannot serve a 1 Hz loop. This is a persistent ffmpeg process emitting MJPEG continuously; frames are consumed as they arrive.

**The stamping rule.** `exposureMs = arrivedMs - latencyMs()`. The latency comes from Task 6's measurement and is read **per frame**, not captured at construction — a value fixed at startup could not track a re-measurement after a zoom.

`latest()` returns the most recent frame, or `null` if none has arrived. It does not block.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-frame-source.test.ts
import { describe, it, expect } from "vitest";
import { MjpegPipeSource, FramePipe } from "../src/vision/frame-source.js";

function fakePipe() {
  let cb: ((j: Buffer) => void) | null = null;
  const pipe: FramePipe = { onFrame: (f) => { cb = f; }, kill: () => {} };
  return { pipe, emit: (b: Buffer) => cb?.(b) };
}

describe("MjpegPipeSource", () => {
  it("returns null before any frame arrives", () => {
    const { pipe } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1000, latencyMs: () => 200 });
    s.start();
    expect(s.latest()).toBeNull();
  });

  it("stamps exposure as arrival MINUS latency", () => {
    const { pipe, emit } = fakePipe();
    let t = 5000;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => 350 });
    s.start();
    emit(Buffer.from("abc"));
    const f = s.latest()!;
    expect(f.arrivedMs).toBe(5000);
    expect(f.exposureMs).toBe(4650);   // NOT 5000 -- the frame describes the past
  });

  it("reads latency PER FRAME so a re-measurement takes effect without a restart", () => {
    const { pipe, emit } = fakePipe();
    let t = 1000, lat = 200;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => lat });
    s.start();
    emit(Buffer.from("a"));
    expect(s.latest()!.exposureMs).toBe(800);
    lat = 900;                          // e.g. operator zoomed, latency re-measured
    t = 2000;
    emit(Buffer.from("b"));
    expect(s.latest()!.exposureMs).toBe(1100);
  });

  it("keeps only the newest frame", () => {
    const { pipe, emit } = fakePipe();
    let t = 1000;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => 0 });
    s.start();
    emit(Buffer.from("old")); t = 2000; emit(Buffer.from("new"));
    expect(Buffer.from(s.latest()!.jpegBase64, "base64").toString()).toBe("new");
  });

  it("a frame buffered past stop() must NOT resurrect newest", () => {
    // ffmpeg keeps writing already-buffered stdout after kill() returns. A
    // stale closure repopulating `newest` would hand a caller who deliberately
    // stopped capture a frame from a dead pipe instead of null.
    const { pipe, emit } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1000, latencyMs: () => 0 });
    s.start();
    s.stop();
    expect(s.latest()).toBeNull();
    emit(Buffer.from("late"));
    expect(s.latest()).toBeNull();
  });

  it("base64-encodes the jpeg for the wire", () => {
    const { pipe, emit } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1, latencyMs: () => 0 });
    s.start();
    emit(Buffer.from("hello"));
    expect(s.latest()!.jpegBase64).toBe(Buffer.from("hello").toString("base64"));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-frame-source.test.ts`
Expected: FAIL — cannot resolve `../src/vision/frame-source.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/frame-source.ts
export interface StampedFrame { jpegBase64: string; exposureMs: number; arrivedMs: number }
export interface FramePipe { onFrame(cb: (jpeg: Buffer) => void): void; kill(): void }
export interface FrameSource { latest(): StampedFrame | null; start(): void; stop(): void }

export interface MjpegPipeDeps {
  spawnPipe: () => FramePipe;
  now: () => number;
  // Read per frame, NOT captured at construction: a latency re-measured after
  // a zoom must take effect without restarting the source.
  latencyMs: () => number;
}

export class MjpegPipeSource implements FrameSource {
  private pipe: FramePipe | null = null;
  private newest: StampedFrame | null = null;
  // Bumped by every start()/stop(). A killed ffmpeg commonly delivers frames
  // still buffered in its stdout AFTER kill() returns; without this the stale
  // closure would repopulate `newest` and a caller that deliberately stopped
  // capture would read a frame instead of null.
  private generation = 0;
  constructor(private readonly deps: MjpegPipeDeps) {}

  start(): void {
    if (this.pipe) return;
    const gen = ++this.generation;
    this.pipe = this.deps.spawnPipe();
    this.pipe.onFrame((jpeg) => {
      if (gen !== this.generation) return;   // frame from a pipe we already killed
      const arrivedMs = this.deps.now();
      this.newest = {
        jpegBase64: jpeg.toString("base64"),
        arrivedMs,
        // The frame describes the past. Everything downstream must use this,
        // never now().
        exposureMs: arrivedMs - this.deps.latencyMs(),
      };
    });
  }

  stop(): void {
    this.generation++;                       // invalidate the in-flight closure
    this.pipe?.kill();
    this.pipe = null;
    this.newest = null;
  }
  latest(): StampedFrame | null { return this.newest; }
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/vision-frame-source.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove the stamping is load-bearing (mutation)**

Set `exposureMs: arrivedMs` (drop the latency subtraction). The "stamps exposure as arrival MINUS latency" test MUST fail. Then hoist `latencyMs()` into the constructor and reuse the captured value; the "reads latency PER FRAME" test MUST fail. Restore both.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/frame-source.ts tb3-mcp/test/vision-frame-source.test.ts
git commit -m "feat(vision): exposure-stamped frame source over a persistent mjpeg pipe"
```

---

### Task 6: Step-response scale calibration

**Files:**
- Create: `tb3-mcp/src/vision/scale-calibration.ts`
- Test: `tb3-mcp/test/vision-scale-calibration.test.ts`

**Interfaces:**
- Consumes: `pixelToAngularError`, `focalPxFromFov` from Task 2.
- Produces:
  - `export interface StepObservation { tMs: number; dxPx: number; dyPx: number }`
  - `export interface ScaleResult { focalPx: number; latencyMs: number }`
  - `export function solveStepResponse(obs: StepObservation[], stepAppliedAtMs: number, stepPanDeg: number, tiltDegAtStep: number): ScaleResult | null`

**What it measures.** One commanded aim-offset step yields both unknowns:

- **latency** — the delay between issuing the step and the image beginning to move.
- **focalPx** — the settled pixel displacement divided by `tan` of the true angular step.

The true angular step for a pan command is `stepPanDeg × cos(tilt)` (Task 2's geometry, in the forward direction). Ignoring that would bias `focalPx` by the same `cos(tilt)` factor and produce a scale that is correct only at the elevation where it was measured.

Returns `null` — never a guess — when the observations do not support a solve: no detectable movement, movement before the step was applied (impossible, indicates a clock problem), or fewer than two settled samples.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-scale-calibration.test.ts
import { describe, it, expect } from "vitest";
import { solveStepResponse } from "../src/vision/scale-calibration.js";
import { focalPxFromFov } from "../src/vision/geometry.js";

// Build a synthetic step response with a KNOWN latency and KNOWN focal length.
function synth(latencyMs: number, focalPx: number, stepPanDeg: number, tiltDeg: number) {
  const trueAngle = stepPanDeg * Math.cos((tiltDeg * Math.PI) / 180);
  const settledPx = focalPx * Math.tan((trueAngle * Math.PI) / 180);
  const obs = [];
  for (let t = 0; t <= 2000; t += 100) {
    obs.push({ tMs: t, dxPx: t < latencyMs ? 0 : settledPx, dyPx: 0 });
  }
  return obs;
}

describe("solveStepResponse", () => {
  it("recovers BOTH the latency and the focal length", () => {
    const F = focalPxFromFov(1920, 60);
    const r = solveStepResponse(synth(400, F, 5, 0), 0, 5, 0)!;
    expect(r.latencyMs).toBeCloseTo(400, -2);   // within ~a sample period
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  it("accounts for cos(tilt) — the same pixel step at 60deg implies a DIFFERENT focal length", () => {
    const F = focalPxFromFov(1920, 60);
    // Synthesised at 60deg tilt: the true angular step is halved, so the same
    // focal length produces half the pixel movement.
    const r = solveStepResponse(synth(300, F, 5, 60), 0, 5, 60)!;
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  it("a solver ignoring cos(tilt) would be wrong by 2x at 60deg — pin that it is not", () => {
    const F = focalPxFromFov(1920, 60);
    const flat = solveStepResponse(synth(300, F, 5, 0), 0, 5, 0)!;
    const high = solveStepResponse(synth(300, F, 5, 60), 0, 5, 60)!;
    expect(high.focalPx / flat.focalPx).toBeCloseTo(1, 1);
  });

  it("ABSOLUTE pin: recovers a hand-computed focal length with no reference to focalPxFromFov", () => {
    // Every other assertion here builds pixels FROM F and recovers F, so it
    // passes under any consistent rescaling. This one is hand-computed:
    // a 5deg step at tilt 0 has trueAngle 5deg, tan(5deg) = 0.08748866,
    // so a settled displacement of 100px implies focalPx = 100/0.08748866
    // = 1143.005.
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: t < 400 ? 0 : 100, dyPx: 0 });
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r.focalPx).toBeCloseTo(1143.005, 2);
    expect(r.latencyMs).toBeCloseTo(400, -2);
  });

  it("ignores a transient noise blip and anchors latency to the REAL step edge", () => {
    // A single 2.5px sample crossing the threshold before the true settle at
    // t=400. Anchoring to the blip gives latencyMs 100 -- 4x too small -- and
    // that number feeds exposureMs = arrivedMs - latencyMs().
    const obs = [
      { tMs: 0, dxPx: 0, dyPx: 0 },
      { tMs: 100, dxPx: 2.5, dyPx: 0 },    // blip
      { tMs: 200, dxPx: 0.5, dyPx: 0 },
      { tMs: 300, dxPx: 1, dyPx: 0 },
      { tMs: 400, dxPx: 50, dyPx: 0 },     // real edge
      { tMs: 500, dxPx: 50, dyPx: 0 },
      { tMs: 600, dxPx: 50, dyPx: 0 },
    ];
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r.latencyMs).toBe(400);
  });

  it("returns null when the image never moves", () => {
    const flat = Array.from({ length: 21 }, (_, i) => ({ tMs: i * 100, dxPx: 0, dyPx: 0 }));
    expect(solveStepResponse(flat, 0, 5, 0)).toBeNull();
  });

  it("returns null on too few observations to settle", () => {
    expect(solveStepResponse([{ tMs: 0, dxPx: 0, dyPx: 0 }], 0, 5, 0)).toBeNull();
  });

  it("returns null at the degenerate pole where the step conveys no pan information", () => {
    const F = focalPxFromFov(1920, 60);
    expect(solveStepResponse(synth(300, F, 5, 89.99), 0, 5, 89.99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-scale-calibration.test.ts`
Expected: FAIL — cannot resolve `../src/vision/scale-calibration.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/scale-calibration.ts
const RAD = Math.PI / 180;
const MIN_COS_TILT = 0.05;
const MOVE_THRESHOLD_PX = 2;   // below this the image has not moved
// A single sample over threshold is not a step edge. Detector centroid jitter
// and JPEG artefacts routinely produce 2-3px blips, and anchoring the latency
// to one of them yields a latency far too small -- which feeds
// exposureMs = arrivedMs - latencyMs() and understamps every frame, exactly
// the pointing-lag class this whole feature exists to remove. Require the
// crossing to STAY crossed.
const MOVE_CONFIRM_SAMPLES = 3;

export interface StepObservation { tMs: number; dxPx: number; dyPx: number }
export interface ScaleResult { focalPx: number; latencyMs: number }

export function solveStepResponse(
  obs: StepObservation[], stepAppliedAtMs: number, stepPanDeg: number, tiltDegAtStep: number,
): ScaleResult | null {
  if (obs.length < 2) return null;
  const c = Math.cos(tiltDegAtStep * RAD);
  // At the pole a pan step barely moves the boresight, so the observation
  // carries no usable scale information.
  if (Math.abs(c) < MIN_COS_TILT) return null;

  const sorted = [...obs].sort((a, b) => a.tMs - b.tMs);
  const settledPx = sorted[sorted.length - 1].dxPx;
  if (Math.abs(settledPx) < MOVE_THRESHOLD_PX) return null;

  // First index from which the threshold stays crossed for MOVE_CONFIRM_SAMPLES
  // consecutive samples (or to the end of the record, whichever comes first).
  let firstIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i].dxPx) < MOVE_THRESHOLD_PX) continue;
    let run = 0;
    while (i + run < sorted.length && Math.abs(sorted[i + run].dxPx) >= MOVE_THRESHOLD_PX) run++;
    if (run >= MOVE_CONFIRM_SAMPLES || i + run >= sorted.length) { firstIdx = i; break; }
    i += run;   // a blip: skip past it and keep looking
  }
  if (firstIdx < 0) return null;
  const latencyMs = sorted[firstIdx].tMs - stepAppliedAtMs;
  if (latencyMs < 0) return null;   // movement before the command: clock problem

  // The TRUE angular step on an alt-az mount, not the commanded number.
  const trueAngleDeg = stepPanDeg * c;
  const focalPx = settledPx / Math.tan(trueAngleDeg * RAD);
  if (!Number.isFinite(focalPx) || focalPx <= 0) return null;
  return { focalPx, latencyMs };
}
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/vision-scale-calibration.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Prove cos(tilt) is load-bearing (mutation)**

Replace `stepPanDeg * c` with `stepPanDeg`. The "accounts for cos(tilt)" and "would be wrong by 2x" tests MUST both fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/scale-calibration.ts tb3-mcp/test/vision-scale-calibration.test.ts
git commit -m "feat(vision): step-response calibration recovers focal length and video latency together"
```

---

### Task 7: The corrector loop

**Files:**
- Create: `tb3-mcp/src/vision/corrector.ts`
- Test: `tb3-mcp/test/vision-corrector.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus `nudgeOffset`/`AimOffset` from `src/track/offset.ts`.
- Produces:
  - `export type CorrectorOutcome = "applied" | "read_only" | "no_frame" | "no_posture" | "detector_unavailable" | GateReject | "over_sanity_bound" | "no_scale"`
  - `export interface CorrectorDeps { frames: FrameSource; detector: DetectorClient; postures: PostureHistory; predictPixel: (exposureMs: number) => PixelOffset | null; applyOffset: (dPan: number, dTilt: number) => void; focalPx: () => number | null; frameSizePx: () => { widthPx: number; heightPx: number }; gain: () => number; readOnly: () => boolean; gateRadiusPx: () => number; minConf: () => number; log: (o: CorrectorOutcome, detail: Record<string, unknown>) => void }`
  - `export class VisionCorrector { constructor(deps: CorrectorDeps); async tick(): Promise<CorrectorOutcome> }`

**The rules this encodes.**

*Posture at exposure.* `postures.postureAt(frame.exposureMs)`. Never `getState()`. If the history cannot answer, the outcome is `no_posture` and nothing is applied.

*Gain below 1.* The correction applied is `gain × angularError`. This is what makes the loop converge instead of oscillate, and it bounds how far a single bad detection moves the mount.

*Sanity bound.* A proposed correction whose magnitude exceeds **half the narrower field of view** is **discarded, not clamped**. A correction that large means the detection was wrong; clamping would apply a wrong answer at reduced magnitude.

*Read-only mode.* Everything runs, the outcome and the correction that *would* have been applied are logged, and `applyOffset` is not called. This is how the detector is evaluated against the operator's manual trims before it is given authority.

*Every failure contributes nothing.* No frame, no posture, detector down, gate rejection, no scale yet, over the bound — all return their outcome having called nothing.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-corrector.test.ts
import { describe, it, expect, vi } from "vitest";
import { VisionCorrector, CorrectorDeps } from "../src/vision/corrector.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { focalPxFromFov } from "../src/vision/geometry.js";

const F = focalPxFromFov(1920, 60);

function harness(over: Partial<CorrectorDeps> = {}) {
  const postures = new PostureHistory();
  postures.record(1000, 10, 0);
  postures.record(9000, 10, 0);          // flat: posture 10/0 across the span
  const applied: Array<[number, number]> = [];
  const logged: Array<[string, Record<string, unknown>]> = [];
  const predictArgs: number[] = [];
  const deps: CorrectorDeps = {
    frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
    detector: { detect: async () => ({ detections: [{ dxPx: 200, dyPx: -100, conf: 0.9 }],
      widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
    postures,
    // Records its argument: the epoch predictPixel is evaluated at is half
    // the invariant, and a harness that ignores the parameter cannot pin it.
    predictPixel: (t: number) => { predictArgs.push(t); return { dxPx: 200, dyPx: -100 }; },
    applyOffset: (p, t) => { applied.push([p, t]); },
    focalPx: () => F,
    frameSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
    gain: () => 0.3,
    readOnly: () => false,
    gateRadiusPx: () => 80,
    minConf: () => 0.25,
    log: (o, d) => { logged.push([o, d]); },
    ...over,
  };
  return { deps, applied, logged, predictArgs, c: new VisionCorrector(deps) };
}

describe("VisionCorrector", () => {
  it("applies gain x angular error", async () => {
    const { c, applied } = harness();
    expect(await c.tick()).toBe("applied");
    const expectPan = 0.3 * (Math.atan(200 / F) * 180) / Math.PI;   // tilt 0 -> cos=1
    expect(applied[0][0]).toBeCloseTo(expectPan, 6);
    expect(applied[0][1]).toBeCloseTo(0.3 * (Math.atan(-100 / F) * 180) / Math.PI, 6);
  });

  it("uses the posture at EXPOSURE, not the current posture", async () => {
    // Posture swings hard AFTER the frame was exposed. Using the newest
    // sample would change the cos(tilt) term and thus the pan correction.
    const postures = new PostureHistory();
    postures.record(4000, 10, 0);
    postures.record(5000, 10, 0);        // exposure sits here: tilt 0
    postures.record(6000, 10, 60);       // "now": tilt 60, cos = 0.5
    const { c, applied } = harness({ postures });
    expect(await c.tick()).toBe("applied");
    const atExposure = 0.3 * (Math.atan(200 / F) * 180) / Math.PI;         // /cos(0) = 1
    expect(applied[0][0]).toBeCloseTo(atExposure, 6);
    expect(applied[0][0]).not.toBeCloseTo(atExposure * 2, 3);              // the tilt-60 answer
  });

  it("refuses when posture is unavailable for the exposure time", async () => {
    const postures = new PostureHistory();
    postures.record(8000, 10, 0);        // all AFTER the 5000ms exposure
    postures.record(9000, 10, 0);
    const { c, applied } = harness({ postures });
    expect(await c.tick()).toBe("no_posture");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when there is no frame", async () => {
    const { c, applied } = harness({ frames: { latest: () => null, start(){}, stop(){} } });
    expect(await c.tick()).toBe("no_frame");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when the detector is unavailable", async () => {
    const { c, applied } = harness({ detector: { detect: async () => null } as never });
    expect(await c.tick()).toBe("detector_unavailable");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when the gate rejects a decoy", async () => {
    const { c, applied } = harness({
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 400, conf: 0.99 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
    });
    expect(await c.tick()).toBe("none_near_prediction");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing before a scale has been measured", async () => {
    const { c, applied } = harness({ focalPx: () => null });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("DISCARDS a correction over the sanity bound rather than clamping it", async () => {
    // NOTE on why this case and not a big pixel offset: with gain < 1 an
    // IN-FRAME detection can never exceed the bound -- it implies at most half
    // the diagonal FOV, and the gain shrinks it further. The bound exists to
    // catch the cos(tilt) blow-up near the pole (and a corrupt focalPx), which
    // is what this exercises: at tilt 85 the pan correction is divided by
    // cos(85) = 0.087, an ~11.5x amplification.
    const postures = new PostureHistory();
    postures.record(1000, 10, 85);
    postures.record(9000, 10, 85);
    const { c, applied, logged } = harness({
      postures,
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: 900, dyPx: 0 }),
    });
    // 0.3 * atan(900/F) / cos(85) ~= 97deg, against a bound of ~18deg.
    expect(await c.tick()).toBe("over_sanity_bound");
    expect(applied).toHaveLength(0);     // NOT a clamped value
    expect(logged[0][0]).toBe("over_sanity_bound");
  });

  it("pins the sanity bound's VALUE: just under is applied, just over is discarded", () => {
    // The over-bound test above clears the bound by ~5x, so it would still
    // pass if the bound itself were computed wrong (e.g. a fovDegFromFocalPx
    // that returned 66deg instead of 35.98deg). These two bracket it.
    // Bound = min(hfov, vfov)/2 = min(60, 35.9834)/2 = 17.9917deg.
    // Choose a tilt whose cos amplification lands the correction either side.
    // At dxPx=200, gain 0.3: base = 0.3*atan(200/F)*DEG = 2.0581deg.
    // /cos(t) crosses 17.9917 at cos(t) = 0.11439, i.e. t = 83.431deg.
    const near = (tiltDeg: number) => {
      const postures = new PostureHistory();
      postures.record(1000, 10, tiltDeg);
      postures.record(9000, 10, tiltDeg);
      return harness({ postures });
    };
    return (async () => {
      const under = near(83.0);            // cos = 0.12187 -> 16.888deg, under
      expect(await under.c.tick()).toBe("applied");
      const over = near(83.9);             // cos = 0.10627 -> 19.366deg, over
      expect(await over.c.tick()).toBe("over_sanity_bound");
      expect(over.applied).toHaveLength(0);
    })();
  });

  it("read-only mode logs the correction it would have made and applies nothing", async () => {
    const { c, applied, logged } = harness({ readOnly: () => true });
    expect(await c.tick()).toBe("read_only");
    expect(applied).toHaveLength(0);
    expect(logged[0][1].panDeg).toBeCloseTo(0.3 * (Math.atan(200 / F) * 180) / Math.PI, 6);
  });

  it("evaluates predictPixel at the EXPOSURE epoch, not arrival and not now", async () => {
    // The posture limb of this invariant is well guarded; without this the
    // prediction limb is not guarded at all, and a mismatch BETWEEN the two
    // limbs is the exact defect -- an ADS-B fix evaluated at the wrong epoch
    // produced a 1.91s pointing lag in the field.
    const { c, predictArgs } = harness();
    await c.tick();
    expect(predictArgs).toEqual([5000]);      // exposureMs, not arrivedMs (5300)
  });

  it("fails CLOSED on a NaN correction instead of applying it", async () => {
    // NaN > bound is false, so a `>` guard waves NaN through -- and
    // nudgeOffset's clamp propagates it, latching the offset permanently.
    const { c, applied } = harness({ focalPx: () => NaN });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("treats a zero focal length as no scale, not as a 90 degree bound", async () => {
    const { c, applied } = harness({ focalPx: () => 0 });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("reports a missing PREDICTION distinctly from a missing posture", async () => {
    const { c, applied } = harness({ predictPixel: () => null });
    expect(await c.tick()).toBe("no_prediction");
    expect(applied).toHaveLength(0);
  });

  it("bounds on the NARROWER dimension whichever way the frame is oriented", async () => {
    // Every other test uses landscape 1920x1080, where height is narrower --
    // so a height-only bound passes them all. Portrait swaps which one binds.
    const postures = new PostureHistory();
    postures.record(1000, 10, 83.9);
    postures.record(9000, 10, 83.9);
    const { c } = harness({ postures, frameSizePx: () => ({ widthPx: 1080, heightPx: 1920 }) });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("measures the correction as a VECTOR magnitude, not one axis", async () => {
    // Both axes contribute; a bound testing only |panDeg| would accept this.
    const postures = new PostureHistory();
    postures.record(1000, 10, 83.0);
    postures.record(9000, 10, 83.0);
    const { c } = harness({
      postures,
      detector: { detect: async () => ({ detections: [{ dxPx: 200, dyPx: 900, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: (t: number) => ({ dxPx: 200, dyPx: 900 }),
    });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("logs the applied correction, not only the refusals", async () => {
    const { c, logged } = harness();
    await c.tick();
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("applied");
    expect(logged[0][1].panDeg).toBeCloseTo(0.3 * (Math.atan(200 / F) * 180) / Math.PI, 6);
  });

  it("an over-bound detection reads over_sanity_bound even in read-only mode", async () => {
    // Otherwise the evaluation log silently contains corrections the live
    // path would have refused, and the read-only comparison is misleading.
    const postures = new PostureHistory();
    postures.record(1000, 10, 85);
    postures.record(9000, 10, 85);
    const { c } = harness({
      postures, readOnly: () => true,
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: (t: number) => ({ dxPx: 900, dyPx: 0 }),
    });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("converges rather than oscillates over repeated ticks", async () => {
    // A standing bias puts the aircraft off-centre by exactly that angle.
    // ADS-B predicts it THERE too (the prediction accounts for where the rig
    // is actually pointing), so the gate must accept -- hence predictPixel
    // tracks the same pixel as the detection rather than sitting at centre.
    let bias = 4.0;                      // degrees of standing error
    const pixelOf = () => F * Math.tan((bias * Math.PI) / 180);
    const errs: number[] = [];
    const { c } = harness({
      detector: { detect: async () => ({
        detections: [{ dxPx: pixelOf(), dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: pixelOf(), dyPx: 0 }),
      applyOffset: (p) => { bias -= p; },
    });
    const signed: number[] = [];
    for (let i = 0; i < 12; i++) { await c.tick(); signed.push(bias); errs.push(Math.abs(bias)); }
    // Math.abs erases the sign, so a gain in (1, 1.841) overshoots and flips
    // sign every tick -- physical hunting on the mount -- while still passing
    // a magnitude-only check. Pin the sign.
    for (let i = 1; i < signed.length; i++) expect(Math.sign(signed[i])).toBe(Math.sign(signed[0]));
    // At tilt 0, atan(F*tan(bias)/F) === bias exactly, so each tick removes
    // gain*bias and the residual shrinks by a factor of 0.7 per tick.
    for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThan(errs[i - 1]);
    expect(errs[errs.length - 1]).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-corrector.test.ts`
Expected: FAIL — cannot resolve `../src/vision/corrector.js`.

- [ ] **Step 3: Implement**

```ts
// tb3-mcp/src/vision/corrector.ts
import { FrameSource } from "./frame-source.js";
import { DetectorClient } from "./detector-client.js";
import { PostureHistory } from "./posture-history.js";
import { gateDetections, GateReject } from "./gate.js";
import { PixelOffset, pixelToAngularError, fovDegFromFocalPx } from "./geometry.js";

export type CorrectorOutcome =
  | "applied" | "read_only" | "no_frame" | "no_posture" | "no_prediction"
  | "detector_unavailable" | GateReject | "over_sanity_bound" | "no_scale";

export interface CorrectorDeps {
  frames: FrameSource;
  detector: DetectorClient;
  postures: PostureHistory;
  predictPixel: (exposureMs: number) => PixelOffset | null;
  applyOffset: (dPanDeg: number, dTiltDeg: number) => void;
  focalPx: () => number | null;
  frameSizePx: () => { widthPx: number; heightPx: number };
  gain: () => number;
  readOnly: () => boolean;
  gateRadiusPx: () => number;
  minConf: () => number;
  log: (outcome: CorrectorOutcome, detail: Record<string, unknown>) => void;
}

export class VisionCorrector {
  constructor(private readonly d: CorrectorDeps) {}

  async tick(): Promise<CorrectorOutcome> {
    const done = (o: CorrectorOutcome, detail: Record<string, unknown> = {}) => {
      this.d.log(o, detail); return o;
    };

    const frame = this.d.frames.latest();
    if (frame === null) return done("no_frame");

    const focalPx = this.d.focalPx();
    // !(x > 0) rather than === null: a focalPx of 0 implies a 180deg field of
    // view and a 90deg bound, which would wave a 27deg correction through as
    // "applied"; a NaN would defeat every comparison downstream.
    if (focalPx === null || !(focalPx > 0)) return done("no_scale");

    // THE INVARIANT: posture at EXPOSURE, never the present.
    const posture = this.d.postures.postureAt(frame.exposureMs);
    if (posture === null) return done("no_posture", { exposureMs: frame.exposureMs });

    const predicted = this.d.predictPixel(frame.exposureMs);
    // Its OWN reason: "the ring buffer has no posture for that instant" and
    // "ADS-B has no prediction for this aircraft right now" are different
    // faults with different remedies.
    if (predicted === null) return done("no_prediction", { exposureMs: frame.exposureMs });

    const res = await this.d.detector.detect(frame.jpegBase64, this.d.minConf());
    if (res === null) return done("detector_unavailable");

    const gated = gateDetections(res.detections, predicted, this.d.gateRadiusPx(), this.d.minConf());
    if ("rejected" in gated) return done(gated.rejected);

    const err = pixelToAngularError(
      { dxPx: gated.accepted.dxPx, dyPx: gated.accepted.dyPx }, focalPx, posture.tiltDeg,
    );
    const g = this.d.gain();
    const panDeg = g * err.panDeg, tiltDeg = g * err.tiltDeg;

    // Sanity bound in FOV terms so it survives a zoom: a correction implying
    // the aircraft is further off-axis than the frame can see is
    // self-contradictory. DISCARD -- clamping would apply a wrong answer at
    // reduced magnitude.
    const { widthPx, heightPx } = this.d.frameSizePx();
    const narrowerFovDeg = Math.min(
      fovDegFromFocalPx(widthPx, focalPx), fovDegFromFocalPx(heightPx, focalPx),
    );
    const bound = narrowerFovDeg / 2;
    // Negated <= rather than >: `NaN > bound` is false, so a NaN correction
    // would sail through the one guard meant to stop nonsense -- and
    // nudgeOffset's clamp PROPAGATES NaN, latching the aim offset permanently
    // with no subsequent nudge able to recover it. Fail closed.
    if (!(Math.hypot(panDeg, tiltDeg) <= bound)) {
      return done("over_sanity_bound", { panDeg, tiltDeg, bound });
    }

    if (this.d.readOnly()) return done("read_only", { panDeg, tiltDeg });

    this.d.applyOffset(panDeg, tiltDeg);
    return done("applied", { panDeg, tiltDeg });
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, 0 errors.

- [ ] **Step 5: Prove the two critical rules are load-bearing (mutation)**

Replace `postureAt(frame.exposureMs)` with `postureAt(this.d.postures.newestMs()!)`. The "uses the posture at EXPOSURE" test MUST fail. Restore.

Replace the sanity-bound `return done("over_sanity_bound", …)` with a clamp to `bound`. The "DISCARDS a correction over the sanity bound" test MUST fail. Restore.

Set `gain()` to 1.0 in the convergence test's harness; it should overshoot and the monotonic-decrease assertion should fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/vision/corrector.ts tb3-mcp/test/vision-corrector.test.ts
git commit -m "feat(vision): corrector loop — exposure-time posture, fractional gain, discard over bound"
```

---

### Task 8: Wiring, config and MCP tools

**Files:**
- Modify: `tb3-mcp/src/config.ts`, `tb3-mcp/src/server.ts`
- Create: `tb3-mcp/src/vision-tools.ts`
- Test: `tb3-mcp/test/vision-tools.test.ts`

**Interfaces:**
- Consumes: `VisionCorrector` from Task 7; `TuningStore`/`resolveTuning` if the calibration-fixes-and-tuning branch has merged, otherwise config only.
- Produces: MCP tools `get_vision_status`, `set_vision_enabled`, `calibrate_vision_scale`.

**Config additions** (all with defaults, so an existing `config.json` keeps working):

```ts
visionEnabled: z.boolean().default(false),          // OFF by default -- opt in
visionReadOnly: z.boolean().default(true),          // observe before authority
visionDetectorUrl: z.string().min(1).default("http://127.0.0.1:8001/detect"),
visionDetectorTimeoutMs: z.number().int().positive().default(2000),
visionTickHz: z.number().positive().max(10).default(1),
visionGain: z.number().positive().max(1).default(0.3),
visionGateRadiusPx: z.number().positive().default(120),
visionMinConf: z.number().positive().max(1).default(0.25),
```

`visionEnabled` defaults **false** and `visionReadOnly` defaults **true**: the feature must be switched on deliberately, and its first mode observes rather than acts.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/vision-tools.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("vision config", () => {
  it("is OFF by default and read-only by default", () => {
    const c = loadConfig(undefined, {});
    expect(c.visionEnabled).toBe(false);
    expect(c.visionReadOnly).toBe(true);
  });

  it("defaults gain to 0.3 and tick to 1Hz", () => {
    const c = loadConfig(undefined, {});
    expect(c.visionGain).toBe(0.3);
    expect(c.visionTickHz).toBe(1);
  });

  it("rejects a gain above 1 — that would not converge", () => {
    expect(() => loadConfig({ visionGain: 1.5 } as never, {})).toThrow();
  });

  it("an existing config with no vision keys still loads", () => {
    const c = loadConfig({ deviceHost: "192.168.4.56" } as never, {});
    expect(c.visionEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/vision-tools.test.ts`
Expected: FAIL — `visionEnabled` is undefined.

- [ ] **Step 3: Implement**

Add the config block above to `src/config.ts` alongside the existing tracking keys, with matching `set("visionEnabled", bool(env.TB3_VISION_ENABLED))`-style env overrides following the file's established pattern.

In `src/server.ts`, construct one `PostureHistory` and feed it from the existing telemetry path, recording `dev.lastUpdateMs` as the sample time — **not** `Date.now()`. The telemetry timestamp is when the posture was true; the arrival time is not.

Wire `VisionCorrector` on a `visionTickHz` timer, started only when `visionEnabled`. `predictPixel` comes from the tracking session's current target prediction converted through `pixelToAngularError`'s inverse; `applyOffset` calls the session's existing nudge path so `MAX_OFFSET_DEG` still applies.

Register `src/vision-tools.ts` following the shape of `src/track-tools.ts`:
- `get_vision_status` — enabled, read-only, last outcome, last correction, measured `focalPx` and `latencyMs`, detector reachability.
- `set_vision_enabled` — `{ enabled: boolean, readOnly?: boolean }`.
- `calibrate_vision_scale` — runs the step response and persists the result.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c TS7016`
Expected: PASS, 0 errors, exactly 27.

- [ ] **Step 5: Prove the telemetry timestamp is used (mutation)**

In `server.ts`, change the posture recording to `postures.record(Date.now(), …)`. Add a test asserting a posture recorded from telemetry stamped in the past is retrievable at that past time; it MUST fail under the mutation. Restore.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/config.ts tb3-mcp/src/server.ts tb3-mcp/src/vision-tools.ts tb3-mcp/test/vision-tools.test.ts
git commit -m "feat(vision): config, wiring and MCP tools; off and read-only by default"
```

---

### Task 9: Dashboard surface and on-rig acceptance

**Files:**
- Modify: `tb3-mcp/dashboard/public/cockpit.js`, `tb3-mcp/src/dashboard/state.ts`
- Create: `tb3-mcp/dashboard/public/vision-status.js`
- Test: `tb3-mcp/test/dashboard-vision-status.test.ts`

**Interfaces:**
- Consumes: `get_vision_status` from Task 8.
- Produces: a vision block in `/api/state` and a compact status readout in the cockpit.

**What it must show.** Whether vision is enabled, whether it is read-only, the last outcome, and the last correction. The outcome matters more than the correction: an operator seeing `none_near_prediction` repeatedly learns something a silent zero would hide.

Vanilla ES modules, no build step, following the existing drawer/panel pattern.

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/dashboard-vision-status.test.ts
import { describe, it, expect } from "vitest";
import { renderVisionStatus } from "../dashboard/public/vision-status.js";

describe("renderVisionStatus", () => {
  it("says OFF when disabled, regardless of a stale last outcome", () => {
    const t = renderVisionStatus({ enabled: false, readOnly: true, lastOutcome: "applied", panDeg: 1, tiltDeg: 2 });
    expect(t).toMatch(/off/i);
    expect(t).not.toMatch(/applied/i);
  });

  it("distinguishes read-only from active", () => {
    const ro = renderVisionStatus({ enabled: true, readOnly: true, lastOutcome: "read_only", panDeg: 0.4, tiltDeg: -0.2 });
    const on = renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "applied", panDeg: 0.4, tiltDeg: -0.2 });
    expect(ro).toMatch(/observing|read.?only/i);
    expect(on).not.toMatch(/observing|read.?only/i);
  });

  it("surfaces a rejection reason rather than showing a bare zero", () => {
    const t = renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "none_near_prediction", panDeg: null, tiltDeg: null });
    expect(t).toMatch(/prediction/i);
  });

  it("survives a null correction", () => {
    expect(() => renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "no_frame", panDeg: null, tiltDeg: null })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/dashboard-vision-status.test.ts`
Expected: FAIL — cannot resolve `../dashboard/public/vision-status.js`.

- [ ] **Step 3: Implement**

Create `dashboard/public/vision-status.js` exporting `renderVisionStatus(v)` returning a short human string, and mount it in `cockpit.js` beside the existing tracking readout. Add the `vision` block to `/api/state` in `src/dashboard/state.ts`.

- [ ] **Step 4: Run the full suite, both typechecks, and the dashboard smoke**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && node scripts/dashboard-smoke.mjs`
Expected: PASS, 0 errors, smoke clean.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/dashboard/public/vision-status.js tb3-mcp/dashboard/public/cockpit.js tb3-mcp/src/dashboard/state.ts tb3-mcp/test/dashboard-vision-status.test.ts
git commit -m "feat(vision): dashboard status showing outcome, not just correction"
```

- [ ] **Step 6: On-rig acceptance (operator, not agent)**

Off-rig tests cannot establish whether YOLO detects real aircraft at real ranges against real sky and terrain. The acceptance procedure:

1. Install the sidecar venv and unit (operator runs the sudo steps; the host requires a password).
2. `calibrate_vision_scale` with the rig on a tracked target; confirm `focalPx` and `latencyMs` are recovered and that `fovDegFromFocalPx` implies a plausible field of view.
3. Run a full pass with `visionReadOnly: true`. Nothing moves. Collect the outcome log.
4. Compare the logged would-be corrections against the operator's manual trims over the same pass. They should agree in sign and be within roughly a degree.
5. Only if step 4 agrees, set `visionReadOnly: false` and fly a pass with the loop live.
6. Re-run `calibrate_vision_scale` after a zoom change and confirm `focalPx` moves and the loop still converges.

**Do not skip step 3–4.** The detector's real-world reliability is the one thing this plan cannot establish, and read-only mode exists precisely so that it is established before the loop has authority.

---

## Notes for the executor

- Tasks 1, 2, 3, 5, 6 and 7 are pure or dependency-injected and testable with no hardware. That is deliberate — the correctness-critical logic is off the hardware path.
- The mutation steps are not optional. Three defects in this project were bad tests rather than bad code, and a test that passes under its own mutation proves nothing.
- If the calibration-fixes-and-tuning branch has merged before this starts, route `visionGain`, `visionTickHz`, `visionGateRadiusPx` and `visionMinConf` through `TuningStore` instead of config, so they are adjustable without a restart. If it has not, use config and leave a note; do not block on it.
