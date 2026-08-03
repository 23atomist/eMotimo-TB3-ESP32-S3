# Re-zero Frame Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make re-zero idempotent across any number of reboot/re-zero cycles by stating one frame convention, and close the four safety findings from the same review.

**Architecture:** Persist an immutable baseline calibration (`R0`, `cHead0`) plus a cumulative origin offset; derive the live orientation and `cHead` rather than storing them. Every solve runs against the baseline, so applying a re-zero is an assignment rather than an accumulation and N cycles behave exactly like one.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-rezero-frame-convention-design.md`
**Branch:** continues `feat/reboot-rezero` (currently at `0772a1a`, 121 files / 1238 tests). This branch is BLOCKED from merge until this plan completes.

## Global Constraints

- **No new npm dependencies.**
- **`imuMounting.dBase` must never be rewritten** outside `characterize_imu`. The pan/tilt decoupling holds only because `dBase` sits ~1.45° off the pan axis *in the original frame*; re-stamping it at a shifted origin collapses the decoupling (measured: `onReboot` tilt residual rises to 4.43°, past `MAX_TILT_RESIDUAL_DEG`).
- **Applying a re-zero is an assignment, not an accumulation.** `originOffset = {panDeg: ΔpanTotal, tiltDeg: ΔtiltTotal}`. Never `+=`.
- **Every solve runs against the baseline** (`R0`/`cHead0`), never against derived live values.
- Rotation convention: `mountHeadRotation(panDeg, tiltDeg) = matMul(rotZ(deg2rad(-panDeg)), rotX(deg2rad(tiltDeg)))` — note the NEGATIVE on pan.
- `MAX_TILT_RESIDUAL_DEG = 3.0`, `MAX_PAN_RESIDUAL_DEG = 3.0`.
- `Vec3`/`Mat3` are `readonly` tuples; build new values, never mutate.
- All new persisted schema fields `.optional()` so existing profiles parse.
- Tests: `npx vitest run` from `tb3-mcp/`. Typecheck: `npx tsc -p tsconfig.build.json --noEmit` must be **0 errors**; `npx tsc -p tsconfig.json --noEmit` must stay at the pre-existing **27× TS7016 + 1× TS2304**.
- Never use `--no-verify` (a hook blocks it). If a commit fails with a 1Password signing error, STOP and report — the controller re-runs it.

---

### Task 1: Baseline and cumulative origin offset

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts` (append — the file exists)

**Interfaces:**
- Produces on `CalibrationStore`:
  - `setBaseline(R0: Mat3, cHead0: Vec3, solvedAtIso: string): void` — records the baseline and zeroes `originOffset`
  - `getBaseline(): { R0: Mat3; cHead0: Vec3 } | undefined`
  - `getOriginOffset(): { panDeg: number; tiltDeg: number }` — `{panDeg: 0, tiltDeg: 0}` when unset
  - `setOriginOffset(panDeg: number, tiltDeg: number, bootId: number): void` — ASSIGNS, clears `needsRezero`
  - `getOrientation()` and `getCHead()` become DERIVED from baseline + offset

**Schema additions to `ProfileSchema`:**

```ts
  // The calibration exactly as solved, in the step-origin frame that solve was
  // performed in. Immutable until the next real solve. Every re-zero measures
  // against THIS, which is what makes applying one an assignment rather than an
  // accumulation -- run it N times with the same inputs and the state matches.
  baseline: z.object({
    R0: z.array(z.number()).length(9),
    cHead0: z.array(z.number()).length(3),
  }).optional(),
  // Cumulative offset from the baseline's step origin to the current one.
  // Zero at solve time. ASSIGNED by a re-zero, never incremented.
  originOffset: z.object({ panDeg: z.number(), tiltDeg: z.number() }).optional(),
```

- [ ] **Step 1: Write the failing test**

```ts
// append to tb3-mcp/test/calibration.test.ts
describe("baseline and origin offset", () => {
  const R0: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
  const C0: Vec3 = normalize([0.02, 0.99, 0.08]);

  it("getOrientation/getCHead derive from baseline + offset", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    expect(s.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    // With a zero offset the derived values ARE the baseline.
    expect(s.getOrientation()).toEqual(R0);
    expect(s.getCHead()).toEqual(C0);

    s.setOriginOffset(16.4, 23.33, 2);
    expect(s.getOriginOffset()).toEqual({ panDeg: 16.4, tiltDeg: 23.33 });
    expect(angleBetweenDeg(s.getCHead()!, applyTiltOffset(C0, 23.33))).toBeLessThan(1e-9);
    expect(s.getOrientation()).not.toEqual(R0);   // pan folded in
  });

  // The property the whole design exists for.
  it("setOriginOffset ASSIGNS — applying twice equals applying once", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    s.setOriginOffset(16.4, 23.33, 2);
    const afterFirst = JSON.stringify(s.get());
    s.setOriginOffset(16.4, 23.33, 2);
    expect(JSON.stringify(s.get())).toBe(afterFirst);
  });

  it("setOriginOffset clears needsRezero and stamps bootId", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    s.markRezeroNeeded(3);
    s.setOriginOffset(1, 2, 3);
    expect(s.needsRezero()).toBe(false);
    expect(s.getBootId()).toBe(3);
  });

  // Migration: a pre-baseline profile must keep pointing identically.
  it("adopts a legacy orientation/cHead as the baseline with a zero offset", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    const a = new CalibrationStore(path); a.load();
    a.setGravityCalibration(R0, C0, new Date().toISOString());
    // Strip the baseline to simulate a profile written before this change.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.baseline; delete raw.originOffset;
    writeFileSync(path, JSON.stringify(raw));

    const b = new CalibrationStore(path); b.load();
    expect(b.getOrientation()).toEqual(R0);
    expect(b.getCHead()).toEqual(C0);
    expect(b.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    expect(b.getBaseline()).toBeDefined();
  });
});
```

Add to the test file's imports: `matMul`, `rotZ`, `rotX`, `deg2rad`, `normalize`, `angleBetweenDeg` from `../src/geo/vec3.js`; `applyTiltOffset` from `../src/geo/rezero.js`; `readFileSync`, `writeFileSync` from `node:fs`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: FAIL — `setBaseline is not a function`.

- [ ] **Step 3: Implement**

Add the schema fields above, then:

```ts
  setBaseline(R0: Mat3, cHead0: Vec3, solvedAtIso: string): void {
    const flat = [R0[0][0], R0[0][1], R0[0][2], R0[1][0], R0[1][1], R0[1][2], R0[2][0], R0[2][1], R0[2][2]];
    this.profile = {
      ...this.profile,
      baseline: { R0: flat, cHead0: [cHead0[0], cHead0[1], cHead0[2]] },
      originOffset: { panDeg: 0, tiltDeg: 0 },
      solvedAt: solvedAtIso,
      // A fresh solve supersedes any pending re-zero and any landmark recorded
      // under the calibration being replaced.
      needsRezero: undefined, landmark: undefined,
    };
    this.save();
  }

  getBaseline(): { R0: Mat3; cHead0: Vec3 } | undefined {
    const b = this.profile.baseline;
    if (!b) return undefined;
    return {
      R0: [[b.R0[0], b.R0[1], b.R0[2]], [b.R0[3], b.R0[4], b.R0[5]], [b.R0[6], b.R0[7], b.R0[8]]],
      cHead0: [b.cHead0[0], b.cHead0[1], b.cHead0[2]],
    };
  }

  getOriginOffset(): { panDeg: number; tiltDeg: number } {
    return this.profile.originOffset ?? { panDeg: 0, tiltDeg: 0 };
  }

  // ASSIGN. Never increment: the offsets handed here are cumulative from the
  // baseline, so assigning is what makes a re-zero idempotent.
  setOriginOffset(panDeg: number, tiltDeg: number, bootId: number): void {
    this.profile = {
      ...this.profile, originOffset: { panDeg, tiltDeg },
      bootId, needsRezero: undefined,
    };
    this.save();
  }
```

Rewrite the two getters to derive, and add migration in `load()`:

```ts
  getOrientation(): Mat3 | undefined {
    const b = this.getBaseline();
    if (!b) return undefined;
    return applyPanOffset(b.R0, this.getOriginOffset().panDeg, this.geoPanSign);
  }

  getCHead(): Vec3 | undefined {
    const b = this.getBaseline();
    if (!b) return undefined;
    return applyTiltOffset(b.cHead0, this.getOriginOffset().tiltDeg);
  }
```

`CalibrationStore` needs `geoPanSign` to derive the orientation. Add it as a
second constructor parameter (`constructor(filePath: string, geoPanSign = 1)`)
and pass `cfg.geoPanSign` at the single construction site in `src/server.ts`.
Defaulting to 1 keeps every existing test construction compiling.

Migration, at the end of `load()`:

```ts
    // A profile written before the baseline existed carries orientation/cHead
    // directly. Adopt them as the baseline with a zero offset: exactly correct
    // for a freshly-solved calibration, and no worse than the previous
    // behaviour for anything else. No operator action, no re-solve.
    if (!this.profile.baseline && this.profile.orientation) {
      this.profile = {
        ...this.profile,
        baseline: {
          R0: this.profile.orientation,
          cHead0: this.profile.cHead ?? [0, 1, 0],
        },
        originOffset: this.profile.originOffset ?? { panDeg: 0, tiltDeg: 0 },
      };
    }
```

Keep `orientation`/`cHead` in the schema — `setOrientation`/`setGravityCalibration`
still write them and the migration reads them — but they are no longer the source
of truth for the getters.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts && npx vitest run`
Expected: PASS. If other suites fail, they were relying on `getOrientation()`
returning a stored value — fix by having their setup call `setBaseline`.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/src/server.ts tb3-mcp/test/calibration.test.ts
git commit -m "feat(rezero): derive orientation and cHead from an immutable baseline"
```

---

### Task 2: Limits track what has already been applied

**Files:**
- Modify: `tb3-mcp/src/limits-store.ts`
- Test: `tb3-mcp/test/limits-store.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `LimitsStore.getAppliedOffset(): { panDeg: number; tiltDeg: number }`, `LimitsStore.setAppliedOffset(panDeg: number, tiltDeg: number): void`

Schema addition: `appliedOffset: z.object({ panDeg: z.number(), tiltDeg: z.number() }).optional()`.

Stored with the limits rather than the calibration because it describes what has
already been done *to these edges*. It also survives a daemon restart, which the
current in-memory pan-limit `WeakMap` stash does not.

- [ ] **Step 1: Write the failing test**

```ts
// append to tb3-mcp/test/limits-store.test.ts
describe("appliedOffset", () => {
  it("defaults to zero and round-trips through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json");
    const a = new LimitsStore(path); a.load();
    expect(a.getAppliedOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    a.setAppliedOffset(16.4, 23.33);
    const b = new LimitsStore(path); b.load();
    expect(b.getAppliedOffset()).toEqual({ panDeg: 16.4, tiltDeg: 23.33 });
  });

  // The delta is what makes repeated re-zeros safe for the limits.
  it("shifting by the delta twice equals shifting once", () => {
    const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json"));
    s.load();
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    const applyCumulative = (tiltTotal: number) => {
      const prev = s.getAppliedOffset();
      s.shiftAxis("tilt", -(tiltTotal - prev.tiltDeg));
      s.setAppliedOffset(prev.panDeg, tiltTotal);
    };
    applyCumulative(23.33);
    const once = { ...s.get() };
    applyCumulative(23.33);                       // same cumulative value again
    expect(s.get().tiltMin).toBeCloseTo(once.tiltMin as number, 9);
    expect(s.get().tiltMax).toBeCloseTo(once.tiltMax as number, 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/limits-store.test.ts`
Expected: FAIL — `getAppliedOffset is not a function`.

- [ ] **Step 3: Implement**

```ts
  getAppliedOffset(): { panDeg: number; tiltDeg: number } {
    return this.limits.appliedOffset ?? { panDeg: 0, tiltDeg: 0 };
  }

  setAppliedOffset(panDeg: number, tiltDeg: number): void {
    this.limits = { ...this.limits, appliedOffset: { panDeg, tiltDeg } };
    this.save();
  }
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/limits-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/limits-store.ts tb3-mcp/test/limits-store.test.ts
git commit -m "feat(rezero): record which origin offset the taught limits already carry"
```

---

### Task 3: Solve against the baseline — the core fix

This is the task that fixes the defect. The multi-cycle test is the acceptance
criterion for the whole plan.

**Files:**
- Modify: `tb3-mcp/src/rezero-tools.ts`
- Test: `tb3-mcp/test/rezero-tools.test.ts` (append)

**Interfaces:**
- Consumes: `setBaseline/getBaseline/getOriginOffset/setOriginOffset` (Task 1); `getAppliedOffset/setAppliedOffset` (Task 2).
- Produces: no signature changes to `onReboot`/`rezeroFromEnu`.

**Changes:**

1. `rezeroFromEnu` passes **`baseline.R0`** to `solvePanOffset`, not
   `calib.getOrientation()`, and `applyTiltOffset(baseline.cHead0, ΔtiltTotal)`
   as its `cHead`. Both returned offsets are then cumulative from the baseline.
2. Apply with `calib.setOriginOffset(ΔpanTotal, ΔtiltTotal, bootId)` —
   assignment. `applyRezero` is no longer used by this path; delete it if
   nothing else calls it.
3. Both `onReboot` and `rezeroFromEnu` shift limits by the **delta** against
   `limits.getAppliedOffset()`, then `setAppliedOffset` to the new cumulative
   values.
4. **Delete the pan-limit `WeakMap` stash** and the clear-then-restore dance.
   With delta shifting, pan limits are simply shifted like tilt — there is
   nothing to clear and nothing to restore, which removes the daemon-restart
   hole the operator previously had to accept. Keep the live-value check that
   protects an operator's re-teach: an edge re-taught during the pending window
   is already in the current frame, so it must NOT be shifted. Record that by
   calling `setAppliedOffset` at teach time is out of scope; instead, `onReboot`
   records the offset it applied and `rezeroFromEnu` shifts only by the
   remaining delta, which leaves a re-taught edge correct as long as the
   operator re-teaches after `onReboot` — the only order the guard permits.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/rezero-tools.test.ts
describe("multi-cycle re-zero", () => {
  // THE acceptance test. Every prior re-zero test used a fresh store and one
  // cycle, which is exactly why the cumulative/incremental frame mismatch
  // survived seven task reviews.
  it("stays correct across three reboot/re-zero cycles on one store", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90);  limits.setEdge("panMax", 36);

    let panTotal = 0, tiltTotal = 0;
    for (const [dPan, dTilt] of [[3, 2], [30, 25], [40, 30]] as const) {
      panTotal += dPan; tiltTotal += dTilt;
      const truePan = -25, trueTilt = 19;
      const rptPan = truePan - panTotal, rptTilt = trueTilt - tiltTotal;

      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: rptPan, tiltDeg: rptTilt }), bootId: 2 });

      const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
        boresight(R, C, truePan, trueTilt), { panDeg: rptPan, tiltDeg: rptTilt },
        gravityAt(truePan, trueTilt));

      expect(res.applied).toBe(true);
      // Pointing must be restored for an INDEPENDENT posture, every cycle.
      const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
      expect(angleBetweenDeg(boresight(R2, C2, 60 - panTotal, 33 - tiltTotal),
                             boresight(R, C, 60, 33))).toBeLessThan(0.1);
      // And both limit edges must track the cumulative offset, not drift.
      expect(limits.get().tiltMin).toBeCloseTo(-20 - tiltTotal, 1);
      expect(limits.get().panMin).toBeCloseTo(-90 - panTotal, 1);
    }
  });

  it("is idempotent — re-zeroing twice with identical inputs changes nothing", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20);
    const dPan = 16.4, dTilt = 23.33, truePan = -25, trueTilt = 19;
    const args = { calib, limits, geoPanSign: GP, bootId: 2 };
    const ref = boresight(R, C, truePan, trueTilt);
    const post = { panDeg: truePan - dPan, tiltDeg: trueTilt - dTilt };

    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => post, bootId: 2 });
    await rezeroFromEnu(args, ref, post, gravityAt(truePan, trueTilt));
    const after1 = JSON.stringify({ c: calib.get(), l: limits.get() });

    calib.markRezeroNeeded(2);            // pretend it is pending again
    await rezeroFromEnu(args, ref, post, gravityAt(truePan, trueTilt));
    expect(JSON.stringify({ c: calib.get(), l: limits.get() })).toBe(after1);
  });

  // The row that reintroduced the mechanical-stop incident.
  it("two reboots before one re-zero reflect the TOTAL offset", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    const truePan = -25, trueTilt = 19;

    for (const tiltTotal of [10, 35]) {   // second reboot before any re-zero
      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: truePan, tiltDeg: trueTilt - tiltTotal }),
        bootId: 2 });
    }
    expect(limits.get().tiltMin).toBeCloseTo(-20 - 35, 1);
    expect(limits.get().tiltMax).toBeCloseTo(34 - 35, 1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — the three-cycle test fails at cycle 2 (pointing error ≈ 2°),
and the two-reboot test shows the tilt window shifted by 10 instead of 35.
**If these pass before you change anything, stop and report — the tests are not
reproducing the defect and are therefore worthless.**

- [ ] **Step 3: Implement the changes listed above**

The delta shift is the subtlest part; use exactly this shape in BOTH `onReboot`
(tilt) and `rezeroFromEnu` (pan and tilt), so neither can drift from the other:

```ts
// Shift a taught axis by only the part of the cumulative offset it does not
// already carry. Shifting by the cumulative value would re-apply everything
// previous cycles already did -- the defect this plan exists to fix.
function applyLimitDelta(
  limits: LimitsStore, panTotal: number, tiltTotal: number,
): void {
  const prev = limits.getAppliedOffset();
  if (panTotal !== prev.panDeg) limits.shiftAxis("pan", -(panTotal - prev.panDeg));
  if (tiltTotal !== prev.tiltDeg) limits.shiftAxis("tilt", -(tiltTotal - prev.tiltDeg));
  limits.setAppliedOffset(panTotal, tiltTotal);
}
```

`onReboot` calls it with `(prev.panDeg, ΔtiltTotal)` — it knows tilt only, and
must leave pan exactly as it is. `rezeroFromEnu` calls it with
`(ΔpanTotal, ΔtiltTotal)`.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Prove the assignment is load-bearing**

Change `setOriginOffset` to accumulate (`panDeg: prev.panDeg + panDeg`) instead
of assign. The three-cycle and idempotence tests MUST fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "fix(rezero): solve against the baseline so repeated re-zeros are idempotent"
```

---

### Task 4: A real solve clears the pending re-zero

**Files:**
- Modify: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts` (append)

Closes finding I2. Nothing clears `needsRezero` except a re-zero, so an operator
told "full recalibration required" who does exactly that is still refused, with a
message that is now false, pointing at a landmark recorded under the calibration
they just discarded.

- [ ] **Step 1: Write the failing test**

```ts
describe("a real solve supersedes a pending re-zero", () => {
  it("invalidateCalibration clears needsRezero, bootId, landmark and the offset", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    s.setLandmark({ label: "tower", enu: [0, 1, 0], panDeg: 1, tiltDeg: 2, recordedAt: "x" });
    s.markRezeroNeeded(4);
    s.invalidateCalibration();
    expect(s.needsRezero()).toBe(false);
    expect(s.getLandmark()).toBeUndefined();
    expect(s.getBootId()).toBeUndefined();
    expect(s.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("setGravityCalibration writes a fresh baseline and clears the pending re-zero", () => {
    const s = store();
    s.markRezeroNeeded(4);
    s.setGravityCalibration(R0, C0, new Date().toISOString());
    expect(s.needsRezero()).toBe(false);
    expect(s.getBaseline()).toBeDefined();
    expect(s.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    expect(s.getOrientation()).toEqual(R0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: FAIL — `needsRezero()` still true after `invalidateCalibration()`.

- [ ] **Step 3: Implement**

Add to `invalidateCalibration()`'s spread: `needsRezero: undefined, bootId: undefined, landmark: undefined, baseline: undefined, originOffset: undefined`.

Make `setOrientation` and `setGravityCalibration` call `setBaseline` (which
already clears `needsRezero` and `landmark` and zeroes the offset) rather than
writing `orientation`/`cHead` alone.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/test/calibration.test.ts
git commit -m "fix(rezero): a real solve clears a pending re-zero and its stale landmark"
```

---

### Task 5: Refuse a gravity read the posture cannot vouch for

**Files:**
- Modify: `tb3-mcp/src/rezero-tools.ts`, `tb3-mcp/src/server.ts` (the `posture` dep)
- Test: `tb3-mcp/test/rezero-tools.test.ts` (append)

Closes finding I3. `onReboot` reads gravity over HTTP but posture from the
WebSocket tick cache, discarding `connected`, `lastUpdateMs` and `moving`. The
poll can detect a reboot before the WS reconnects, so a stale posture is paired
with a true gravity read. Measured at a real 23.33° offset: `applied: true`,
`Δtilt −6.75e−17`, `residual 0.00°`, limits shifted by nothing — logged as
success. `geo-tools.ts:302-324` and `imu-tools.ts:203-220` already guard exactly
this pairing; adopt their convention.

**Change:** widen the `posture` dep to return `{ panDeg, tiltDeg, moving, staleMs }`
(`staleMs` = `Date.now() - lastUpdateMs`, `Infinity` when disconnected).
`onReboot` refuses — leaving limits untouched and `needsRezero` set — when
`staleMs > 2000` or `moving` is true, with a reason naming which.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses when the posture is stale rather than reporting a 0.00deg success", async () => {
  const { calib, limits, boot } = stores();
  calib.setImuMounting(RS, DB);
  calib.setBaseline(R, C, new Date().toISOString());
  limits.setEdge("tiltMin", -20);
  const out = await onReboot({ calib, limits, boot, geoPanSign: GP,
    gravity: async () => gravityAt(-25, 19),
    posture: async () => ({ panDeg: -25, tiltDeg: 19, moving: false, staleMs: 60_000 }),
    bootId: 2 });
  expect(out.applied).toBe(false);
  expect(out.reason).toMatch(/stale/i);
  expect(limits.get().tiltMin).toBe(-20);      // untouched, NOT shifted by ~0
  expect(calib.needsRezero()).toBe(true);
});

it("refuses while the rig is moving", async () => {
  const { calib, limits, boot } = stores();
  calib.setImuMounting(RS, DB);
  calib.setBaseline(R, C, new Date().toISOString());
  const out = await onReboot({ calib, limits, boot, geoPanSign: GP,
    gravity: async () => gravityAt(-25, 19),
    posture: async () => ({ panDeg: -25, tiltDeg: 19, moving: true, staleMs: 0 }),
    bootId: 2 });
  expect(out.applied).toBe(false);
  expect(out.reason).toMatch(/moving/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-tools.test.ts`
Expected: FAIL — `applied` is `true`.

- [ ] **Step 3: Implement**, updating `buildRezeroPosture` in `src/server.ts` to
  supply `moving` and `staleMs` from `device.getState()`.

**This widens the `posture` dependency, so every existing `posture:` fake in the
suite must gain `moving: false, staleMs: 0`** — including the ones added in
Task 3's multi-cycle tests. Update them; do not narrow the type to avoid it. If
the typecheck does not force you to touch them, the type is too loose.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/src/server.ts tb3-mcp/test/rezero-tools.test.ts
git commit -m "fix(rezero): refuse a gravity read paired with a stale or moving posture"
```

---

### Task 6: Gate in-flight tracking, and report the degraded sun guard

**Files:**
- Modify: `tb3-mcp/src/track/session.ts` (`tick()`), `tb3-mcp/src/rezero-tools.ts` (`get_rezero_status`)
- Test: `tb3-mcp/test/rezero-gating.test.ts` (append)

Closes finding I4. `rezeroGuard` is called only at four tool entry points, so a
session started BEFORE a reboot survives the outage — its deadman is refreshed by
the ADS-B poll, independent of the device — and resumes commanding jog vectors on
the stale calibration when the WebSocket reconnects.

`SunSupervisor` is deliberately **not** gated: it computes both its cone test and
its park plan from the orientation, so gating it removes sun protection entirely.
Instead `get_rezero_status` reports that sun protection is degraded while
`needsRezero` is set, and the tool description says so.

- [ ] **Step 1: Write the failing test**

```ts
it("an active session parks and issues no commands while a re-zero is pending", async () => {
  const { session, device, calib } = makeSessionHarness();   // existing helper style
  await session.start(/* ...as the neighbouring session tests do... */);
  device.commands.length = 0;
  calib.markRezeroNeeded(2);
  session.tick();
  expect(device.commands).toHaveLength(0);
  expect(session.status().state).toBe("parked");
});

it("get_rezero_status reports the sun guard as degraded while pending", async () => {
  // through the MCP layer, as the other gating tests do
  const res = await client.callTool({ name: "get_rezero_status", arguments: {} });
  expect(JSON.stringify(res)).toMatch(/sun/i);
  expect(JSON.stringify(res)).toMatch(/degraded/i);
});
```

**The helper names above (`makeSessionHarness`, `session.status()`,
`device.commands`) are ILLUSTRATIVE, not real.** Read
`test/rezero-gating.test.ts` and `test/track-tools.test.ts` first and express
these two assertions using whatever harness those files already provide — the
`InMemoryTransport` client, the existing device mock, and however a
`TrackingSession` is constructed there. What must be asserted is fixed: no
device command is issued after `tick()` while `needsRezero` is set, and the
session reports itself parked. How you reach that is the existing harness's
business, not this plan's.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-gating.test.ts`
Expected: FAIL — the session still commands.

- [ ] **Step 3: Implement.** `TrackingSession` needs the store; add it as a
  constructor dependency and pass it at the construction site in `src/server.ts`.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/track/session.ts tb3-mcp/src/rezero-tools.ts tb3-mcp/src/server.ts tb3-mcp/test/rezero-gating.test.ts
git commit -m "fix(rezero): park an in-flight session and report the degraded sun guard"
```

---

### Task 7: Preconditions on the re-zero tools

**Files:**
- Modify: `tb3-mcp/src/rezero-tools.ts`
- Test: `tb3-mcp/test/rezero-mcp-tools.test.ts` (append)

Closes finding I5. `set_landmark`, `rezero_from_landmark` and
`rezero_from_aircraft` persist calibration state while checking neither
`session.isActive()`, `supervisor.isSunLocked()`, nor `moving`. Seven other tools
in this codebase carry the `"tracking active; stop_tracking first"` guard for
exactly this reason.

- [ ] **Step 1: Write the failing test**

```ts
it.each(["set_landmark", "rezero_from_landmark", "rezero_from_aircraft"])(
  "%s refuses while tracking is active", async (tool) => {
    session.setActive(true);
    const res = await client.callTool({ name: tool, arguments: tool === "set_landmark"
      ? { label: "tower" } : tool === "rezero_from_aircraft" ? { hex: "abc123" } : {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/stop_tracking/);
  });

it("rezero_from_landmark refuses while the rig is moving", async () => {
  device.state.moving = true;
  const res = await client.callTool({ name: "rezero_from_landmark", arguments: {} });
  expect(res.isError).toBe(true);
  expect(JSON.stringify(res)).toMatch(/moving/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/rezero-mcp-tools.test.ts`
Expected: FAIL — the tools succeed.

**`session.setActive(true)` and `device.state.moving` above are ILLUSTRATIVE.**
Read `test/rezero-mcp-tools.test.ts` and use whatever session/device fakes it
already builds. The fixed requirement is that each of the three tools returns
`isError: true` naming `stop_tracking` while a session is active, and that
`rezero_from_landmark` refuses while `moving`.

- [ ] **Step 3: Implement**, matching the wording of the existing
  `"tracking active; stop_tracking first"` guards. Also read posture before AND
  after the gravity burst in `rezero_from_landmark`/`rezero_from_aircraft` and
  refuse if it changed, per Task 5's convention.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/rezero-tools.ts tb3-mcp/test/rezero-mcp-tools.test.ts
git commit -m "fix(rezero): add the session/sun/moving preconditions the other tools carry"
```

---

## Manual verification on the rig

Only after the whole plan is green. The branch must not be deployed before that.

1. Calibrate fully, `set_landmark("<fixed distant object>")`, note pointing on a known target.
2. **Power-cycle twice in a row without re-zeroing.** Confirm the tilt limits reflect the TOTAL offset, not the first one. This is the row that reintroduced the mechanical-stop incident.
3. Re-zero from the landmark. Confirm pointing is restored and both limit edges are right.
4. **Repeat the whole cycle three times.** Cycle 2 is where the old code silently reported success with a 2° error; cycle 3 is where it refused and blamed the tripod.
5. Confirm `get_rezero_status` reports the sun guard as degraded while a re-zero is pending.
6. Start a track, power-cycle mid-track, confirm the session parks and issues no commands on reconnect.
