# Origin Generation Stamping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every frame-dependent artifact with the origin generation it was produced under, and reconcile the one place two anchors combine, so a re-solve after a re-zero stops silently producing a wrong calibration.

**Architecture:** Five artifacts are meaningful only relative to the step origin in force when they were produced. Exactly one is stamped today (`edgeBootId`), and it is the only one that has stopped producing this class of bug. Stamp the rest, add a `tiltAnchorDeg` to the baseline so `originOffset.tiltDeg` is measured from the baseline rather than from `characterize_imu`, and make an unreconcilable mismatch a loud, specifically-named failure.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest, vanilla-JS dashboard (no build step). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-origin-generation-stamping-design.md`
**Branch:** continues `feat/reboot-rezero` (currently `b0db650`, 121 files / 1273 tests). Blocked from merge until this completes.

## Global Constraints

- **No new npm dependencies.** No build step in `tb3-mcp/dashboard/public/` — it is vanilla ES modules served static.
- **`imuMounting.dBase` must NEVER be rewritten outside `characterize_imu`.** The pan/tilt decoupling holds only because `dBase` sits ~1.45° off the pan axis *in the original frame*; re-stamping it at a shifted origin was measured to collapse it.
- **`solveTiltOffset` always returns `T(current)`** — the tilt offset relative to the generation `characterize_imu` ran in. That is what it measures against `dBase`, whatever the baseline is doing.
- **`originOffset.tiltDeg = solveTiltOffset(...) − baseline.tiltAnchorDeg`.** Never `solveTiltOffset(...)` alone.
- **Applying a re-zero is an assignment, never `+=`.**
- Rotation convention: `mountHeadRotation(panDeg, tiltDeg) = matMul(rotZ(deg2rad(-panDeg)), rotX(deg2rad(tiltDeg)))` — note the NEGATIVE on pan.
- `MAX_TILT_RESIDUAL_DEG = 3.0`, `MAX_PAN_RESIDUAL_DEG = 3.0`, `MAX_POSTURE_STALE_MS = 2000`, `MOVE_TOL_DEG = 0.5`.
- `Vec3`/`Mat3` are `readonly` tuples; build new values, never mutate.
- All new persisted schema fields `.optional()` so existing profiles parse.
- Tests: `npx vitest run` from `tb3-mcp/`. Typecheck: `npx tsc -p tsconfig.build.json --noEmit` **0 errors**; `npx tsc -p tsconfig.json --noEmit` at the pre-existing **27× TS7016**.
- Never `--no-verify` (a hook blocks it). **Forbidden git commands:** `git reset`, `git checkout --`, `git clean`, `git stash` — a subagent destroyed working-tree edits this way.

---

### Task 1: Stamp the artifacts

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Modify: `tb3-mcp/src/boot-watch.ts`
- Test: `tb3-mcp/test/calibration.test.ts` (append — exists), `tb3-mcp/test/boot-watch.test.ts` (append — exists)

**Interfaces:**
- Produces: `UNKNOWN_GENERATION` (exported from `boot-watch.ts`), `CalibrationStore.getImuMountingGeneration(): number | undefined`, `CalibrationStore.getBaselineGeneration(): number | undefined`, `CalibrationStore.getLandmarkGeneration(): number | undefined`
- `setImuMounting`, `setBaseline` and `setLandmark` each gain a trailing `bootId: number` parameter.

Schema: add `bootId: z.number().optional()` inside the `imuMounting`, `baseline` and `landmark` objects.

**M-1 is part of this task.** `BootWatcher.bootId()` currently returns `0` when `boot.json` is missing or corrupt, and `0` is indistinguishable from a real generation — reproduced: with `boot.json` lost, an edge freshly taught under generation 5 was shifted from `-70` to `-103`. Export `export const UNKNOWN_GENERATION = -1;` and return that instead. Anything comparing generations treats `UNKNOWN_GENERATION` as "do not assume they match".

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/boot-watch.test.ts
import { UNKNOWN_GENERATION } from "../src/boot-watch.js";

describe("unknown generation", () => {
  it("reports UNKNOWN_GENERATION, not 0, when no state file exists", () => {
    const w = new BootWatcher(join(mkdtempSync(join(tmpdir(), "tb3-")), "boot.json"));
    w.load();
    expect(w.bootId()).toBe(UNKNOWN_GENERATION);
    expect(w.bootId()).not.toBe(0);   // 0 is a plausible real generation
  });

  it("reports UNKNOWN_GENERATION when the state file is corrupt", () => {
    const p = join(mkdtempSync(join(tmpdir(), "tb3-")), "boot.json");
    writeFileSync(p, "not json {");
    const w = new BootWatcher(p);
    w.load();
    expect(w.bootId()).toBe(UNKNOWN_GENERATION);
  });
});
```

```ts
// append to tb3-mcp/test/calibration.test.ts
describe("artifact generation stamps", () => {
  it("records the generation each artifact was produced under", () => {
    const s = store();
    s.setImuMounting(RS, DB, 1.3, 4);
    s.setBaseline(R0, C0, new Date().toISOString(), 5);
    s.setLandmark({ label: "tower", enu: [0, 1, 0], panDeg: 1, tiltDeg: 2, recordedAt: "x" }, 5);
    expect(s.getImuMountingGeneration()).toBe(4);
    expect(s.getBaselineGeneration()).toBe(5);
    expect(s.getLandmarkGeneration()).toBe(5);
  });

  it("a profile written before stamps existed reports undefined, not a wrong number", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    writeFileSync(path, JSON.stringify({ version: 1, sightings: [] }));
    const s = new CalibrationStore(path, -1);
    expect(() => s.load()).not.toThrow();
    expect(s.getBaselineGeneration()).toBeUndefined();
  });
});
```

`R0`, `C0` and `store()` already exist in `test/calibration.test.ts`; reuse them. `RS` and `DB` may not — they are defined in `test/rezero-tools.test.ts`. If they are absent, define them locally in the style of that file's neighbouring fixtures rather than importing across test files or inventing new shapes. `DB` must be the rig's real measured `dBase`, `normalize([-0.008, -0.024, -0.9997])` — its ~1.45° lean off the pan axis is what makes the decoupling approximate, and a fixture with zero lean would make several tests pass for the wrong reason.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/boot-watch.test.ts test/calibration.test.ts`
Expected: FAIL — `UNKNOWN_GENERATION` is not exported; `getBaselineGeneration` is not a function.

- [ ] **Step 3: Implement**, updating every call site of the three setters (`src/imu-tools.ts:115`, `src/geo-tools.ts:379`, `src/geo-tools.ts:409`, `src/imu-tools.ts:225`, and `set_landmark` in `src/rezero-tools.ts`) to pass the current generation. Those call sites need the `BootWatcher`; thread it through their existing deps object rather than reaching for a global.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/src/boot-watch.ts tb3-mcp/src/imu-tools.ts tb3-mcp/src/geo-tools.ts tb3-mcp/src/rezero-tools.ts tb3-mcp/src/server.ts tb3-mcp/test/calibration.test.ts tb3-mcp/test/boot-watch.test.ts
git commit -m "feat(rezero): stamp every frame-dependent artifact with its origin generation"
```

---

### Task 2: The tilt anchor — the actual fix

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`, `tb3-mcp/src/rezero-tools.ts`
- Test: `tb3-mcp/test/rezero-tools.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's stamps.
- Produces: `baseline.tiltAnchorDeg` (schema: `tiltAnchorDeg: z.number().optional()`), `CalibrationStore.getTiltAnchorDeg(): number` (0 when absent), and `setBaseline` gains a trailing `tiltAnchorDeg = 0` parameter.

**The default matters.** Task 1 introduces `setBaseline(R0, cHead0, solvedAtIso, bootId)` with four parameters and its tests call it that way. Defaulting `tiltAnchorDeg` to 0 keeps those calls compiling and is the correct value for a baseline solved at the characterize generation. Do not make it required — that would break Task 1's tests and tempt whoever fixes them to pass a placeholder.

**The arithmetic.** `T(g)` is the tilt-reading offset of generation `g` relative to the generation `characterize_imu` ran in, so `T(characterize_gen) = 0` and `solveTiltOffset` always returns `T(current)`. Record `baseline.tiltAnchorDeg = T(baseline_gen)`. Then:

```ts
const tiltTotal = solveTiltOffset(...).deltaTiltDeg - calib.getTiltAnchorDeg();
```

Today the code uses `solveTiltOffset(...)` directly, which is correct only while the anchor is 0 — i.e. only until the first re-solve after a re-zero. Apply the subtraction at **both** call sites: `src/rezero-tools.ts:221` (`onReboot`) and `src/rezero-tools.ts:297` (`rezeroFromEnu`). The residual check still uses the raw `residualDeg`; only the offset shifts.

- [ ] **Step 1: Write the failing test — this is the headline test for the whole plan**

```ts
// append to tb3-mcp/test/rezero-tools.test.ts
describe("re-solve after a re-zero", () => {
  it("stays correct when the calibration is re-solved in an already-offset frame", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, 1.3, 1);
    calib.setBaseline(R, C, new Date().toISOString(), 1, 0);
    const truePan = -25, trueTilt = 19;

    // Cycle 1: reboot, re-zero.
    const d1p = 12, d1t = 9;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => ({ panDeg: truePan - d1p, tiltDeg: trueTilt - d1t, moving: false, staleMs: 0 }),
      bootId: 2 });
    await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      boresight(R, C, truePan, trueTilt),
      { panDeg: truePan - d1p, tiltDeg: trueTilt - d1t, moving: false, staleMs: 0 },
      gravityAt(truePan, trueTilt));

    // RE-SOLVE from fresh sightings, in the offset frame. This is the
    // one-click dashboard path: Solve is enabled whenever two sightings exist.
    // The new baseline's anchor must record the tilt offset in force NOW.
    const anchor = solveTiltOffset(RS, DB, truePan - d1p, trueTilt - d1t,
                                   gravityAt(truePan, trueTilt), GP).deltaTiltDeg;
    calib.setBaseline(R, C, new Date().toISOString(), 2, anchor);

    // Cycle 2: another reboot on top of the re-solved calibration.
    const d2p = 7, d2t = 5;
    const rp = truePan - d1p - d2p, rt = trueTilt - d1t - d2t;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => ({ panDeg: rp, tiltDeg: rt, moving: false, staleMs: 0 }),
      bootId: 3 });
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 3 },
      boresight(R, C, truePan, trueTilt),
      { panDeg: rp, tiltDeg: rt, moving: false, staleMs: 0 }, gravityAt(truePan, trueTilt));

    expect(res.applied).toBe(true);            // must NOT blame the tripod
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - d1p - d2p, 33 - d1t - d2t),
                           boresight(R, C, 60, 33))).toBeLessThan(0.1);
  });
});
```

Import `solveTiltOffset` from `../src/geo/rezero.js` in that file if it is not already imported.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — either `applied` is `false` with a "tripod appears to have moved" reason, or the pointing error is ~1° or worse.
**If it passes before you change anything, STOP and report.** A test that does not reproduce the defect proves nothing, and three defects in this project were bad tests rather than bad code.

- [ ] **Step 3: Implement** the schema field, the getter, the `setBaseline` parameter, and the subtraction at both `solveTiltOffset` call sites.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Prove the subtraction is load-bearing**

Remove `- calib.getTiltAnchorDeg()` from `rezeroFromEnu` only. The new test MUST fail. Restore it, then remove it from `onReboot` only, and confirm a failure again. Revert both. Report both observations.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/src/rezero-tools.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "fix(rezero): measure the tilt offset from the baseline, not from characterize_imu"
```

---

### Task 3: The solve and characterize writers maintain the anchor

**Files:**
- Modify: `tb3-mcp/src/geo-tools.ts` (`solve_calibration`, lines ~379 and ~409), `tb3-mcp/src/imu-tools.ts` (`characterize_imu` ~115, `set_north_zero` ~225)
- Test: `tb3-mcp/test/rezero-tools.test.ts` (append)

**Interfaces:**
- Consumes: `setBaseline(R0, cHead0, solvedAtIso, bootId, tiltAnchorDeg)` from Tasks 1–2.

Two writers maintain the anchor:

1. **`solve_calibration` and `set_north_zero`** write a baseline at the current generation, so they must read gravity at that moment and set `tiltAnchorDeg = solveTiltOffset(...).deltaTiltDeg`. Both already read gravity for their own purposes — reuse that read rather than adding a second one, and reuse the existing before/after posture guard around it.
2. **`characterize_imu`** re-anchors `dBase` so `T(current)` becomes 0, which shifts every stored `T(·)` by −`T_old(current)`. Since `originOffset.tiltDeg = T_old(current) − tiltAnchorDeg_old`, that gives `tiltAnchorDeg_new = −originOffset.tiltDeg`. **Derive this yourself and pin it with the test below rather than trusting the algebra here.**

- [ ] **Step 1: Write the failing test**

```ts
it("re-characterising mid-sequence leaves subsequent re-zeros correct", async () => {
  const { calib, limits, boot } = stores();
  calib.setImuMounting(RS, DB, 1.3, 1);
  calib.setBaseline(R, C, new Date().toISOString(), 1, 0);
  const truePan = -25, trueTilt = 19;

  const dp = 14, dt = 11;
  await onReboot({ calib, limits, boot, geoPanSign: GP,
    gravity: async () => gravityAt(truePan, trueTilt),
    posture: async () => ({ panDeg: truePan - dp, tiltDeg: trueTilt - dt, moving: false, staleMs: 0 }),
    bootId: 2 });
  await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
    boresight(R, C, truePan, trueTilt),
    { panDeg: truePan - dp, tiltDeg: trueTilt - dt, moving: false, staleMs: 0 },
    gravityAt(truePan, trueTilt));

  // characterize_imu re-anchors dBase to the CURRENT origin, so every stored
  // T(.) shifts. Apply the re-anchor rule the task derives.
  const offsetBefore = calib.getOriginOffset();
  calib.setImuMounting(RS, DB, 1.3, 2);
  calib.reanchorTiltForCharacterize();
  expect(calib.getTiltAnchorDeg()).toBeCloseTo(-offsetBefore.tiltDeg, 6);

  // A further reboot must still resolve correctly.
  const dp2 = 6, dt2 = 4;
  const rp = truePan - dp - dp2, rt = trueTilt - dt - dt2;
  await onReboot({ calib, limits, boot, geoPanSign: GP,
    gravity: async () => gravityAt(truePan, trueTilt),
    posture: async () => ({ panDeg: rp, tiltDeg: rt, moving: false, staleMs: 0 }), bootId: 3 });
  const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 3 },
    boresight(R, C, truePan, trueTilt),
    { panDeg: rp, tiltDeg: rt, moving: false, staleMs: 0 }, gravityAt(truePan, trueTilt));
  expect(res.applied).toBe(true);
  const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
  expect(angleBetweenDeg(boresight(R2, C2, 60 - dp - dp2, 33 - dt - dt2),
                         boresight(R, C, 60, 33))).toBeLessThan(0.1);
});
```

Note the test above assumes `gravityAt` still reflects the ORIGINAL `dBase` after re-characterising, which is true here because the fixture's physical mounting has not changed — only the reference generation has.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — `reanchorTiltForCharacterize is not a function`.

- [ ] **Step 3: Implement** `CalibrationStore.reanchorTiltForCharacterize(): void`, and wire the two writers.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/src/geo-tools.ts tb3-mcp/src/imu-tools.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "feat(rezero): solve and characterize maintain the baseline tilt anchor"
```

---

### Task 4: Refuse a generation mismatch by name

**Files:**
- Modify: `tb3-mcp/src/rezero-tools.ts`, `tb3-mcp/src/geo-tools.ts` (the `imuDisagreeDeg` block, ~lines 340–370)
- Test: `tb3-mcp/test/rezero-tools.test.ts` (append)

`"the tripod appears to have moved"` currently covers three distinct causes — a genuinely disturbed tripod, a stale `rS`, and a frame mismatch — and it sent the operator to re-level a tripod that was fine.

`geo-tools.ts` computes `imuDisagreeDeg`, which is approximately the cumulative Δtilt. It is surfaced only when `headingResidualDeg > 3`, and its comment ("`R_s` is stale") is now wrong: after a legitimate re-zero that disagreement is *expected*. Rework it to consult the stamps rather than infer from magnitude.

- [ ] **Step 1: Write the failing test**

```ts
it("names a generation mismatch instead of blaming the tripod", async () => {
  const { calib, limits, boot } = stores();
  calib.setImuMounting(RS, DB, 1.3, 7);
  // Baseline stamped from a generation the imuMounting never saw, with no anchor.
  calib.setBaseline(R, C, new Date().toISOString(), 2, 0);
  const out = await onReboot({ calib, limits, boot, geoPanSign: GP,
    gravity: async () => gravityAt(-25, 19),
    posture: async () => ({ panDeg: -25, tiltDeg: 19, moving: false, staleMs: 0 }), bootId: 8 });
  expect(out.applied).toBe(false);
  expect(out.reason).toMatch(/generation/i);
  expect(out.reason).not.toMatch(/tripod/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — the reason mentions the tripod, or the call succeeds.

- [ ] **Step 3: Implement.** A mismatch is unreconcilable when the baseline carries a generation stamp, the `imuMounting` carries one, and the baseline has no `tiltAnchorDeg` recorded — meaning it was written before this plan and its anchor is unknown. `UNKNOWN_GENERATION` on either side is also unreconcilable. In both cases refuse, leave limits untouched and `needsRezero` set, and name the mismatch and the remedy (re-solve, or re-run `characterize_imu`).

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/src/geo-tools.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "fix(rezero): name a generation mismatch instead of blaming the tripod"
```

---

### Task 5: Arm the guard before the server accepts requests, and protect the sweep

**Files:**
- Modify: `tb3-mcp/src/server.ts` (~line 300), `tb3-mcp/src/boot-poll.ts`, `tb3-mcp/src/imu-tools.ts`
- Test: `tb3-mcp/test/boot-poll.test.ts` (append), `tb3-mcp/test/imu-tools.test.ts` (append; create if absent)

Closes **I-A** and **I-B**.

**I-A:** `realScheduler.every` is `setInterval`, which first fires at `intervalMs`, so no `observe()` runs until t+5 s — and the two-host `fetchDeviceUptimeMs` retry can push detection to the second tick. In exactly the case the unobserved-reboot check exists for, `calibration.json` still says `needsRezero:false`, so every gated tool runs on the stale origin for 5–11 s after a daemon restart. Fix: `BootWatchPoller` runs one tick immediately on `start()`, and `server.ts` awaits it before `app.listen()`.

**I-B:** `sweepPositionsFor` derives its waypoints from `effLimits()`, so with pan cleared and the ±180° config ceiling it builds a ~354° pan sweep and drives it unattended. Fix: `characterize_imu` refuses when pan is untaught **and** `needsRezero` is set, naming both conditions and the remedy (teach the pan edges first).

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/boot-poll.test.ts
it("marks needsRezero before the server would accept requests", async () => {
  const { calib, limits, boot, scheduler } = pollerHarness();   // use this file's existing harness
  const poller = new BootWatchPoller(/* as the neighbouring tests construct it */);
  await poller.start();          // must perform one tick, not just schedule
  expect(calib.needsRezero()).toBe(true);
  expect(scheduler.tickCount).toBe(0);   // no scheduled tick has fired yet
});
```

```ts
// append to tb3-mcp/test/imu-tools.test.ts
it("refuses to sweep when pan is untaught and a re-zero is pending", async () => {
  const { store, limits } = imuHarness();   // use this file's existing harness
  store.markRezeroNeeded(2);
  limits.clearAxis("pan");
  const res = await characterizeImu(/* as the neighbouring tests call it */);
  expect(JSON.stringify(res)).toMatch(/pan/i);
  expect(JSON.stringify(res)).toMatch(/re-zero|rezero/i);
});
```

**The harness names above are ILLUSTRATIVE.** Read both test files first and express these assertions with whatever fakes they already build. What must be asserted is fixed: `start()` marks `needsRezero` before any scheduled tick fires, and `characterize_imu` refuses under those two conditions naming both.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/boot-poll.test.ts test/imu-tools.test.ts`
Expected: FAIL — `needsRezero` is still false after `start()`; `characterize_imu` proceeds.

- [ ] **Step 3: Implement.** `start()` must remain safe to call when the device is unreachable — the immediate tick goes through the same try/catch as a scheduled one, and a failure must not prevent scheduling.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/server.ts tb3-mcp/src/boot-poll.ts tb3-mcp/src/imu-tools.ts tb3-mcp/test/boot-poll.test.ts tb3-mcp/test/imu-tools.test.ts
git commit -m "fix(rezero): arm the guard at startup and refuse an unbounded characterize sweep"
```

---

### Task 6: Tell the operator

**Files:**
- Modify: `tb3-mcp/src/rezero-tools.ts` (`get_rezero_status` payload and tool description)
- Modify: `tb3-mcp/dashboard/public/` — add re-zero state to the existing status surface
- Test: `tb3-mcp/test/rezero-mcp-tools.test.ts` (append), `tb3-mcp/scripts/dashboard-smoke.mjs`

Closes **I-C** and **M-2**.

**I-C:** `grep -rn "rezero" tb3-mcp/dashboard/` returns nothing. The operator's primary surface shows a normally calibrated rig while every automated motion tool refuses, pan limits are gone, and sun protection is degraded.

**M-2:** `residual_deg` reads as an accuracy figure and is not one. With one unknown fitted to one constraint it is nearly blind to centring error — 0.132° reported for a 2.7°-wrong re-zero. Rename the field to `fit_residual_deg` everywhere it is reported, and say in the tool description that pointing accuracy after a landmark re-zero equals centring accuracy.

The dashboard must show, when `needs_rezero` is true: that a re-zero is pending, that pan limits are cleared, that sun protection is degraded, and the remedy. Follow the existing status-panel patterns — vanilla ES modules, no build step, no new dependencies.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/rezero-mcp-tools.test.ts
it("reports fit_residual_deg, not residual_deg, and says what it is not", async () => {
  const res = await client.callTool({ name: "get_rezero_status", arguments: {} });
  const body = JSON.stringify(res);
  expect(body).toMatch(/fit_residual_deg/);
  expect(body).not.toMatch(/"residual_deg"/);
});
```

Add a dashboard smoke assertion in `tb3-mcp/scripts/dashboard-smoke.mjs` following that file's existing style: with `needs_rezero` true, the rendered status surface contains the pending-re-zero notice and mentions the sun guard.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/rezero-mcp-tools.test.ts && node scripts/dashboard-smoke.mjs`
Expected: FAIL — `residual_deg` still present; the dashboard renders nothing about a re-zero.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run && node scripts/dashboard-smoke.mjs`
Expected: PASS. Run the smoke script twice to confirm it is not flaky.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/dashboard/public tb3-mcp/test/rezero-mcp-tools.test.ts tb3-mcp/scripts/dashboard-smoke.mjs
git commit -m "feat(rezero): surface the pending re-zero, and stop calling a fit residual an accuracy"
```

---

### Task 7: Make the acceptance test exercise the production path

**Files:**
- Modify: `tb3-mcp/test/rezero-tools.test.ts` (the existing multi-cycle acceptance test)

The existing test builds its calibration with `setBaseline` — which has **zero production callers** — and hardcodes one `bootId` for every cycle. So it never touches `setGravityCalibration`, and `edgeBootId` reconciliation is never exercised across generations. **That is precisely the crack this whole plan's defect fell through.**

- [ ] **Step 1: Rewrite the acceptance test**

Change it to establish its calibration through the same path production uses (`setGravityCalibration`, with the anchor maintained as Task 3 does it), and to advance `bootId` by one per cycle so every artifact's stamp changes generation. Keep all existing assertions — pointing error at an independent posture, both tilt edges, pan cleared — and add one asserting `getBaselineGeneration()` and `getImuMountingGeneration()` are reconciled rather than coincidentally equal.

- [ ] **Step 2: Confirm it still bites**

Remove `- calib.getTiltAnchorDeg()` from `rezeroFromEnu`. The rewritten acceptance test MUST fail. Restore it. Then mutate `setOriginOffset` to accumulate instead of assign; it MUST fail again. Restore. Report both.

If either mutation leaves it passing, the rewrite lost the test's teeth and must be strengthened before commit.

- [ ] **Step 3: Run the full suite and both typechecks**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npx tsc -p tsconfig.json --noEmit`
Expected: all pass; 0 build-config errors; 27× TS7016.

- [ ] **Step 4: Commit**

```bash
git add tb3-mcp/test/rezero-tools.test.ts
git commit -m "test(rezero): exercise the production solve path and changing generations"
```

---

## Manual verification on the rig

Only after the whole plan is green. The branch must not be deployed before that.

1. Calibrate fully, `set_landmark`, note pointing on a known target.
2. Power-cycle, re-zero from the landmark, confirm pointing restored.
3. **Take two fresh sightings and re-solve** — the one-click dashboard path.
4. **Power-cycle again and re-zero.** This is the sequence that produced `applied:true` with a 0.04° residual and a 1.11° pointing error. Confirm pointing is restored and no refusal blames the tripod.
5. Re-run `characterize_imu`, then repeat steps 2–4. Confirms the re-anchor.
6. Restart the daemon immediately after a power cycle and confirm `track_aircraft` refuses straight away rather than for the first few seconds running on a stale origin.
7. With pan limits cleared, confirm `characterize_imu` refuses rather than starting a ~354° sweep.
