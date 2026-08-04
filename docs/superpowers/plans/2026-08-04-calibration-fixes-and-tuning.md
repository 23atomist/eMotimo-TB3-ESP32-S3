# Calibration Fixes and Runtime Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `set_north_zero` destroying a solved camera boresight, give the aim trim enough range to be usable, and make the values an operator reaches for mid-session adjustable without a restart.

**Architecture:** Two targeted fixes in `CalibrationStore` and the nudge clamp, plus a `TuningStore` following `LimitsStore`/`SectorStore` exactly — Zod-validated, atomic tmp-then-rename, all fields optional. Tuned values resolve **at point of use** rather than at startup, which is what lets a change take effect without restarting.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest, vanilla-JS dashboard (no build step). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-04-calibration-fixes-and-tuning-design.md`
**Branch:** new branch off `feat/dashboard-redesign`. **Not** `feat/reboot-rezero`, which is parked and blocked.

## Global Constraints

- **No new npm dependencies.** `tb3-mcp/dashboard/public/` is vanilla ES modules served static — **no build step may be added**.
- New persisted stores follow `src/sector-store.ts` exactly: Zod schema, `load()` that never throws on missing/corrupt input, atomic write via `writeFileSync(tmp)` + `renameSync`.
- **Tuned values are resolved at the point of use, never captured at startup.** A value that requires a restart to take effect fails this feature's purpose.
- All `TuningStore` fields are optional; absent means "fall through to the config value".
- Ranges: `maxAimOffsetDeg` 0 < x ≤ 45; `calibVideoLatencyMs` 0 < x ≤ 5000; `trackLeadMs` 0 ≤ x ≤ 5000; `captureTimeoutMs` 0 < x ≤ 60000.
- `Vec3`/`Mat3` are `readonly` tuples; build new values, never mutate.
- Tests: `npx vitest run` from `tb3-mcp/`. Typecheck: `npx tsc -p tsconfig.build.json --noEmit` **0 errors**; `npx tsc -p tsconfig.json --noEmit` at its pre-existing baseline (record the count before you start; do not let it drift upward without saying why).
- Never `--no-verify` (a hook blocks it). **Forbidden git commands:** `git reset`, `git checkout --`, `git clean`, `git stash` — a subagent destroyed working-tree edits this way. Use `cp` backups for experiments.
- If a commit fails with a 1Password signing error, **STOP and report** — the controller re-runs it.

---

### Task 1: `set_north_zero` stops destroying a solved boresight

Ship this first and alone. It is the defect that took a working rig out of service this morning, and it is independently useful.

**Files:**
- Modify: `tb3-mcp/src/calibration.ts` (`setProvisionalOrientation`)
- Test: `tb3-mcp/test/calibration.test.ts` (append — the file exists)

**Interfaces:**
- Produces: no signature change. `setProvisionalOrientation(R, solvedAtIso)` keeps an existing `cHead` instead of clearing it.

**Why.** `cHead` is camera→mount: how the camera is bolted to the head. The orientation is mount→ENU. Re-declaring which way is north cannot change the first. Clearing it asserts a boresight of zero, which on the field rig is wrong by ~31° — enough to put every aircraft outside the frame.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/calibration.test.ts
describe("set_north_zero preserves a solved boresight", () => {
  const R0: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
  const C0: Vec3 = normalize([0.415, 0.855, 0.310]);   // the field rig's real ~31deg offset
  const R1: Mat3 = matMul(rotZ(deg2rad(-40)), rotX(deg2rad(1)));

  it("keeps cHead when a north-zero replaces the orientation", () => {
    const s = store();
    s.setGravityCalibration(R0, C0, new Date().toISOString());
    expect(s.getCHead()).toEqual(C0);

    s.setProvisionalOrientation(R1, new Date().toISOString());

    expect(s.getCHead()).toEqual(C0);          // the camera did not move on the head
    expect(s.isProvisional()).toBe(true);      // but the orientation is now a seed
    expect(s.getOrientation()).toEqual(R1);
  });

  it("still reports no cHead when none was ever solved", () => {
    const s = store();
    s.setProvisionalOrientation(R1, new Date().toISOString());
    expect(s.getCHead()).toBeUndefined();      // must not fabricate one
  });

  it("a north-zero after a TRIAD-only solve leaves cHead absent", () => {
    const s = store();
    s.setOrientation(R0, new Date().toISOString());   // TRIAD path clears cHead
    s.setProvisionalOrientation(R1, new Date().toISOString());
    expect(s.getCHead()).toBeUndefined();
  });
});
```

`store()`, `matMul`, `rotZ`, `rotX`, `deg2rad`, `normalize`, `Mat3`, `Vec3` are already used in that file; reuse the existing imports and add any that are missing.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: FAIL — the first test reports `cHead` is `undefined` after the north-zero.

- [ ] **Step 3: Implement**

```ts
  // set_north_zero's setter: the operator declares the CURRENT pointing as
  // true-north/level, combined with the characterized IMU gravity fix, into a
  // complete but PROVISIONAL orientation -- a seed for drift calibration, not
  // a solved one.
  //
  // cHead is DELIBERATELY preserved. It is camera->mount (how the camera is
  // bolted to the head); the orientation is mount->ENU. Re-declaring which way
  // is north cannot change how the camera is mounted, so clearing it would
  // assert a boresight of zero -- which on a rig whose camera sits ~31deg off
  // axis puts every target outside the frame, with the aim trim clamped far
  // too low to recover. That cost a field session on 2026-08-04.
  setProvisionalOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, orientationProvisional: true, solvedAt: solvedAtIso };
    this.save();
  }
```

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS. If another suite fails because it asserted `cHead` was cleared here, read that test before changing it — report it rather than editing it, since it may be pinning the old behaviour deliberately.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/calibration.ts tb3-mcp/test/calibration.test.ts
git commit -m "fix(calib): set_north_zero no longer discards a solved camera boresight"
```

---

### Task 2: The tuning store

**Files:**
- Create: `tb3-mcp/src/tuning-store.ts`
- Test: `tb3-mcp/test/tuning-store.test.ts`

**Interfaces:**
- Produces:
  - `export interface Tuning { maxAimOffsetDeg?: number; calibVideoLatencyMs?: number; trackLeadMs?: number; captureTimeoutMs?: number }`
  - `export class TuningStore { constructor(filePath: string); load(): void; get(): Tuning; set(patch: Tuning): void; clear(field: keyof Tuning): void }`

`set` takes a **partial** patch and merges. `clear` removes one override so it falls through to config.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/tuning-store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuningStore } from "../src/tuning-store.js";

function store(): { s: TuningStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "tuning.json");
  const s = new TuningStore(path); s.load();
  return { s, path };
}

describe("TuningStore", () => {
  it("starts empty and round-trips a patch through the file", () => {
    const { s, path } = store();
    expect(s.get()).toEqual({});
    s.set({ maxAimOffsetDeg: 30 });
    const b = new TuningStore(path); b.load();
    expect(b.get().maxAimOffsetDeg).toBe(30);
  });

  it("set() MERGES rather than replacing", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30 });
    s.set({ trackLeadMs: 400 });
    expect(s.get()).toEqual({ maxAimOffsetDeg: 30, trackLeadMs: 400 });
  });

  it("clear() removes one override and leaves the rest", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30, trackLeadMs: 400 });
    s.clear("maxAimOffsetDeg");
    expect(s.get()).toEqual({ trackLeadMs: 400 });
  });

  it("rejects an out-of-range value WITHOUT corrupting what is stored", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30 });
    expect(() => s.set({ maxAimOffsetDeg: 90 })).toThrow();   // schema max is 45
    expect(s.get().maxAimOffsetDeg).toBe(30);                 // previous value intact
  });

  it("get() returns a copy, not a live reference into stored state", () => {
    const { s } = store();
    s.set({ trackLeadMs: 400 });
    const a = s.get();
    (a as { trackLeadMs?: number }).trackLeadMs = 9999;
    expect(s.get().trackLeadMs).toBe(400);
  });

  it("a missing file loads empty, and a corrupt file loads empty rather than throwing", () => {
    const { s } = store();
    expect(s.get()).toEqual({});
    const p2 = join(mkdtempSync(join(tmpdir(), "tb3-")), "tuning.json");
    writeFileSync(p2, "not json {");
    const c = new TuningStore(p2);
    expect(() => c.load()).not.toThrow();
    expect(c.get()).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/tuning-store.test.ts`
Expected: FAIL — cannot resolve `../src/tuning-store.js`.

- [ ] **Step 3: Implement**, following `src/sector-store.ts` for the load/save shape. Schema:

```ts
const TuningSchema = z.object({
  maxAimOffsetDeg: z.number().positive().max(45).optional(),
  calibVideoLatencyMs: z.number().positive().max(5000).optional(),
  trackLeadMs: z.number().nonnegative().max(5000).optional(),
  captureTimeoutMs: z.number().int().positive().max(60000).optional(),
});
```

Validate the **merged** result before writing, so a rejected patch cannot leave the store or the file half-updated.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run test/tuning-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/tuning-store.ts tb3-mcp/test/tuning-store.test.ts
git commit -m "feat(tuning): operator-adjustable runtime tuning store"
```

---

### Task 3: Resolve tuned values at the point of use

**Files:**
- Create: `tb3-mcp/src/tuning-resolve.ts`
- Modify: `tb3-mcp/src/track/session.ts:205` (nudge clamp), `:341` and `:456` (track lead); `tb3-mcp/src/geo-tools.ts:170` (video latency); `tb3-mcp/src/capture/snapshot.ts:54` (capture timeout); `tb3-mcp/src/config.ts` (`maxAimOffsetDeg` default)
- Test: `tb3-mcp/test/tuning-resolve.test.ts`

**Interfaces:**
- Consumes: `TuningStore`, `Tuning` from Task 2.
- Produces: `export function resolveTuning(tuning: TuningStore | undefined, cfg: Config): Required<Tuning>` — returns every field with the tuned value if present, else the config value.

Also in this task: **`maxAimOffsetDeg`'s default rises from 5 to 20** in `src/config.ts`.

**The point of this task is that the read happens when the value is used.** Each call site must call `resolveTuning(...)` (or an equivalent per-field getter) at the moment it needs the number — not once at construction. A value captured into a field at startup cannot change without a restart, which defeats the feature.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/tuning-resolve.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuningStore } from "../src/tuning-store.js";
import { resolveTuning } from "../src/tuning-resolve.js";

const cfg = { maxAimOffsetDeg: 20, calibVideoLatencyMs: 300, trackLeadMs: 150, captureTimeoutMs: 10000 } as never;

describe("resolveTuning", () => {
  it("falls through to config when nothing is tuned", () => {
    const s = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "t.json")); s.load();
    expect(resolveTuning(s, cfg)).toEqual({
      maxAimOffsetDeg: 20, calibVideoLatencyMs: 300, trackLeadMs: 150, captureTimeoutMs: 10000,
    });
  });

  it("a tuned value overrides config, others still fall through", () => {
    const s = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "t.json")); s.load();
    s.set({ maxAimOffsetDeg: 35 });
    const r = resolveTuning(s, cfg);
    expect(r.maxAimOffsetDeg).toBe(35);
    expect(r.trackLeadMs).toBe(150);
  });

  it("a later change is visible WITHOUT rebuilding anything — this is the whole feature", () => {
    const s = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "t.json")); s.load();
    expect(resolveTuning(s, cfg).maxAimOffsetDeg).toBe(20);
    s.set({ maxAimOffsetDeg: 35 });
    expect(resolveTuning(s, cfg).maxAimOffsetDeg).toBe(35);
  });

  it("tolerates an absent store (tuning not wired) and returns config", () => {
    expect(resolveTuning(undefined, cfg).trackLeadMs).toBe(150);
  });
});
```

Plus one test per call site proving the value is read live. For the nudge clamp, which is the one that stranded the operator:

```ts
// append to tb3-mcp/test/track-tools.test.ts (or the session test file, whichever
// already constructs a TrackingSession — read it first and follow its harness)
it("the nudge clamp honours a tuning change made after the session was constructed", () => {
  const { session, tuning } = sessionHarness();   // use the file's existing helper
  tuning.set({ maxAimOffsetDeg: 30 });
  const wide = session.nudgeOffset(25, 0);
  expect(wide.panDeg).toBeCloseTo(25, 3);
  expect(wide.panClamped).toBe(false);

  tuning.set({ maxAimOffsetDeg: 5 });
  const narrow = session.nudgeOffset(25, 0);
  expect(Math.abs(narrow.panDeg)).toBeLessThanOrEqual(5);
  expect(narrow.panClamped).toBe(true);           // clamping must be REPORTED, not silent
});
```

**`sessionHarness()` is illustrative.** Read the existing session/track test files first and express this with whatever they already build. What is fixed: the clamp changes without reconstructing the session, and a clamped nudge reports `panClamped`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/tuning-resolve.test.ts`
Expected: FAIL — cannot resolve `../src/tuning-resolve.js`.

- [ ] **Step 3: Implement.** Thread the `TuningStore` to each consumer through its existing deps/constructor — do not reach for a global. `src/server.ts` constructs one store and passes that same instance everywhere, as it already does for `CalibrationStore` and `LimitsStore`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, 0 errors.

- [ ] **Step 5: Prove the live-read is real**

For each of the four call sites, change the tuned value mid-test and confirm the new value is used without reconstructing the consumer. If any site still reads a startup-captured copy, fix it — a passing `resolveTuning` unit test does not prove the call sites use it correctly.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/tuning-resolve.ts tb3-mcp/src/config.ts tb3-mcp/src/track/session.ts tb3-mcp/src/geo-tools.ts tb3-mcp/src/capture/snapshot.ts tb3-mcp/src/server.ts tb3-mcp/test/
git commit -m "feat(tuning): resolve tunable values at point of use; raise aim-offset ceiling to 20deg"
```

---

### Task 4: `get_tuning` / `set_tuning` MCP tools

**Files:**
- Create: `tb3-mcp/src/tuning-tools.ts`
- Modify: `tb3-mcp/src/server.ts` (register)
- Test: `tb3-mcp/test/tuning-tools.test.ts`

**Interfaces:**
- Consumes: `TuningStore`, `resolveTuning`.
- Produces: `export function registerTuningTools(server: McpServer, deps: { tuning: TuningStore; cfg: Config }): void`

Both tools return, for **every** field: the effective value, its source (`"tuned"` or `"config"`), and its valid range. Reporting the source is a requirement, not a nicety — half of this morning's confusion was not knowing which value was actually in force.

`set_tuning` accepts a partial patch plus an optional `reset` array of field names to clear. An out-of-range value returns an error naming the field and its range, and changes nothing.

**`set_tuning` returns the same payload shape as `get_tuning`** — every field with its effective value and source, not just the fields that changed. The caller needs to see what is now in force, and a response listing only the patch invites the reader to assume the rest is unchanged when another field may have been reset in the same call. Add an assertion for this alongside the tests below.

- [ ] **Step 1: Write the failing tests**

```ts
// tb3-mcp/test/tuning-tools.test.ts — follow test/rezero-mcp-tools.test.ts's
// InMemoryTransport client harness; read that file first.
it("get_tuning reports effective value AND source for every field", async () => {
  const res = await client.callTool({ name: "get_tuning", arguments: {} });
  const body = JSON.stringify(res);
  for (const f of ["maxAimOffsetDeg", "calibVideoLatencyMs", "trackLeadMs", "captureTimeoutMs"]) {
    expect(body).toMatch(new RegExp(f));
  }
  expect(body).toMatch(/"source":"config"/);
});

it("set_tuning applies a value and flips its source to tuned", async () => {
  await client.callTool({ name: "set_tuning", arguments: { maxAimOffsetDeg: 30 } });
  const res = await client.callTool({ name: "get_tuning", arguments: {} });
  expect(JSON.stringify(res)).toMatch(/"maxAimOffsetDeg":\{"value":30,"source":"tuned"/);
});

it("set_tuning rejects out of range, names the range, and changes nothing", async () => {
  await client.callTool({ name: "set_tuning", arguments: { maxAimOffsetDeg: 30 } });
  const bad = await client.callTool({ name: "set_tuning", arguments: { maxAimOffsetDeg: 90 } });
  expect(bad.isError).toBe(true);
  expect(JSON.stringify(bad)).toMatch(/45/);
  const res = await client.callTool({ name: "get_tuning", arguments: {} });
  expect(JSON.stringify(res)).toMatch(/"maxAimOffsetDeg":\{"value":30/);
});

it("reset clears an override back to the config default", async () => {
  await client.callTool({ name: "set_tuning", arguments: { maxAimOffsetDeg: 30 } });
  await client.callTool({ name: "set_tuning", arguments: { reset: ["maxAimOffsetDeg"] } });
  expect(JSON.stringify(await client.callTool({ name: "get_tuning", arguments: {} })))
    .toMatch(/"maxAimOffsetDeg":\{"value":20,"source":"config"/);
});
```

The exact JSON shape above is the contract; if you choose a different one, update these assertions and say why in your report.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/tuning-tools.test.ts`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement**, following `src/limits-tools.ts` for the registration shape and `text`/`errText` from `./tool-helpers.js`.

- [ ] **Step 4: Run tests**

Run: `cd tb3-mcp && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/tuning-tools.ts tb3-mcp/src/server.ts tb3-mcp/test/tuning-tools.test.ts
git commit -m "feat(tuning): get_tuning/set_tuning reporting effective value and source"
```

---

### Task 5: Tuning entry in the Setup drawer

**Files:**
- Create: `tb3-mcp/dashboard/public/tuning-panel.js`
- Modify: `tb3-mcp/dashboard/public/app.js` (register the entry, next to `setEntryRenderer("joystick", …)` at ~line 181)
- Modify: `tb3-mcp/scripts/dashboard-smoke.mjs`

**Vanilla ES modules, no build step, no new dependencies.** Follow `joystick-panel.js` and the sector entry for structure.

Each field renders: label, current effective value, its source (tuned/config), its valid range, an input, and a **Reset to default** control. Editing posts through the existing `/api/control/*` proxy.

- [ ] **Step 1: Add a smoke assertion**

Extend `tb3-mcp/scripts/dashboard-smoke.mjs` in its existing style: open the Setup drawer's Tuning entry and assert it renders all four field names, at least one `config` source label, and a range hint. Run the script **twice** and confirm identical output — it has been flaky before when an assertion depended on varying data.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tb3-mcp && node scripts/dashboard-smoke.mjs`
Expected: FAIL — no Tuning entry.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the smoke script twice and the full suite**

Run: `cd tb3-mcp && node scripts/dashboard-smoke.mjs && node scripts/dashboard-smoke.mjs && npx vitest run`
Expected: PASS, identical smoke output both runs.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/dashboard/public/tuning-panel.js tb3-mcp/dashboard/public/app.js tb3-mcp/scripts/dashboard-smoke.mjs
git commit -m "feat(dashboard): Tuning entry showing effective values and their source"
```

---

### Task 6: Capture defaults

**Files:**
- Modify: `tb3-mcp/src/config.ts` (`captureTimeoutMs` default 4000 → 10000)
- Modify: `tb3-mcp/src/dashboard/camera/rtsp.ts:67` (`gopSize`)
- Test: `tb3-mcp/test/config.test.ts` (append), plus whichever test file covers `rtsp.ts`

**Measured justification:** snapshot duration is 1755–2217 ms against a 4000 ms timeout, dominated by the wait for the next keyframe at `-g 60` (one every 2 s at 30 fps). Under 2× margin, hence intermittent failures that always succeed when run by hand.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tb3-mcp/test/config.test.ts
it("captureTimeoutMs defaults to 10s — measured snapshots take up to ~2.2s and the old 4s left no margin", () => {
  const cfg = loadConfigFrom({});          // use this file's existing loader helper
  expect(cfg.captureTimeoutMs).toBe(10000);
});
```

Read `test/config.test.ts` first and use whatever loader helper it already has rather than inventing one. Add an equivalent assertion for the GOP against `gopSize`'s covering test file.

- [ ] **Step 2: Run to verify they fail**

Run: `cd tb3-mcp && npx vitest run test/config.test.ts`
Expected: FAIL — still 4000.

- [ ] **Step 3: Implement**, and read `gopSize` in `src/dashboard/camera/rtsp.ts` before changing it — it may already be derived from a config value rather than a literal, in which case change the source of that value, not the call site.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd tb3-mcp && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/config.ts tb3-mcp/src/dashboard/camera/rtsp.ts tb3-mcp/test/
git commit -m "fix(capture): 10s snapshot timeout and a 1s GOP — 4s left under 2x margin"
```

---

## Manual verification on the rig

1. **Task 1 alone is worth deploying immediately.** Solve a calibration, note pointing, run `set_north_zero`, confirm aircraft stay in frame — that is the field failure reproduced and fixed.
2. `set_tuning maxAimOffsetDeg 30`, then nudge more than 5° **without restarting the daemon**. That is the live-resolution requirement proven on real hardware.
3. Capture snapshots repeatedly for a few minutes and confirm no `Command failed` entries in `journalctl -u tb3-mcp`.
4. Open Setup → Tuning, change a value, confirm its source flips to `tuned`, then Reset and confirm it returns to `config`.
