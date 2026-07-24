# ADS-B Mini-Map (PPI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-down radar (PPI) in the dashboard: rig-centered, north-up, all nearby aircraft plotted by azimuth+range (trackable bright / untrackable grey), a laser line to the tracked target, the azimuth-sector arc overlaid, hover tooltips, and click-a-bright-dot to track.

**Architecture:** One small backend change — the dashboard fetches `scan_aircraft` with `only_trackable=false` and carries the per-plane trackability flags into the SSE `DashboardState` (`adsb.trackable` → `adsb.aircraft`). Everything else is frontend: a pure, unit-tested geometry module (`dashboard/public/minimap.js`) shared by the browser and vitest, plus a `renderMiniMap` canvas draw + hover/click wired into the existing app.js render loop.

**Tech Stack:** TypeScript/Node ESM (dashboard backend), vitest (`fileParallelism:false`), Zod. Dashboard frontend is vanilla JS/CSS, **no build step** (ES modules run natively in the browser). No new runtime dependencies.

## Global Constraints

- No `any`; `.js` import specifiers; ESM (backend TS).
- Dashboard `dashboard/public/` is vanilla JS/CSS, NO build step. The shared geometry helper is a native browser **ES module** (`export function …`), imported by app.js (which becomes `<script type="module">`) and by vitest.
- The daemon core is unchanged: `scan_aircraft` already supports `only_trackable=false` and already emits `reachable`/`sun_safe`/`slew_ok`/`in_sector` per row (`view()` in `src/adsb-tools.ts`). This feature only changes the *dashboard* service + frontend.
- `adsb.trackable` is RENAMED to `adsb.aircraft` (it now holds all planes). Every consumer updates; the list renderer filters to `a.trackable` client-side so its on-screen behavior is unchanged.
- Fixed range scale = `adsbMaxRangeKm` (default 100). Elevation lives in the hover tooltip only.
- Existing dashboard tests must stay green (the rename touches them — updating a field name is a necessary contract change, not a weakening). The canvas render + hover/click are on-host manual verification (no automated E2E, per dashboard convention).
- Build/test from `tb3-mcp/`: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"`; single `npx vitest run test/<file>.ts`; full `npm test`; type-check `npm run build` (tsc).

---

## File Structure

- **Modify `src/dashboard/client.ts`** — `scanTrackable()` → `scanAircraft()`: call `scan_aircraft` with `{ only_trackable: false, limit: 50 }`; `AircraftRowZ` parses `reachable`/`sun_safe`/`slew_ok`/`in_sector`; map to `AircraftRow` with a derived `trackable`.
- **Modify `src/dashboard/state.ts`** — `AircraftRow` gains `reachable`/`sunSafe`/`slewOk`/`inSector`/`trackable`; export `deriveTrackable`; `AdsbRaw`/`DashboardState.adsb`: `trackable` → `aircraft`; `mergeState` updates.
- **Modify `src/dashboard/server.ts`** — `getAdsb` returns `{ rawCount, aircraft }`; the `client.scanTrackable()` call becomes `client.scanAircraft()`.
- **Create `dashboard/public/minimap.js`** — ES module: `azRangeToXY(...)`, `nearestDot(...)` (pure, Node- and browser-importable).
- **Create `test/minimap.test.ts`** — vitest imports `../dashboard/public/minimap.js`.
- **Modify `dashboard/public/index.html`** — the map `<canvas>` + tooltip element + legend; app.js `<script>` becomes `type="module"`.
- **Modify `dashboard/public/app.js`** — `renderAdsb` reads `adsb.aircraft` (filter `trackable` for the list); `import` the geometry helpers; add `renderMiniMap` + hover + click-to-track.
- **Modify `dashboard/public/style.css`** — map/dot/laser/wedge/tooltip/legend styling.
- **Modify the existing dashboard tests** that reference `adsb.trackable` → `adsb.aircraft` (Task 1).

Order: 1 (backend data) → 2 (geometry module) → 3 (frontend widget). Each ends independently testable (1: TS unit + suite green; 2: vitest geometry; 3: on-host manual + build/suite green).

---

### Task 1: Backend — surface all planes with flags (`adsb.aircraft`)

**Files:**
- Modify: `tb3-mcp/src/dashboard/client.ts`, `tb3-mcp/src/dashboard/state.ts`, `tb3-mcp/src/dashboard/server.ts`
- Modify: the existing dashboard tests referencing `adsb.trackable` (grep `test/` for `\.trackable` / `adsb.trackable`)
- Modify (frontend consumer, keeps the list working): `tb3-mcp/dashboard/public/app.js` `renderAdsb`
- Test: `tb3-mcp/test/dashboard-aircraft.test.ts` (new) for `deriveTrackable`; extend the existing state/merge test for the rename

**Interfaces:**
- Produces: `deriveTrackable(f: { reachable: boolean; sunSafe: boolean; slewOk: boolean; inSector: boolean }): boolean` (exported from `state.ts`); `AircraftRow` with the five new booleans; `DashboardState.adsb.aircraft: AircraftRow[]`; `McpDashboardClient.scanAircraft(): Promise<AircraftRow[]>`.

- [ ] **Step 1: Write the failing test for `deriveTrackable` + the rename**

```typescript
// tb3-mcp/test/dashboard-aircraft.test.ts
import { describe, it, expect } from "vitest";
import { deriveTrackable, mergeState, type SourceInputs, type AircraftRow } from "../src/dashboard/state.js";

const flags = (o: Partial<{ reachable: boolean; sunSafe: boolean; slewOk: boolean; inSector: boolean }> = {}) =>
  ({ reachable: true, sunSafe: true, slewOk: true, inSector: true, ...o });

describe("deriveTrackable", () => {
  it("is true only when all four flags are true", () => {
    expect(deriveTrackable(flags())).toBe(true);
    expect(deriveTrackable(flags({ reachable: false }))).toBe(false);
    expect(deriveTrackable(flags({ sunSafe: false }))).toBe(false);
    expect(deriveTrackable(flags({ slewOk: false }))).toBe(false);
    expect(deriveTrackable(flags({ inSector: false }))).toBe(false);
  });
});

describe("mergeState carries adsb.aircraft with flags", () => {
  it("passes the full plane list through under adsb.aircraft", () => {
    const row: AircraftRow = {
      hex: "abc123", callsign: "TEST", category: null, squawk: null, altitude_m: 6000,
      ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 10, range_km: 30, est_track_sec: 60,
      reachable: true, sunSafe: true, slewOk: true, inSector: false, trackable: false,
    };
    const s = {
      deviceStatus: { ok: false, error: "x" }, rigDirect: { ok: false, error: "x" },
      tracking: { ok: false, error: "x" }, tracked: { ok: false, error: "x" },
      calibration: { ok: false, error: "x" }, sun: { ok: false, error: "x" },
      services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
      adsb: { ok: true, value: { rawCount: 5, aircraft: [row] } },
      camera: { enabled: false, streaming: false, viewers: 0 },
    } as unknown as SourceInputs;
    const merged = mergeState(s, 0);
    expect(merged.adsb.aircraft).toHaveLength(1);
    expect(merged.adsb.aircraft[0].inSector).toBe(false);
    expect(merged.adsb.aircraft[0].trackable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-aircraft.test.ts`
Expected: FAIL — `deriveTrackable` not exported; `AircraftRow` lacks the flags; `adsb.aircraft` undefined.

- [ ] **Step 3: Update `state.ts`**

In `tb3-mcp/src/dashboard/state.ts`:
```typescript
// AircraftRow: add the flags (after est_track_sec):
export interface AircraftRow {
  hex: string; callsign: string | null; category: string | null; squawk: string | null;
  altitude_m: number | null; ground_speed_kt: number | null;
  azimuth_deg: number; elevation_deg: number; range_km: number; est_track_sec: number;
  reachable: boolean; sunSafe: boolean; slewOk: boolean; inSector: boolean; trackable: boolean;
}

export function deriveTrackable(f: { reachable: boolean; sunSafe: boolean; slewOk: boolean; inSector: boolean }): boolean {
  return f.reachable && f.sunSafe && f.slewOk && f.inSector;
}

// AdsbRaw: rename trackable -> aircraft
export interface AdsbRaw { rawCount: number | null; aircraft: AircraftRow[]; }

// DashboardState.adsb: rename
//   adsb: { rawCount: number | null; aircraft: AircraftRow[]; };
```
In `mergeState`, change the adsb line:
```typescript
    adsb: { rawCount: adsb?.rawCount ?? null, aircraft: adsb?.aircraft ?? [] },
```

- [ ] **Step 4: Update `client.ts`**

In `tb3-mcp/src/dashboard/client.ts`: extend `AircraftRowZ`, and rewrite `scanTrackable` → `scanAircraft`:
```typescript
import { deriveTrackable } from "./state.js"; // add to imports

const AircraftRowZ = z.object({
  hex: z.string(), callsign: z.string().nullable(), category: z.string().nullable(), squawk: z.string().nullable(),
  altitude_m: z.number().nullable(), ground_speed_kt: z.number().nullable(),
  azimuth_deg: z.number(), elevation_deg: z.number(), range_km: z.number(), est_track_sec: z.number(),
  reachable: z.boolean(), sun_safe: z.boolean(), slew_ok: z.boolean(), in_sector: z.boolean(),
});
const ScanBodyZ = z.object({ aircraft: z.array(AircraftRowZ) });

// Replace scanTrackable():
async scanAircraft(): Promise<AircraftRow[]> {
  const body = ScanBodyZ.parse(JSON.parse(await this.call("scan_aircraft", { only_trackable: false, limit: 50 })));
  return body.aircraft.map((r) => ({
    hex: r.hex, callsign: r.callsign, category: r.category, squawk: r.squawk,
    altitude_m: r.altitude_m, ground_speed_kt: r.ground_speed_kt,
    azimuth_deg: r.azimuth_deg, elevation_deg: r.elevation_deg, range_km: r.range_km, est_track_sec: r.est_track_sec,
    reachable: r.reachable, sunSafe: r.sun_safe, slewOk: r.slew_ok, inSector: r.in_sector,
    trackable: deriveTrackable({ reachable: r.reachable, sunSafe: r.sun_safe, slewOk: r.slew_ok, inSector: r.in_sector }),
  }));
}
```
(The `AircraftRow` import in client.ts is already present via `./state.js`.)

- [ ] **Step 5: Update `server.ts`**

In `tb3-mcp/src/dashboard/server.ts` `getAdsb`:
```typescript
    const aircraft = await withTimeout(client.scanAircraft(), COLLECT_CALL_TIMEOUT_MS, "scanAircraft");
    // ... rawCount unchanged ...
    return { ok: true, value: { rawCount, aircraft } };
```

- [ ] **Step 6: Update the existing dashboard tests + the app.js list consumer**

- Grep the tests: `cd tb3-mcp && grep -rn "adsb.trackable\|\.trackable\b\|scanTrackable" test/ src/dashboard/`. Update every `adsb.trackable` → `adsb.aircraft`, `scanTrackable` → `scanAircraft`, and any test fixture `AircraftRow` to include the five new booleans (they're now required fields).
- `dashboard/public/app.js` `renderAdsb`: change to read `adsb.aircraft` and filter to trackable for the list (behavior unchanged):
```javascript
function renderAdsb(adsb) {
  const a = adsb ?? { rawCount: null, aircraft: [] };
  const all = Array.isArray(a.aircraft) ? a.aircraft : [];
  const trackable = all.filter((r) => r.trackable);
  // ... the rest of the existing renderAdsb body, using `trackable` where it used the old array,
  //     and `all.length`/`a.rawCount` for the counts (keep the "(N trackable / M seen)" text) ...
}
```

- [ ] **Step 7: Run tests + build + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/dashboard-aircraft.test.ts && npm run build && npm test`
Expected: new tests PASS; tsc clean; full suite green (the updated dashboard tests pass under the rename).

- [ ] **Step 8: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/dashboard tb3-mcp/dashboard/public/app.js tb3-mcp/test && git commit -m "feat(minimap): dashboard fetches all planes + trackability flags (adsb.aircraft)"
```

---

### Task 2: Pure geometry module (`minimap.js`) + unit tests

**Files:**
- Create: `tb3-mcp/dashboard/public/minimap.js`
- Test: `tb3-mcp/test/minimap.test.ts`

**Interfaces:**
- Produces (ES-module exports, pure, no DOM): `azRangeToXY(azDeg, rangeKm, maxRangeKm, cx, cy, radius) → { x, y }`; `nearestDot(dots, px, py, maxDistPx) → dot | null` where each `dot` has `{ x, y, ... }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/minimap.test.ts
import { describe, it, expect } from "vitest";
import { azRangeToXY, nearestDot } from "../dashboard/public/minimap.js";

describe("azRangeToXY (north up, east right)", () => {
  const cx = 100, cy = 100, radius = 100, maxKm = 100;
  it("range 0 is the center", () => {
    const p = azRangeToXY(37, 0, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx, 6); expect(p.y).toBeCloseTo(cy, 6);
  });
  it("north (0deg) at max range is straight up", () => {
    const p = azRangeToXY(0, maxKm, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx, 6); expect(p.y).toBeCloseTo(cy - radius, 6);
  });
  it("east (90deg) is to the right", () => {
    const p = azRangeToXY(90, maxKm, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx + radius, 6); expect(p.y).toBeCloseTo(cy, 6);
  });
  it("south (180deg) is down; west (270deg) is left", () => {
    const s = azRangeToXY(180, maxKm, maxKm, cx, cy, radius);
    expect(s.x).toBeCloseTo(cx, 6); expect(s.y).toBeCloseTo(cy + radius, 6);
    const w = azRangeToXY(270, maxKm, maxKm, cx, cy, radius);
    expect(w.x).toBeCloseTo(cx - radius, 6); expect(w.y).toBeCloseTo(cy, 6);
  });
  it("range scales linearly to the rim", () => {
    const p = azRangeToXY(90, 50, 100, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx + radius / 2, 6);
  });
});

describe("nearestDot", () => {
  const dots = [{ x: 10, y: 10, hex: "a" }, { x: 100, y: 100, hex: "b" }];
  it("returns the closest dot within maxDistPx", () => {
    expect(nearestDot(dots, 12, 12, 8)?.hex).toBe("a");
  });
  it("returns null when nothing is within maxDistPx", () => {
    expect(nearestDot(dots, 50, 50, 8)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/minimap.test.ts`
Expected: FAIL — `dashboard/public/minimap.js` does not exist.

- [ ] **Step 3: Implement `minimap.js`**

```javascript
// tb3-mcp/dashboard/public/minimap.js
// Pure PPI geometry, shared by the browser (app.js imports it) and vitest.
// No DOM references at module scope, so Node/vitest can import it directly.

// Polar (compass bearing + range) -> screen pixels. North up, east right:
// screen x grows east, screen y grows DOWN, so north (az 0) is -y.
export function azRangeToXY(azDeg, rangeKm, maxRangeKm, cx, cy, radius) {
  const rPx = maxRangeKm > 0 ? (rangeKm / maxRangeKm) * radius : 0;
  const a = (azDeg * Math.PI) / 180;
  return { x: cx + rPx * Math.sin(a), y: cy - rPx * Math.cos(a) };
}

// Nearest dot to (px,py) within maxDistPx, or null. `dots` items have x/y.
export function nearestDot(dots, px, py, maxDistPx) {
  let best = null;
  let bestD2 = maxDistPx * maxDistPx;
  for (const d of dots) {
    const dx = d.x - px, dy = d.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) { bestD2 = d2; best = d; }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/minimap.test.ts`
Expected: PASS (7 assertions across the cases).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/dashboard/public/minimap.js tb3-mcp/test/minimap.test.ts && git commit -m "feat(minimap): pure PPI geometry module (azRangeToXY, nearestDot) + tests"
```

---

### Task 3: The mini-map widget (canvas render + hover + click-to-track)

**Files:**
- Modify: `tb3-mcp/dashboard/public/index.html` (canvas + tooltip + legend; app.js `<script>` → `type="module"`), `tb3-mcp/dashboard/public/app.js` (import geometry; `renderMiniMap` + hover + click), `tb3-mcp/dashboard/public/style.css`

**Verification:** on-host manual (vanilla JS canvas — no automated E2E, per dashboard convention). `npm run build` must stay clean (no TS touched here except none) and `npm test` green.

This wires the widget into the existing app.js render loop, following the existing patterns: `render(state)` (the SSE dispatcher) calls the per-panel renderers; `postControl(path, body)` is the control-POST helper; `estopLatched` + `applyMotionGate()` are the E-STOP gate; the compass widget already keeps the current sector in a module variable (grep app.js for `sectorLocal` / the `/api/sector` fetch) — reuse it for the wedge.

- [ ] **Step 1: Convert app.js to a module + import the geometry**

In `dashboard/public/index.html`, change the app.js tag to a module:
```html
<script type="module" src="app.js"></script>
```
At the top of `app.js`:
```javascript
import { azRangeToXY, nearestDot } from "./minimap.js";
```
Run `npx serve`/load the page on-host (or just confirm no console errors); app.js is self-contained (addEventListener-based, no inline handlers, no globals other scripts need), so module scope is safe. Verify the dashboard still renders as before.

- [ ] **Step 2: Add the canvas + tooltip + legend to `index.html`**

Add near the ADS-B list panel (right rail):
```html
<div class="panel minimap-panel">
  <h2>Radar</h2>
  <canvas id="minimap" width="320" height="320"></canvas>
  <div id="minimap-tooltip" class="minimap-tooltip" hidden></div>
  <div class="minimap-legend"><span class="dot-trackable"></span> trackable <span class="dot-untrackable"></span> blocked</div>
</div>
```

- [ ] **Step 3: Implement `renderMiniMap` in `app.js` + wire it into `render`**

Add `el.minimap = document.getElementById("minimap")` (and the tooltip) to the element map. In `render(state)`, after `renderAdsb(state.adsb)`, call `renderMiniMap(state)`. Implement:

```javascript
// Module-level so hover/click can hit-test the same dots the last frame drew.
let miniMapDots = [];   // [{ x, y, row }]

function renderMiniMap(state) {
  const cv = el.minimap; if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, radius = Math.min(W, H) / 2 - 14;
  const maxKm = MAX_RANGE_KM; // = 100 (adsbMaxRangeKm); a const near the top of app.js
  ctx.clearRect(0, 0, W, H);

  // Range rings + N tick (label a few km values).
  ctx.strokeStyle = "…"; ctx.fillStyle = "…";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath(); ctx.arc(cx, cy, radius * frac, 0, 2 * Math.PI); ctx.stroke();
    // label Math.round(maxKm * frac) + "km" near the top of each ring
  }
  // draw the N tick / compass letters

  // Sector wedge (reuse the compass widget's current sector — sectorLocal).
  // If sector.enabled, shade the OPEN arc: for each bearing step in [start..end]
  // (clockwise, north-wrap aware — the compass widget already has this split),
  // fill a wedge from center to the rim. Draw UNDER the dots.

  // Dots.
  miniMapDots = [];
  const aircraft = (state.adsb && state.adsb.aircraft) || [];
  for (const row of aircraft) {
    if (!Number.isFinite(row.azimuth_deg) || !Number.isFinite(row.range_km)) continue;
    const p = azRangeToXY(row.azimuth_deg, Math.min(row.range_km, maxKm), maxKm, cx, cy, radius);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = row.trackable ? "…bright…" : "…grey…";
    ctx.fill();
    miniMapDots.push({ x: p.x, y: p.y, row });
  }

  // Tracked target: highlight ring + laser line from center.
  const trk = state.tracking;
  if (trk && trk.hex && Number.isFinite(trk.targetAzDeg) && Number.isFinite(trk.targetRangeM)) {
    const p = azRangeToXY(trk.targetAzDeg, Math.min(trk.targetRangeM / 1000, maxKm), maxKm, cx, cy, radius);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.strokeStyle = "…laser…"; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI); ctx.strokeStyle = "…laser…"; ctx.stroke();
  }

  // rig marker at center
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 2 * Math.PI); ctx.fillStyle = "…"; ctx.fill();
}
```
(Fill in the exact colors from `style.css`/the dashboard theme; the point is the structure. The sector wedge reuses the compass widget's existing north-wrap arc handling — factor that path or replicate its `start<=end` vs `start>end` split.)

- [ ] **Step 4: Hover tooltip + click-to-track**

```javascript
el.minimap.addEventListener("mousemove", (e) => {
  const rect = el.minimap.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (el.minimap.width / rect.width);
  const py = (e.clientY - rect.top) * (el.minimap.height / rect.height);
  const hit = nearestDot(miniMapDots, px, py, 8);
  if (!hit) { el.minimapTooltip.hidden = true; return; }
  const r = hit.row;
  el.minimapTooltip.textContent =
    `${r.callsign || r.hex} · ${r.altitude_m ?? "?"}m · ${r.range_km.toFixed(0)}km · el ${r.elevation_deg.toFixed(0)}°` +
    (r.trackable ? "" : " · blocked");
  el.minimapTooltip.style.left = `${e.clientX - rect.left + 8}px`;
  el.minimapTooltip.style.top = `${e.clientY - rect.top + 8}px`;
  el.minimapTooltip.hidden = false;
  el.minimap.style.cursor = r.trackable ? "pointer" : "default";
});
el.minimap.addEventListener("mouseleave", () => { el.minimapTooltip.hidden = true; });
el.minimap.addEventListener("click", (e) => {
  if (estopLatched) return; // same E-STOP gate the other motion controls honor
  const rect = el.minimap.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (el.minimap.width / rect.width);
  const py = (e.clientY - rect.top) * (el.minimap.height / rect.height);
  const hit = nearestDot(miniMapDots, px, py, 8);
  if (hit && hit.row.trackable) postControl("track", { hex: hit.row.hex });
});
```

- [ ] **Step 5: Style in `style.css`**

Add `.minimap-panel`, `#minimap` (square, responsive `max-width:100%`), `.minimap-tooltip` (absolute, small, `pointer-events:none`), `.minimap-legend` + the trackable/untrackable dot swatches. Theme-consistent with the rest of the dashboard.

- [ ] **Step 6: Verify build + suite, then manual on-host**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npm run build && npm test`
Expected: tsc clean; suite green (no new automated tests here — the module conversion + widget are runtime).
On-host manual (document as the verification): the radar renders rings + a north-up picture; a plane due-east shows to the right; bright dots match the list's trackable set and grey dots are the blocked ones; the sector wedge matches the compass widget; the tracked plane shows the laser line + highlight; hover shows the tooltip; clicking a bright dot starts tracking and a grey dot does nothing; an E-STOP latch makes clicks inert.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/dashboard/public && git commit -m "feat(minimap): PPI radar widget — rings, sector wedge, dots, target laser, hover + click-to-track"
```

---

## Self-Review

**Spec coverage:** All-planes-with-flags plumbing → Task 1 (client fetch `only_trackable=false`, flags, `adsb.aircraft`, list filter). Pure geometry (`azRangeToXY`) → Task 2. Rings/dots/bright-vs-grey/sector-wedge/target-laser/hover/click-to-track → Task 3. Fixed range = `adsbMaxRangeKm` → Task 3 (`MAX_RANGE_KM`). Elevation-on-hover → Task 3 Step 4. Error handling (no calibration → rings + placeholder; empty ADS-B → rings only; NaN az/range skipped) → Task 3 (the `Number.isFinite` guards + the existing "not polled" degradation). Testing (geometry unit + flag derivation + merge) → Tasks 1-2; canvas on-host → Task 3.

**Placeholder scan:** Task 3's `renderMiniMap`/CSS steps intentionally show structure with `"…"` color placeholders and reference the compass widget's existing north-wrap arc split rather than transcribing every pixel — the canvas widget is on-host-manual and its exact colors come from the dashboard theme; the load-bearing logic (projection via the tested `azRangeToXY`, the `trackable` bright/grey split, the target laser from `targetAzDeg`/`targetRangeM`, the E-STOP-gated click) is concrete. Tasks 1-2 carry complete code.

**Type consistency:** `AircraftRow` (Task 1) gains `reachable`/`sunSafe`/`slewOk`/`inSector`/`trackable` and is consumed by name in the client map, `mergeState`, and the frontend (`row.trackable`). `deriveTrackable` is defined once (state.ts) and used by the client. `adsb.aircraft` replaces `adsb.trackable` everywhere (state, server, tests, app.js). `azRangeToXY`/`nearestDot` (Task 2) are imported by the Task 3 widget with the exact signatures the tests pin. Wire fields stay snake_case (`azimuth_deg`, `range_km`, `in_sector`); the TS `AircraftRow` uses the mix already in `state.ts` (snake_case for the passthrough tool fields, camelCase for the derived booleans) — matching the existing file's convention.
