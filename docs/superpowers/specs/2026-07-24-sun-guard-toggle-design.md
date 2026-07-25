# Sun-Guard Dashboard Toggle — Design

**Status:** design, approved 2026-07-24. Follow-on to the ADS-B mini-map + 3D
rig view (all on `main`). Independent of the IMU-calibration PR #7.

## Problem / goal

The sun-avoidance guard (which stops the rig pointing at/near the sun and parks
it) can today only be flipped from the CLI (`sunguard.mjs on|off|status`) or the
raw `set_sun_guard` MCP tool. The dashboard shows a lock *banner* but offers no
control. Expose the guard as a one-click dashboard toggle that reflects live
state — so the operator can enable/disable it, and escape a standing sun-lock,
without leaving the dashboard.

## Scope

- **In scope:** a single on/off toggle button in the dashboard, state-driven
  from the SSE `DashboardState` (mirrors the existing Camera/Auto toggles), that
  posts the guard's master-enable through the existing dashboard control path to
  the daemon's `set_sun_guard` tool.
- **Out of scope (YAGNI):** exposing `cone_deg` / `park_tilt_deg` (config
  tuning, set once via CLI/config); a separate "clear lock" button (disabling the
  guard already releases a standing lock — see Behavior); any daemon-core change.

## Key behavioral facts (verified in `src/track/supervisor.ts`)

- `get_sun` already returns `guard_enabled` (plus `guard_state`, `locked`,
  `boresight_separation_deg`); the dashboard client currently parses the latter
  three and drops `guard_enabled`.
- `set_sun_guard { enabled }` calls `supervisor.setConfig({ enabled })`.
- On the next supervisor tick, `!enabled` runs `disable("manually_disabled")`,
  which sets `state="disabled"`, `setLocked(false)`, and aborts any park —
  i.e. **disabling the guard releases a standing sun-lock** (~100ms later; the
  banner clears on the next ~1s dashboard poll).
- Re-enabling re-trips on the next tick if the sun is still in the cone (correct,
  safe). The terminal `fault` state is recovered by OFF→ON (disable clears the
  lock+fault; re-enable returns to `monitoring`).

## Architecture / data flow

No new endpoints and no daemon-core change — identical shape to the existing
`track` / `camera/*` / `sector/set` controls.

**Read (state → button):**
`get_sun` → client `getSun()` (now also mapping `guard_enabled` → `enabled`) →
`mergeState` carries `sunGuard.enabled` → SSE `DashboardState` → `renderSunGuard`
sets the button label + `toggle-on` class each tick.

**Write (button → daemon):**
click → `POST /api/control/sun-guard/set { enabled }` → `runAction` `case
"sun-guard/set"` → `ControlDeps.setSunGuard(enabled)` → `client.setSunGuard()` →
daemon `set_sun_guard { enabled }`. The next poll flips the button (state-driven,
like Camera).

## Components (all in `tb3-mcp`)

### Backend

- **`src/dashboard/client.ts`**
  - Add `guard_enabled: z.boolean()` to `SunRawZ`.
  - `getSun()` maps it into the returned `SunRaw` as `enabled: b.guard_enabled`.
  - Add `async setSunGuard(enabled: boolean): Promise<void>` →
    `this.call("set_sun_guard", { enabled })`.
- **`src/dashboard/state.ts`**
  - `SunRaw` gains `enabled: boolean`.
  - `DashboardState.sunGuard` gains `enabled: boolean`.
  - `mergeState` sets `enabled: sun?.enabled ?? false`.
- **`src/dashboard/controls.ts`**
  - `ControlDeps` gains `setSunGuard(enabled: boolean): Promise<void>`.
  - `runAction` gains `case "sun-guard/set": await d.setSunGuard(body.enabled ===
    true); return { ok: true, message: ... }`.
- **`src/dashboard/server.ts`**
  - `buildControlDeps` binds `setSunGuard: s.client.setSunGuard.bind(s.client)`.

### Frontend (`dashboard/public/`, vanilla JS/CSS, no build step)

- **`index.html`** — a `<button id="sunguard-toggle" type="button"
  class="toggle-btn">Sun guard: &mdash;</button>` in the controls row next to the
  Camera and Auto toggles.
- **`app.js`**
  - Register the element; add a module-scope `sunGuardEnabledFromState` mirror
    (like `cameraEnabledFromState`).
  - Extend `renderSunGuard(sunGuard)` to also drive the button: when
    `state === "unknown"` show `Sun guard: —` and clear `toggle-on`; otherwise
    label `Sun guard: ON|OFF` from `enabled` and toggle `toggle-on`.
  - Click handler: `postControl("sun-guard/set", { enabled: !sunGuardEnabledFromState })`.
  - The button is **not** added to `motionControls` and is not gated by
    `estopLatched`/`sunLocked` — it commands no motion and is the lock escape.
- **`style.css`** — reuses the existing `.toggle-btn` / `.toggle-on` styles;
  expected no change (add only if the controls row needs spacing).

## Button behavior / gating (summary)

- Label `Sun guard: ON` / `OFF`; `toggle-on` when enabled — mirrors Camera.
- Degraded/unknown (`sunGuard.state === "unknown"`, e.g. sun source failed or
  not-yet-polled) → `Sun guard: —`, no on/off assertion (matches the initial
  `Auto: —`), so a failed poll never misreports the guard as OFF.
- Always clickable (no motion, so no E-STOP / sun-lock gate). One-click OFF, no
  confirmation (matches the Camera/Auto toggles and the CLI).

## Error handling

- `postControl` already toasts non-2xx and thrown errors; `set_sun_guard`
  returns the guard status, surfaced via `runAction`'s standard `{ ok, message }`.
- A failed `get_sun` read degrades `sunGuard.state` to `"unknown"` (existing
  `mergeState` behavior), so the button falls back to `—` rather than throwing.

## Testing

**Unit (vitest) — the two pure surfaces with existing test homes:**
- `test/dashboard-state.test.ts`: `mergeState` carries `sunGuard.enabled` from
  `SunRaw` for both `true` and `false`, and defaults to `false` when the sun
  source is absent/degraded.
- `test/dashboard-controls.test.ts`: `runAction("sun-guard/set", { enabled })`
  invokes the `setSunGuard` dep with the correct boolean and returns
  `{ ok: true }`; `{ enabled: false }` and a missing `enabled` both coerce to
  `false` (via the `body.enabled === true` read).

**Not unit-tested (consistent with the codebase):** the `McpDashboardClient`
layer has no unit tests today — `getSun()`'s existing `guard_state`/`locked`/
`separationDeg` mapping is itself only manual-verified, so the one-line
`guard_enabled` → `enabled` addition to `SunRawZ`/`getSun()` is likewise covered
by on-host manual verification rather than a new bespoke client test harness.

**On-host manual (dashboard convention):** the toggle shows the live guard state;
clicking flips it and the daemon reflects the change on the next poll; disabling
while sun-locked clears the banner and re-enables motion.

## Files

- Modify: `src/dashboard/client.ts`, `src/dashboard/state.ts`,
  `src/dashboard/controls.ts`, `src/dashboard/server.ts`,
  `dashboard/public/index.html`, `dashboard/public/app.js`
  (`dashboard/public/style.css` only if spacing needs it).
- Test: extend `test/dashboard-state.test.ts` (mergeState carry) and
  `test/dashboard-controls.test.ts` (runAction sun-guard/set) with the two unit
  tests above.
