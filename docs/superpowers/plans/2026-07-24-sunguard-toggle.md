# Sun-Guard Dashboard Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click dashboard toggle that enables/disables the sun-avoidance guard, reflecting live state from SSE, and (because disabling releases a standing sun-lock) doubling as the lock-escape control.

**Architecture:** Thread the guard's master-enable through the existing dashboard control path — no new endpoints, no daemon-core change. Read: `get_sun` already emits `guard_enabled`; carry it into `DashboardState.sunGuard.enabled`. Write: a new `sun-guard/set` control action → `ControlDeps.setSunGuard` → the daemon's `set_sun_guard` tool. A state-driven `.toggle-btn` (like the Camera/Auto toggles) posts the intent and flips on the next SSE poll.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers) for the dashboard backend (`src/dashboard/*`); Zod (non-strict parsing) at the MCP-client boundary; vitest (fileParallelism:false); vanilla JS/CSS with no build step for the frontend (`dashboard/public/*`).

## Global Constraints

- Branch: `feat/sunguard-toggle` off `main` @ `a0601b5`. Independent of IMU-cal PR #7.
- Build/test from `tb3-mcp/`: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/<file>.ts` (single) / `npm test` (full, must stay green — currently **369 tests**) / `npm run build` (tsc via `tsconfig.build.json`, must stay clean).
- No `any`. TS imports use `.js` specifiers. Zod schemas stay non-strict (no `.strict()`) — `get_sun` emits extra fields the dashboard doesn't consume.
- Frontend `dashboard/public/` is deliberately vanilla JS/CSS, served static, **NO build step**. `app.js` is already an ES module.
- The toggle commands **no rig motion**: it must NOT be added to `motionControls` and must NOT be gated by `estopLatched`/`sunLocked` (it is the sun-lock escape hatch).
- No confirmation prompt on OFF (matches the Camera/Auto toggles and the CLI).
- The frontend button render/click is **on-host manual** verification (dashboard convention — no automated E2E). The backend read/write path is unit-tested.

---

### Task 1: Backend read + write path (state carry + control action)

Thread `enabled` through the dashboard backend: the client parses/emits it, `mergeState` carries it into `DashboardState.sunGuard`, and a `sun-guard/set` action routes to a new `setSunGuard` dep bound to the daemon's `set_sun_guard` tool. TDD the two pure surfaces (`mergeState`, `runAction`); the client method and server binding are covered by `tsc` + the fact that `ControlDeps` now requires `setSunGuard`.

**Files:**
- Modify: `tb3-mcp/src/dashboard/state.ts` (SunRaw + DashboardState.sunGuard + mergeState)
- Modify: `tb3-mcp/src/dashboard/client.ts` (SunRawZ + getSun mapping + setSunGuard method)
- Modify: `tb3-mcp/src/dashboard/controls.ts` (ControlDeps + runAction case)
- Modify: `tb3-mcp/src/dashboard/server.ts` (buildControlDeps binding)
- Test: `tb3-mcp/test/dashboard-state.test.ts` (mergeState carry)
- Test: `tb3-mcp/test/dashboard-controls.test.ts` (runAction routing)

**Interfaces:**
- Consumes: existing `SunRaw`/`SunRawZ`/`getSun()` (currently `{ state, locked, separationDeg }`), `DashboardState.sunGuard`, `ControlDeps`, `runAction(d, action, body)`, `buildControlDeps(s)`, `McpDashboardClient.call(name, args)`.
- Produces (Task 2 relies on these):
  - `DashboardState.sunGuard` shape becomes `{ state: string; locked: boolean; separationDeg: number | null; enabled: boolean }`.
  - Control action `POST /api/control/sun-guard/set` with body `{ enabled: boolean }` → `{ ok: true, message: string }`.

---

- [ ] **Step 1: Write the failing mergeState-carry test**

Add this `describe` block to the end of `tb3-mcp/test/dashboard-state.test.ts` (the file already has `inputs()`, `ok`, `err`, `SVC` helpers at the top):

```typescript
describe("mergeState carries the sun-guard enabled flag", () => {
  it("passes enabled:true through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }) }), 1000);
    expect(s.sunGuard.enabled).toBe(true);
  });
  it("passes enabled:false through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "disabled", locked: false, separationDeg: null, enabled: false }) }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
  it("defaults enabled to false when the sun source is degraded", () => {
    const s = mergeState(inputs({ sun: err("get_sun failed") }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-state.test.ts`
Expected: the three new tests FAIL — `s.sunGuard.enabled` is `undefined` (`expected undefined to be true` / `... to be false`). vitest's esbuild transform strips types without type-checking, so the extra `enabled` field on the test's `sun` literal doesn't block the run — the assertions are what fail. The existing tests in the file still pass.

- [ ] **Step 3: Add `enabled` to the SunRaw + DashboardState types and mergeState**

In `tb3-mcp/src/dashboard/state.ts`:

Change the `SunRaw` interface (currently `export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; }`) to:

```typescript
export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; enabled: boolean; }
```

Change the `sunGuard` field in the `DashboardState` interface (currently `sunGuard: { state: string; locked: boolean; separationDeg: number | null; };`) to:

```typescript
  sunGuard: { state: string; locked: boolean; separationDeg: number | null; enabled: boolean; };
```

Change the `sunGuard` object literal in the `mergeState` return (currently `sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null },`) to:

```typescript
    sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null, enabled: sun?.enabled ?? false },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-state.test.ts`
Expected: all tests PASS (including the three new ones and the pre-existing ones).

- [ ] **Step 5: Keep the client + test helper type-consistent with the new required field**

`SunRaw.enabled` is now required, so the client's `getSun()` must supply it and the state-test helper's default `sun` literal must include it (otherwise `npm run build` fails).

In `tb3-mcp/src/dashboard/client.ts`, add `guard_enabled` to the `SunRawZ` schema (currently `const SunRawZ = z.object({ guard_state: z.string(), locked: z.boolean(), boresight_separation_deg: z.number().nullable(), });`):

```typescript
const SunRawZ = z.object({
  guard_state: z.string(),
  locked: z.boolean(),
  boresight_separation_deg: z.number().nullable(),
  guard_enabled: z.boolean(),
});
```

And map it in `getSun()` (currently `return { state: b.guard_state, locked: b.locked, separationDeg: b.boresight_separation_deg };`):

```typescript
    return { state: b.guard_state, locked: b.locked, separationDeg: b.boresight_separation_deg, enabled: b.guard_enabled };
```

In `tb3-mcp/test/dashboard-state.test.ts`, update the `inputs()` helper's default `sun` line (currently `sun: ok({ state: "monitoring", locked: false, separationDeg: 80 }),`) to include the field:

```typescript
    sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }),
```

- [ ] **Step 6: Write the failing runAction test**

First, the `deps()` stub in `tb3-mcp/test/dashboard-controls.test.ts` must gain the new dep (else it won't satisfy `ControlDeps` once Step 8 adds it). Add `setSunGuard: rec("setSunGuard"),` to the `d` object in `deps()` — put it right after the `setTrackSector: rec("setTrackSector"),` line:

```typescript
    getTrackSector: async () => { calls.push("getTrackSector:[]"); return { enabled: false, startDeg: 0, endDeg: 360 }; },
    setTrackSector: rec("setTrackSector"),
    setSunGuard: rec("setSunGuard"),
```

Then add this test inside the existing `describe("runAction", ...)` block:

```typescript
  it("routes sun-guard/set with a boolean enabled", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "sun-guard/set", { enabled: true })).ok).toBe(true);
    await runAction(d, "sun-guard/set", { enabled: false });
    await runAction(d, "sun-guard/set", {}); // missing → false
    expect(calls).toContain("setSunGuard:[true]");
    expect(calls).toContain("setSunGuard:[false]");
    expect(calls.filter((c) => c === "setSunGuard:[false]").length).toBe(2);
  });
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-controls.test.ts`
Expected: the new "routes sun-guard/set" test FAILS — `runAction(d, "sun-guard/set", …)` hits the `default` branch and returns `{ ok: false, message: "unknown action: sun-guard/set" }`, so the first `.ok` assertion fails and no `setSunGuard:*` calls are recorded. Existing tests still pass.

- [ ] **Step 8: Add `setSunGuard` to ControlDeps and the runAction case**

In `tb3-mcp/src/dashboard/controls.ts`, add to the `ControlDeps` interface (put it right after the `setTrackSector(...)` line):

```typescript
  setSunGuard(enabled: boolean): Promise<void>;
```

And add this case to the `switch (action)` in `runAction`, right before the `default:` line:

```typescript
      case "sun-guard/set":
        await d.setSunGuard(body.enabled === true);
        return { ok: true, message: `sun guard ${body.enabled === true ? "enabled" : "disabled"}` };
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-controls.test.ts`
Expected: all tests PASS, including "routes sun-guard/set with a boolean enabled".

- [ ] **Step 10: Add the client method and bind it in the server**

In `tb3-mcp/src/dashboard/client.ts`, add this method right after `setTrackSector(...)` (near the end of the `McpDashboardClient` class):

```typescript
  async setSunGuard(enabled: boolean): Promise<void> {
    await this.call("set_sun_guard", { enabled });
  }
```

In `tb3-mcp/src/dashboard/server.ts`, add the binding to the object returned by `buildControlDeps` — right after the `setTrackSector: s.client.setTrackSector.bind(s.client),` line (plain bind, no timeout wrapper: it commands no motion, matching how `track`/`jog` are bound):

```typescript
    setSunGuard: s.client.setSunGuard.bind(s.client),
```

- [ ] **Step 11: Verify the whole suite + build are green**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npm run build && npm test`
Expected: `tsc` exits clean (no type errors — confirms the required `enabled`/`setSunGuard` ripples are all satisfied), and vitest reports **373 passed** (369 existing + 3 new `it`s in dashboard-state.test.ts + 1 new `it` in dashboard-controls.test.ts). The invariant is zero failures; if the base count has drifted, confirm it rose by exactly 4.

- [ ] **Step 12: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32
git add tb3-mcp/src/dashboard/state.ts tb3-mcp/src/dashboard/client.ts tb3-mcp/src/dashboard/controls.ts tb3-mcp/src/dashboard/server.ts tb3-mcp/test/dashboard-state.test.ts tb3-mcp/test/dashboard-controls.test.ts
git commit -m "feat(sunguard): dashboard read+write path for the sun-guard enable toggle"
```

---

### Task 2: Frontend toggle button (markup + render + click)

Add the `.toggle-btn` to the controls row, drive its label/state from each SSE tick via the existing `renderSunGuard`, and post the flip on click. On-host manual verification (no automated E2E per dashboard convention).

**Files:**
- Modify: `tb3-mcp/dashboard/public/index.html` (the button element)
- Modify: `tb3-mcp/dashboard/public/app.js` (el registration, state mirror, renderSunGuard, click handler)
- Modify (only if spacing needs it): `tb3-mcp/dashboard/public/style.css`

**Interfaces:**
- Consumes (from Task 1): `state.sunGuard.enabled: boolean`, `state.sunGuard.state: string`; the `POST /api/control/sun-guard/set { enabled }` action.
- Produces: no downstream consumers (final task).

---

- [ ] **Step 1: Add the button to the controls row**

In `tb3-mcp/dashboard/public/index.html`, in the controls row that holds the Camera and Auto toggles (the `<button id="camera-toggle" ...>` and `<button id="auto-toggle" ...>` around line 63–65), add a third toggle button. Place it right after the `auto-toggle` button:

```html
        <button id="sunguard-toggle" type="button" class="toggle-btn">Sun guard: &mdash;</button>
```

- [ ] **Step 2: Register the element and add the state mirror in app.js**

In `tb3-mcp/dashboard/public/app.js`, add the element to the `el` object map, right after the `cameraToggle: document.getElementById("camera-toggle"),` line:

```javascript
  sunguardToggle: document.getElementById("sunguard-toggle"),
```

And add a module-scope mirror variable right after `let cameraEnabledFromState = false;`:

```javascript
let sunGuardEnabledFromState = false;
```

- [ ] **Step 3: Extend renderSunGuard to drive the button**

In `tb3-mcp/dashboard/public/app.js`, the current `renderSunGuard` is:

```javascript
function renderSunGuard(sunGuard) {
  const s = sunGuard ?? { state: "unknown", locked: false, separationDeg: null };
  sunLocked = !!s.locked;
  sunReason = s.separationDeg === null || s.separationDeg === undefined
    ? s.state
    : `${s.state}, separation ${fmt(s.separationDeg, 1)}°`;
}
```

Replace it with (adds the button drive; leaves the existing lock/reason logic intact):

```javascript
function renderSunGuard(sunGuard) {
  const s = sunGuard ?? { state: "unknown", locked: false, separationDeg: null };
  sunLocked = !!s.locked;
  sunReason = s.separationDeg === null || s.separationDeg === undefined
    ? s.state
    : `${s.state}, separation ${fmt(s.separationDeg, 1)}°`;

  // Degraded/not-yet-polled sun source → show "—", don't assert on/off (mirrors
  // the initial "Auto: —"), so a failed poll never misreports the guard as OFF.
  if (s.state === "unknown") {
    el.sunguardToggle.textContent = "Sun guard: —";
    el.sunguardToggle.classList.remove("toggle-on");
    return;
  }
  const enabled = !!s.enabled;
  sunGuardEnabledFromState = enabled;
  el.sunguardToggle.textContent = "Sun guard: " + (enabled ? "ON" : "OFF");
  el.sunguardToggle.classList.toggle("toggle-on", enabled);
}
```

- [ ] **Step 4: Wire the click handler**

In `tb3-mcp/dashboard/public/app.js`, add a click handler next to the camera-toggle handler (the `el.cameraToggle.addEventListener("click", …)` block). The button posts the negation of the last-known state; the next SSE tick flips the label via `renderSunGuard`:

```javascript
// Sun-guard toggle is state-driven like Camera: POST the intent, let the next
// SSE tick flip the button via renderSunGuard(). It commands no rig motion, so
// it is deliberately NOT in motionControls and NOT gated by E-STOP / sun-lock —
// disabling the guard is the way to escape a standing sun-lock.
el.sunguardToggle.addEventListener("click", () => {
  postControl("sun-guard/set", { enabled: !sunGuardEnabledFromState });
});
```

- [ ] **Step 5: Syntax-check the frontend + confirm no gating regressions**

Run: `cd /Volumes/ExtData2/coding/TB3-ESP32 && node --check tb3-mcp/dashboard/public/app.js && echo OK`
Expected: `OK` (no syntax error).

Then confirm the button is NOT gated: grep shows it is absent from `motionControls` and `applyMotionGate`:

Run: `cd tb3-mcp && grep -n "sunguardToggle" dashboard/public/app.js`
Expected: exactly three hits — the `el` registration, the `renderSunGuard` drive, and the click handler. It must NOT appear in the `motionControls` array (around line 96) or in `applyMotionGate` (around line 202). If it does, remove it from those — the toggle stays clickable under sun-lock and E-STOP.

- [ ] **Step 6: On-host manual verification (document, do not block on rig)**

The canvas/DOM behavior has no automated E2E (dashboard convention). Record in the task report that the following is the on-host acceptance check (to be run when the rig/dashboard is up — the rig is currently down for heat, so this is documented, not executed here):
- The toggle shows the live guard state (`ON`/`OFF`, or `—` before the first poll / when the daemon sun read is degraded).
- Clicking flips it; the daemon reflects the change and the next ~1s poll updates the label.
- With the guard locked (sun in cone, banner showing), clicking to disable clears the banner and re-enables motion within ~1s; re-enabling re-trips if the sun is still in the cone.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32
git add tb3-mcp/dashboard/public/index.html tb3-mcp/dashboard/public/app.js
git commit -m "feat(sunguard): dashboard toggle button — state-driven, ungated lock-escape"
```

---

## Notes for the executor

- The `style.css` change is contingent — only touch it if the third `.toggle-btn` visibly crowds the controls row on-host. The existing `.toggle-btn`/`.toggle-on` rules already style the button; do not add speculative CSS.
- Do not wrap `setSunGuard` in a `withTimeout` in `buildControlDeps`: it commands no rig motion (just flips supervisor config), and the un-wrapped `track`/`jog`/`setTrackSector` binds are the precedent. Wrapping it would be inconsistent, not safer.
- The 3-in-1 runAction test (`enabled:true`/`false`/missing) intentionally covers the `body.enabled === true` coercion: a missing `enabled` is `undefined`, which `=== true` is `false`, so the guard is disabled — the safe default for a malformed request.
