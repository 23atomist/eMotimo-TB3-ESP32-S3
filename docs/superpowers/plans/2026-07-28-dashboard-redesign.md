# TB3 Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise the ops dashboard into an always-visible monitoring cockpit plus a Setup drawer that guides multi-step procedures, and give UI to the daemon tools that currently have none.

**Architecture:** The 32 MCP tools split into *continuous* things you watch (video, radar, telemetry, E-STOP) and *procedural* things you do (calibrate, teach limits, set home). The cockpit keeps the former permanently visible; the drawer guides the latter, collapsing to a slim strip for steps that need the operator to see the video. All step ordering and prerequisites come from a pure, unit-tested function — that is where the real logic lives.

**Tech Stack:** Vanilla ES modules in `dashboard/public/` (no build step, no dependencies), TypeScript for the dashboard server, vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-dashboard-redesign-design.md`

## Global Constraints

- **No new npm dependencies. `dashboard/public/` stays vanilla ES modules served static, with NO build step.**
- **No change to daemon behaviour, tools, or gating.** This is a re-layout. Dashboard-side client/route plumbing for tools that already exist on the daemon is in scope; changing what those tools do is not.
- **All motion controls keep their existing server-side gating** — E-STOP latch, sun lock, travel limits, the 5° trim clamp. Verify, don't assume.
- **E-STOP is fixed furniture:** top-right of the header, never scrolled, never covered by the drawer or strip, never repositioned between states.
- **The video is never hidden** — not by the drawer, not by any procedure. This constraint is why the design is a drawer and not modes.
- **Desktop-first.** The operator confirmed they work from a monitor; do not compromise density for small screens.
- Tests: `npm test` from `tb3-mcp/`. Typecheck: **both** `npm run build` **and** `npx tsc -p tsconfig.json --noEmit` (the first misses the test tree). The second must report `TS7016` errors ONLY — one per test file importing a plain-JS browser module. Any other error shape is a regression.
- ESM/NodeNext in `src/` — relative imports carry `.js` extensions.
- Existing pure modules are NOT modified: `camera-panel.js`, `camera-mode.js`, `whep.js`, `video-stats.js`, `capture-label.js`, `jog-ramp.js`, `jog-hold.js`, `nudge-hold.js`, `joystick-math.js`, `joystick-hold.js`, `rigmath.js`, `minimap.js`, `aircraft-select.js`. Their tests are the regression guard for this re-layout.

## Branch

**Build this on its own branch off `feat/mediamtx-webrtc`:**

```bash
git switch -c feat/dashboard-redesign feat/mediamtx-webrtc
```

The operator is field-testing the current dashboard. A large visual change needs a one-command fallback (`git switch feat/mediamtx-webrtc`), not commit archaeology at 2am.

## File Structure

```
dashboard/public/
  app.js              SLIMMED to bootstrap + wiring only (currently 1463 lines)
  cockpit.js          NEW  always-visible panels: render + control wiring
  drawer.js           NEW  Setup drawer shell, entries, strip collapse/expand
  procedures.js       NEW  the guided procedures (calibration, limits, home)
  step-gate.js        NEW  PURE: daemon state -> per-step {done,available,blocked,reason}
  ui-mode.js          NEW  PURE: daemon state -> which controls active, AIM label
  style.css           SPLIT into cockpit.css + drawer.css (currently 1016 lines)
  (all existing pure modules unchanged)

src/dashboard/
  client.ts           ADD  characterizeImu, setNorthZero, teachLimit,
                           clearTaughtLimits, setHome, capture controls
  controls.ts         ADD  matching ControlDeps entries
  server.ts           ADD  matching /api/control/* routes
```

---

### Task 1: `step-gate.js` — the pure calibration step model

The real logic of this redesign. Everything else is presentation.

**Files:**
- Create: `dashboard/public/step-gate.js`
- Test: `test/step-gate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function calibrationSteps(state)` returning an array of
  `{ id, label, done, available, blocked, reason, detail }` in order.
  `state` is the dashboard's SSE payload shape.

- [ ] **Step 1: Write the failing test**

Create `test/step-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { calibrationSteps } from "../dashboard/public/step-gate.js";

const base = {
  calibration: { calibrated: false, provisional: false, rig: null, sightings: [], imuMounting: null },
  adsb: { aircraft: [] },
};
const byId = (s, id) => s.find((x) => x.id === id);

describe("calibrationSteps", () => {
  it("blocks everything after rig location when it is unset", () => {
    const s = calibrationSteps(base);
    expect(byId(s, "rig-location").available).toBe(true);
    expect(byId(s, "imu").blocked).toBe(true);
    expect(byId(s, "imu").reason).toMatch(/rig location/i);
  });

  it("unblocks the IMU sweep once the rig location is set", () => {
    const s = calibrationSteps({ ...base, calibration: { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } } });
    expect(byId(s, "rig-location").done).toBe(true);
    expect(byId(s, "imu").available).toBe(true);
    expect(byId(s, "imu").blocked).toBe(false);
  });

  it("north-zero requires the IMU sweep -- and says so", () => {
    const s = calibrationSteps({ ...base, calibration: { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } } });
    expect(byId(s, "north-zero").blocked).toBe(true);
    expect(byId(s, "north-zero").reason).toMatch(/imu/i);
  });

  it("sighting 1 needs a provisional orientation", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 } };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "sight-1").blocked).toBe(true);
    const withProv = { ...cal, provisional: true };
    expect(byId(calibrationSteps({ ...base, calibration: withProv }), "sight-1").available).toBe(true);
  });

  it("sighting 2 is blocked until sighting 1 exists", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "sight-2").blocked).toBe(true);
    const one = { ...cal, sightings: [{ label: "QXE2320", panDeg: 10, tiltDeg: 35 }] };
    expect(byId(calibrationSteps({ ...base, calibration: one }), "sight-2").available).toBe(true);
  });

  it("solve is blocked until two sightings exist, and the reason says how many are missing", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true,
                  sightings: [{ label: "A", panDeg: 10, tiltDeg: 35 }] };
    const s = byId(calibrationSteps({ ...base, calibration: cal }), "solve");
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/2 sightings|second sighting/i);
  });

  it("solve becomes available with two sightings", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true,
                  sightings: [{ label: "A", panDeg: 10, tiltDeg: 35 }, { label: "B", panDeg: 200, tiltDeg: 8 }] };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "solve").available).toBe(true);
  });

  it("every step is done once calibrated", () => {
    const cal = { calibrated: true, provisional: false, rig: { lat: 1, lon: 2, height: 3 },
                  imuMounting: { rmsDeg: 1.4 }, sightings: [{}, {}] };
    expect(calibrationSteps({ ...base, calibration: cal }).every((x) => x.done)).toBe(true);
  });

  it("a blocked step always carries a human reason -- never blocked with an empty reason", () => {
    for (const st of calibrationSteps(base)) {
      if (st.blocked) expect(String(st.reason).length).toBeGreaterThan(0);
    }
  });

  it("tolerates a missing/degraded calibration payload without throwing", () => {
    expect(() => calibrationSteps({})).not.toThrow();
    expect(() => calibrationSteps({ calibration: null })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/step-gate.test.ts`
Expected: FAIL — cannot resolve `step-gate.js`.

- [ ] **Step 3: Implement `dashboard/public/step-gate.js`**

```js
// PURE: derives the calibration procedure's state from the daemon's own payload.
//
// This is the logic the old UI never had. Calibration is an ORDERED procedure
// with prerequisites -- set_north_zero needs characterize_imu, solving needs two
// sightings -- and presenting it as a flat row of buttons meant the operator had
// to hold that order in their head. A blocked step therefore always carries a
// human-readable reason: WHY a step is unavailable is the single most useful
// thing this UI can say.
//
// Everything here is derived from daemon state, never from local flags, so a
// refresh mid-procedure recovers instead of losing the operator's place.

function step(id, label, done, blockedReason, detail) {
  const blocked = !done && !!blockedReason;
  return {
    id, label, done,
    blocked,
    available: !done && !blocked,
    reason: blocked ? blockedReason : "",
    detail: detail || "",
  };
}

export function calibrationSteps(state) {
  const cal = (state && state.calibration) || {};
  const calibrated = cal.calibrated === true;
  const rig = cal.rig || null;
  const imu = cal.imuMounting || null;
  const provisional = cal.provisional === true;
  const sightings = Array.isArray(cal.sightings) ? cal.sightings : [];

  // Once solved, every step reads as done -- the procedure is complete and the
  // operator should see that at a glance rather than parsing six rows.
  if (calibrated) {
    return [
      step("rig-location", "Rig location", true, "", rig ? `${rig.lat.toFixed(4)}, ${rig.lon.toFixed(4)}, ${rig.height}m` : ""),
      step("imu", "IMU characterised", true, "", imu && imu.rmsDeg != null ? `rms ${imu.rmsDeg.toFixed(1)}°` : ""),
      step("north-zero", "North zero", true, ""),
      step("sight-1", "Sighting 1", true, "", sightings[0] ? String(sightings[0].label || "") : ""),
      step("sight-2", "Sighting 2", true, "", sightings[1] ? String(sightings[1].label || "") : ""),
      step("solve", "Solve", true, ""),
    ];
  }

  const hasRig = !!rig;
  const hasImu = !!imu;

  return [
    step("rig-location", "Rig location", hasRig, "",
      hasRig ? `${rig.lat.toFixed(4)}, ${rig.lon.toFixed(4)}, ${rig.height}m` : ""),
    step("imu", "IMU characterised", hasImu,
      hasRig ? "" : "needs the rig location first",
      hasImu && imu.rmsDeg != null ? `rms ${imu.rmsDeg.toFixed(1)}°` : ""),
    step("north-zero", "North zero", provisional,
      hasImu ? "" : "needs the IMU characterised first"),
    step("sight-1", "Sighting 1", sightings.length >= 1,
      provisional ? "" : "needs a north zero before tracking is possible",
      sightings[0] ? String(sightings[0].label || "") : ""),
    step("sight-2", "Sighting 2", sightings.length >= 2,
      sightings.length >= 1 ? "" : "needs sighting 1 first",
      sightings[1] ? String(sightings[1].label || "") : ""),
    step("solve", "Solve", false,
      sightings.length >= 2 ? "" : `needs 2 sightings (have ${sightings.length})`),
  ];
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/step-gate.js test/step-gate.test.ts
git commit -m "feat(dashboard): pure calibration step-gating model"
```

---

### Task 2: `ui-mode.js` — pure mode derivation

**Files:**
- Create: `dashboard/public/ui-mode.js`
- Test: `test/ui-mode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function aimMode(state)` → `"jog" | "trim" | "locked"`;
  `function calibrationBadge(state)` → `{ text, cls }`.

- [ ] **Step 1: Write the failing test**

Create `test/ui-mode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aimMode, calibrationBadge } from "../dashboard/public/ui-mode.js";

describe("aimMode", () => {
  it("is jog when idle", () => {
    expect(aimMode({ tracking: { state: "stopped" } })).toBe("jog");
  });
  it("is trim while tracking -- the buttons change meaning", () => {
    expect(aimMode({ tracking: { state: "tracking" } })).toBe("trim");
  });
  it("is trim while acquiring too (the tracker owns the rig)", () => {
    expect(aimMode({ tracking: { state: "acquiring" } })).toBe("trim");
  });
  it("is locked under E-STOP, whatever the tracking state", () => {
    expect(aimMode({ tracking: { state: "tracking" }, estopLatched: true })).toBe("locked");
    expect(aimMode({ tracking: { state: "stopped" }, estopLatched: true })).toBe("locked");
  });
  it("is locked under sun lock", () => {
    expect(aimMode({ tracking: { state: "stopped" }, sunLocked: true })).toBe("locked");
  });
  it("tolerates a missing payload", () => {
    expect(() => aimMode({})).not.toThrow();
    expect(aimMode({})).toBe("jog");
  });
});

describe("calibrationBadge", () => {
  it("distinguishes calibrated, provisional and uncalibrated", () => {
    expect(calibrationBadge({ calibration: { calibrated: true } }).text).toMatch(/CALIBRATED/);
    expect(calibrationBadge({ calibration: { provisional: true } }).text).toMatch(/PROVISIONAL/);
    expect(calibrationBadge({ calibration: {} }).text).toMatch(/UNCALIBRATED/);
  });
  it("gives provisional its own class -- it must never look like a solve", () => {
    const p = calibrationBadge({ calibration: { provisional: true } });
    const c = calibrationBadge({ calibration: { calibrated: true } });
    expect(p.cls).not.toBe(c.cls);
  });
  it("calibrated wins if both flags are somehow set", () => {
    expect(calibrationBadge({ calibration: { calibrated: true, provisional: true } }).text).toMatch(/CALIBRATED/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/ui-mode.test.ts`
Expected: FAIL — cannot resolve `ui-mode.js`.

- [ ] **Step 3: Implement `dashboard/public/ui-mode.js`**

```js
// PURE: what mode the UI is in, derived ONLY from daemon state.
//
// No local flags: a local "am I tracking?" boolean can drift out of sync with
// the rig, and a control whose label disagrees with what it actually does is
// how an operator wastes a pass -- or worse, jogs when they meant to trim.

export function aimMode(state) {
  const s = state || {};
  if (s.estopLatched === true || s.sunLocked === true) return "locked";
  const t = (s.tracking && s.tracking.state) || "stopped";
  // "acquiring" counts as trim: the tracker owns the rig the moment it starts
  // slewing, so a raw jog would just be overwritten on the next tick.
  return t === "tracking" || t === "acquiring" || t === "waiting" ? "trim" : "jog";
}

export function calibrationBadge(state) {
  const cal = (state && state.calibration) || {};
  if (cal.calibrated === true) return { text: "CALIBRATED", cls: "badge-calibrated" };
  if (cal.provisional === true) return { text: "PROVISIONAL", cls: "badge-provisional" };
  return { text: "UNCALIBRATED", cls: "badge-uncalibrated" };
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/ui-mode.js test/ui-mode.test.ts
git commit -m "feat(dashboard): pure UI mode + calibration badge derivation"
```

---

### Task 3: Dashboard plumbing for the tools that have no UI

The daemon tools exist; the dashboard cannot reach them. `client.ts` already has `track()` — the rest need adding.

**Files:**
- Modify: `src/dashboard/client.ts`, `src/dashboard/controls.ts`, `src/dashboard/server.ts`
- Test: `test/dashboard-controls.test.ts`

**Interfaces:**
- Consumes: existing `McpDashboardClient.call()` and the `ControlDeps` pattern.
- Produces: client methods `characterizeImu()`, `setNorthZero()`, `teachLimit(edge)`, `clearTaughtLimits()`, `setHome()`, `captureSnapshot(icao?)`, `startRecording()`, `stopRecording()`; matching `ControlDeps` entries and `POST /api/control/*` routes. **Plus `calibration.imuMounting` on the wire** — see the blocker below.

> **BLOCKER found reviewing Task 1 — this task must close it.**
>
> `step-gate.js` gates the IMU step on `state.calibration.imuMounting`, but **that field does not exist anywhere on the wire**:
> - `src/calibration.ts:24` persists `imuMounting` as `{ rS, dBase }` — no `rmsDeg`
> - `get_calibration` (`src/geo-tools.ts`) never serialises `imuMounting` at all
> - `CalibrationRawZ` (`src/dashboard/client.ts:58`) and `CalibrationRaw` / `DashboardState.calibration` (`src/dashboard/state.ts:34, 96`) have no such field
>
> Consequence if unfixed: `hasImu` is permanently `false`, so the IMU step **and everything gated behind it** — north-zero, sighting 1, sighting 2, solve — render as permanently blocked even after a successful `characterize_imu`. The whole procedure would look broken.
>
> Surface it end to end: have `get_calibration` include the IMU characterisation status (at minimum a boolean, preferably with `rmsDeg` since the UI shows it as `detail`), add it to `CalibrationRawZ`, `CalibrationRaw` and `DashboardState.calibration`, and confirm `step-gate.js` reads it unchanged. **Do not change `step-gate.js`** — it is correct; the wire is what is missing.

- [ ] **Step 1: Write the failing test**

Add to `test/dashboard-controls.test.ts`, following the file's existing fake-deps style:

```ts
it("exposes a control for every tool the redesign needs", () => {
  const deps = makeFakeDeps();   // existing helper in this file
  for (const k of ["characterizeImu", "setNorthZero", "teachLimit", "clearTaughtLimits",
                   "setHome", "captureSnapshot", "startRecording", "stopRecording"]) {
    expect(typeof deps[k]).toBe("function");
  }
});

it("teachLimit passes the edge through unchanged", async () => {
  const seen: string[] = [];
  const deps = { ...makeFakeDeps(), teachLimit: async (e: string) => { seen.push(e); } };
  await deps.teachLimit("pan_max");
  expect(seen).toEqual(["pan_max"]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/dashboard-controls.test.ts`
Expected: FAIL — those deps do not exist.

- [ ] **Step 3: Add the client methods**

In `src/dashboard/client.ts`, following the shape of the existing `sightAircraft`/`solveCalibration` methods:

```ts
  async characterizeImu(): Promise<string> { return this.call("characterize_imu", {}); }
  async setNorthZero(): Promise<string> { return this.call("set_north_zero", {}); }
  async teachLimit(edge: string): Promise<string> { return this.call("teach_limit", { edge }); }
  async clearTaughtLimits(): Promise<string> { return this.call("clear_taught_limits", {}); }
  async setHome(): Promise<string> { return this.call("set_home", {}); }
  async captureSnapshot(icao?: string): Promise<string> {
    return this.call("capture_snapshot", icao ? { icao } : {});
  }
  async startRecording(): Promise<string> { return this.call("start_recording", {}); }
  async stopRecording(): Promise<string> { return this.call("stop_recording", {}); }
```

- [ ] **Step 4: Add ControlDeps entries and routes**

In `src/dashboard/controls.ts` add the matching `ControlDeps` fields, and in `src/dashboard/server.ts` register a `POST /api/control/<name>` for each, following the existing route pattern exactly (same auth gate, same error shaping, same `withTimeout` bounding as the other daemon-calling routes).

**`set_home` gets no special casing here** — the confirmation is a UI concern and belongs in Task 8, not the transport.

- [ ] **Step 5: Tests + typecheck**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; `TS7016` only.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/client.ts src/dashboard/controls.ts src/dashboard/server.ts test/dashboard-controls.test.ts
git commit -m "feat(dashboard): plumb characterize_imu, north_zero, teach_limit, set_home, capture"
```

---

### Task 4: Cockpit markup + CSS split

Structure only — no behaviour change yet. The page must still work exactly as it does today at the end of this task.

**Files:**
- Modify: `dashboard/public/index.html`
- Create: `dashboard/public/cockpit.css`, `dashboard/public/drawer.css`
- Modify: `dashboard/public/style.css` (reduced to shared base + imports)

**Interfaces:**
- Consumes: nothing.
- Produces: the DOM ids the later tasks bind to — `#cockpit`, `#aircraft-col`, `#video-col`, `#status-col`, `#aim-block`, `#drawer`, `#drawer-body`, `#proc-strip`, `#cal-badge`.

- [ ] **Step 1: Restructure `index.html` to the cockpit grid**

Three columns beside a header and an error strip:

```html
<header id="topbar">
  <span class="brand">TB3</span>
  <span id="cal-badge" class="badge"></span>
  <span id="health" class="health"></span>
  <button id="drawer-open" type="button">Setup ▾</button>
  <button id="estop" type="button" class="estop">E-STOP</button>
</header>

<div id="proc-strip" hidden></div>

<main id="cockpit">
  <section id="aircraft-col" class="col"><h2>Aircraft</h2><ul id="adsb-list"></ul></section>
  <section id="video-col" class="col">
    <div id="camera-frame"><!-- existing video/img/crosshair/video-stats markup, moved verbatim --></div>
    <div id="aim-block"><!-- direction buttons, trim readout, camera controls --></div>
  </section>
  <section id="status-col" class="col">
    <div id="rigview"></div><div id="minimap-panel"></div><div id="telemetry"></div>
  </section>
</main>

<aside id="drawer" hidden><div id="drawer-body"></div></aside>
<div id="errorstrip"><ul id="errors"></ul></div>
```

**Move the existing camera, rigview, minimap and telemetry markup verbatim** — same ids, same children. Later tasks rebind; this task must not change what any existing code finds via `getElementById`.

E-STOP sits in `#topbar` and is `position: sticky` so it is never scrolled away or covered.

- [ ] **Step 2: Split the CSS**

Move cockpit-layout rules into `cockpit.css`, drawer/strip rules into `drawer.css`, and leave shared tokens (colours, typography, chips, buttons) in `style.css`, which `@import`s the other two. Target: no file over 800 lines.

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test`
Expected: PASS — no test touches markup, so this is a smoke check that nothing imported broke.

Then load the dashboard and confirm video, radar, rig view, telemetry, jog and E-STOP all still work exactly as before. **This task is a pure move; if any behaviour changed, it is a bug.**

- [ ] **Step 4: Commit**

```bash
git add dashboard/public/index.html dashboard/public/style.css dashboard/public/cockpit.css dashboard/public/drawer.css
git commit -m "refactor(dashboard): cockpit grid markup + CSS split, no behaviour change"
```

---

### Task 5: `cockpit.js` — extract cockpit rendering from `app.js`

**Files:**
- Create: `dashboard/public/cockpit.js`
- Modify: `dashboard/public/app.js`

**Interfaces:**
- Consumes: `aimMode`, `calibrationBadge` (Task 2).
- Produces: `class Cockpit` with `constructor(deps)` and `render(state)`; `deps` carries the DOM elements and the post adapters so it is testable.

- [ ] **Step 1: Move the cockpit render path**

Move the render functions for telemetry, tracking status, services, badge, aircraft list and the AIM block out of `app.js` into `cockpit.js`, exposing one `render(state)`. Inject DOM elements and post adapters through the constructor rather than reaching for globals — same pattern `CameraPanel` already uses.

The AIM block's label and behaviour come from `aimMode(state)`:
- `"jog"` → direction controls drive `JogHold`
- `"trim"` → they drive `NudgeHold`, and the block shows **TRIM** plus the live offset
- `"locked"` → controls disabled with the reason (E-STOP or sun lock) shown

- [ ] **Step 2: Slim `app.js` to bootstrap**

`app.js` keeps: auth bootstrap, SSE subscription, instantiating `Cockpit`/`CameraPanel`/`JogHold`/`NudgeHold`/`JoystickHold`, and dispatching `render(state)` on each tick. Everything else moves out.

- [ ] **Step 3: Tests + typecheck**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. Existing pure-module tests must be untouched and green.

- [ ] **Step 4: Verify in the browser**

Load the dashboard: telemetry updates, tracking status updates, the AIM block says **TRIM** while tracking and **JOG** when idle, and is disabled under E-STOP.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/cockpit.js dashboard/public/app.js
git commit -m "refactor(dashboard): extract Cockpit from app.js"
```

---

### Task 6: Aircraft rows get `[Track]` and `[Sight]`

The operator's immediate blocker: `track_aircraft` has no button, and it is the first step of the calibration workflow.

**Files:**
- Modify: `dashboard/public/cockpit.js`, `dashboard/public/cockpit.css`
- Test: `test/aircraft-row.test.ts`

**Interfaces:**
- Consumes: `state.adsb.aircraft` rows (`hex, callsign, azimuth_deg, elevation_deg, range_km, trackable`).
- Produces: `function aircraftRowActions(row, state)` → `{ canTrack, trackReason, canSight, sightReason }`, pure and exported for test.

- [ ] **Step 1: Write the failing test**

Create `test/aircraft-row.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aircraftRowActions } from "../dashboard/public/cockpit.js";

const row = { hex: "a1b2c3", callsign: "AAL1", azimuth_deg: 47, elevation_deg: 31, range_km: 8.2, trackable: true };

describe("aircraftRowActions", () => {
  it("allows tracking a trackable aircraft when calibrated", () => {
    const a = aircraftRowActions(row, { calibration: { calibrated: true } });
    expect(a.canTrack).toBe(true);
  });

  it("allows tracking under a PROVISIONAL orientation -- that is the whole point", () => {
    // Drift calibration requires tracking BEFORE a real solve exists.
    const a = aircraftRowActions(row, { calibration: { provisional: true } });
    expect(a.canTrack).toBe(true);
  });

  it("refuses tracking with no orientation at all, and says why", () => {
    const a = aircraftRowActions(row, { calibration: {} });
    expect(a.canTrack).toBe(false);
    expect(a.trackReason).toMatch(/calibrat|north zero/i);
  });

  it("refuses tracking under E-STOP", () => {
    const a = aircraftRowActions(row, { calibration: { calibrated: true }, estopLatched: true });
    expect(a.canTrack).toBe(false);
    expect(a.trackReason).toMatch(/stop/i);
  });

  it("allows sighting whenever the rig location is known -- sighting does not move the rig", () => {
    const a = aircraftRowActions(row, { calibration: { rig: { lat: 1, lon: 2, height: 3 } } });
    expect(a.canSight).toBe(true);
  });

  it("refuses sighting without a rig location", () => {
    const a = aircraftRowActions(row, { calibration: {} });
    expect(a.canSight).toBe(false);
    expect(a.sightReason).toMatch(/location/i);
  });

  it("trackable:null (pre-calibration unknown) is not treated as false", () => {
    const a = aircraftRowActions({ ...row, trackable: null }, { calibration: { provisional: true } });
    expect(a.canTrack).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/aircraft-row.test.ts`
Expected: FAIL — `aircraftRowActions` not exported.

- [ ] **Step 3: Implement and render**

Export `aircraftRowActions` from `cockpit.js` and render each aircraft row with inline `[Track]` and `[Sight]` buttons, disabled with their reason as the `title` when unavailable. `[Track]` calls the existing `track` control; `[Sight]` calls `sight_aircraft` for that row's hex.

Note `trackable` is `null` (unknown) rather than `false` before calibration — treat `null` as "allowed, unknown", never as a refusal.

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/cockpit.js dashboard/public/cockpit.css test/aircraft-row.test.ts
git commit -m "feat(dashboard): Track and Sight actions on aircraft rows"
```

---

### Task 7: `drawer.js` — the Setup drawer shell and strip

**Files:**
- Create: `dashboard/public/drawer.js`
- Modify: `dashboard/public/app.js`, `dashboard/public/drawer.css`
- Test: `test/drawer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Drawer` with `open(entryId)`, `close()`, `collapseToStrip(html, handlers)`, `expand()`, and `mode()` → `"closed" | "open" | "strip"`.

- [ ] **Step 1: Write the failing test**

Create `test/drawer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Drawer } from "../dashboard/public/drawer.js";

function fakeEls() {
  const mk = () => ({ hidden: true, innerHTML: "", classList: { add: vi.fn(), remove: vi.fn() } });
  return { drawer: mk(), body: mk(), strip: mk() };
}

describe("Drawer", () => {
  it("starts closed", () => {
    expect(new Drawer(fakeEls()).mode()).toBe("closed");
  });
  it("opens and closes", () => {
    const d = new Drawer(fakeEls());
    d.open("calibration"); expect(d.mode()).toBe("open");
    d.close();             expect(d.mode()).toBe("closed");
  });
  it("collapsing to a strip hides the drawer body but keeps the procedure active", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.open("calibration");
    d.collapseToStrip("<b>trim</b>", {});
    expect(d.mode()).toBe("strip");
    expect(els.drawer.hidden).toBe(true);   // video must not be covered
    expect(els.strip.hidden).toBe(false);
  });
  it("expanding from a strip returns to the open drawer", () => {
    const d = new Drawer(fakeEls());
    d.open("calibration"); d.collapseToStrip("x", {}); d.expand();
    expect(d.mode()).toBe("open");
  });
  it("closing from a strip clears the strip", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.open("calibration"); d.collapseToStrip("x", {}); d.close();
    expect(d.mode()).toBe("closed");
    expect(els.strip.hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/drawer.test.ts`
Expected: FAIL — cannot resolve `drawer.js`.

- [ ] **Step 3: Implement `drawer.js`**

Three states — `closed`, `open`, `strip`. `strip` hides the drawer body and shows the slim bar so the **full cockpit including the video stays visible**, which is the constraint the whole design rests on. Entries: Calibration, Travel limits, Set home, Track sector, Joystick.

- [ ] **Step 4: Tests pass, wire the open button**

Run: `npm test`. Wire `#drawer-open` in `app.js` and confirm in the browser that opening the drawer never covers `#camera-frame`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/drawer.js dashboard/public/drawer.css dashboard/public/app.js test/drawer.test.ts
git commit -m "feat(dashboard): Setup drawer shell with strip collapse"
```

---

### Task 8: Calibration procedure in the drawer

**Files:**
- Create: `dashboard/public/procedures.js`
- Modify: `dashboard/public/drawer.js`

**Interfaces:**
- Consumes: `calibrationSteps` (Task 1), `Drawer` (Task 7), the client controls (Task 3).
- Produces: `function renderCalibration(state, actions)` returning the drawer body HTML plus handler bindings.

- [ ] **Step 1: Render the six steps with prerequisites**

Each row shows label, done-tick or action button, `detail`, and — when blocked — the `reason` as **visible text, not a tooltip**. A reason nobody can see is the bug this whole redesign exists to fix.

```js
import { calibrationSteps } from "./step-gate.js";

// actions: { runImu, setNorthZero, editRigLocation, startSighting, solve }
export function renderCalibration(state, actions) {
  const steps = calibrationSteps(state);
  const rows = steps.map((s, i) => {
    const mark = s.done ? "✓" : s.blocked ? "" : "→";
    const right = s.done
      ? `<button data-act="redo:${s.id}" class="link">redo</button>`
      : s.blocked
        ? `<span class="blocked-reason">${s.reason}</span>`
        : `<button data-act="run:${s.id}" class="primary">${s.id.startsWith("sight") ? "start" : "run"}</button>`;
    return `<li class="step ${s.done ? "done" : s.blocked ? "blocked" : "next"}">
      <span class="num">${i + 1}</span>
      <span class="label">${s.label}</span>
      <span class="detail">${s.detail}</span>
      <span class="mark">${mark}</span>
      ${right}
    </li>`;
  }).join("");

  // The divider marks where tracking becomes possible -- the operator needs to
  // know that north-zero is the gate that unlocks steps 4-6.
  return `<h2>Calibration</h2><ol class="steps">${rows}</ol>`;
}

// Steps 1-3 act in the drawer; 4-5 need the video, so they hand off to the strip.
export function stepHandler(id, drawer, state, actions) {
  if (id === "rig-location") return actions.editRigLocation();
  if (id === "imu") return actions.runImu();
  if (id === "north-zero") return actions.setNorthZero();
  if (id === "solve") return actions.solve();
  if (id === "sight-1" || id === "sight-2") return actions.startSighting(id, drawer);
  return undefined;
}
```

- [ ] **Step 2: Wire the strip for the sighting steps**

The strip shows the step name, the live trim offset from `state.tracking.offset`, the selected aircraft, and `[Sight it]` / `[cancel]`. `[Sight it]` calls `sight_aircraft`; on success the drawer re-expands and the step reads done.

- [ ] **Step 3: Verify the sequence end to end in the browser**

With an uncalibrated rig: steps 2–6 are blocked with reasons; setting the rig location unblocks step 2; and so on down the chain. **The video stays visible throughout.**

- [ ] **Step 4: Tests + typecheck**

Run: `npm test && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; `TS7016` only.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/procedures.js dashboard/public/drawer.js
git commit -m "feat(dashboard): guided calibration procedure with visible prerequisites"
```

---

### Task 9: Teach-limits procedure and Set home

**Files:**
- Modify: `dashboard/public/procedures.js`
- Test: `test/procedures-confirm.test.ts`

**Interfaces:**
- Consumes: `teachLimit`, `clearTaughtLimits`, `setHome` (Task 3).
- Produces: `function destructiveConfirm(action, state)` → `{ needed, message }`, pure and exported.

- [ ] **Step 1: Write the failing test**

Create `test/procedures-confirm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { destructiveConfirm } from "../dashboard/public/procedures.js";

describe("destructiveConfirm", () => {
  it("requires confirmation for set_home", () => {
    expect(destructiveConfirm("set_home", {}).needed).toBe(true);
  });

  it("names BOTH things set_home clears -- calibration and taught limits", () => {
    const m = destructiveConfirm("set_home", {
      calibration: { calibrated: true }, limits: { taught: { pan_max: 120 } },
    }).message;
    expect(m).toMatch(/calibrat/i);
    expect(m).toMatch(/limit/i);
  });

  it("requires confirmation for clearing taught limits", () => {
    expect(destructiveConfirm("clear_taught_limits", {}).needed).toBe(true);
  });

  it("does not gate a harmless action", () => {
    expect(destructiveConfirm("teach_limit", {}).needed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/procedures-confirm.test.ts`
Expected: FAIL — `destructiveConfirm` not exported.

- [ ] **Step 3: Implement teach-limits and Set home**

Teach limits: four edge buttons, each collapsing to a strip reading *"jog to the pan-max edge, then capture"* with `[Set pan max here]`. Show current taught values and a `[clear]`.

Set home: its own entry, gated behind `destructiveConfirm`, whose message names that it clears **both** the calibration and the taught limits — today it is visually indistinguishable from any other button despite being the most destructive one here.

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public/procedures.js test/procedures-confirm.test.ts
git commit -m "feat(dashboard): teach-limits procedure and guarded Set home"
```

---

### Task 10: Relocate sector + joystick, add capture controls, final size check

**Files:**
- Modify: `dashboard/public/index.html`, `drawer.js`, `cockpit.js`, `app.js`, both CSS files

**Interfaces:**
- Consumes: everything above.
- Produces: no new API.

- [ ] **Step 1: Move sector and joystick panels into the drawer**

Move the existing sector compass and joystick diagnostic panel markup **verbatim** into drawer entries. Relocation only — no redesign, no reimplementation. Their existing handlers keep working.

- [ ] **Step 2: Add capture controls to the cockpit CAM block**

`[snap]` → `captureSnapshot`; record start/stop → `startRecording`/`stopRecording`, beside the existing capture-status chip.

- [ ] **Step 3: Verify file sizes**

Run:

```bash
wc -l dashboard/public/app.js dashboard/public/cockpit.js dashboard/public/drawer.js \
      dashboard/public/procedures.js dashboard/public/style.css \
      dashboard/public/cockpit.css dashboard/public/drawer.css
```

Expected: every file under 800 lines. If one is over, split it before committing — that ceiling is why this task exists.

- [ ] **Step 4: Full verification**

Run: `npm test && npm run build && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; `TS7016` only.

Then in the browser: E-STOP is reachable in every state (drawer open, strip showing, tracking); the video is never covered; jog, trim, track, sight, teach-limits and calibration all work.

- [ ] **Step 5: Commit**

```bash
git add dashboard/public src/dashboard
git commit -m "feat(dashboard): relocate sector/joystick to drawer, add capture controls"
```

---

## Final verification

- [ ] `npm test` green; existing pure-module tests untouched.
- [ ] `npm run build` and `npx tsc -p tsconfig.json --noEmit` clean (`TS7016` only).
- [ ] Every `dashboard/public/` file under 800 lines.
- [ ] E-STOP reachable and unmoved in every UI state.
- [ ] The video is never covered by the drawer or strip.
- [ ] Every tool in the spec's placement table has a control, and the ones marked MCP-only still have none.
- [ ] A blocked calibration step always shows a reason.
- [ ] `set_home` confirms, naming both the calibration and the taught limits.
