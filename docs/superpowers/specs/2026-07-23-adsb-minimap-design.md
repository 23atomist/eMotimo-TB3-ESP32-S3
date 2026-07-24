# ADS-B Mini-Map (PPI) — Design

**Status:** design, approved 2026-07-23. Follow-on to the azimuth-sector filter
(reuses its sector arc + the `inSector` trackability flag, both on `main`).
Independent of the IMU-calibration PR #7.

## Problem / goal

The operator wants a spatial view of the air picture, not just the tabular
trackable list: "a mini-map with planes overlayed and laser-like pointers at the
object being tracked." A top-down plan-position-indicator (PPI / radar) makes the
scene legible — where the planes are relative to the rig, which ones the rig can
actually chase, and where the azimuth sector blocks tracking.

## Scope

- **In scope:** a read-mostly PPI widget in the dashboard: rig-centered, north-up,
  range rings, all nearby aircraft plotted by azimuth+range (trackable bright /
  untrackable grey), a laser line to the tracked target, the sector arc overlaid,
  hover tooltips, and click-a-bright-dot to track.
- **Out of scope:** a geographic (lat/lon tile) map; altitude as a spatial axis;
  history trails; auto-scaling zoom (a fixed range for v1).

## Architecture

The dashboard is a separate `tb3-dashboard` service: an MCP client to the daemon
that serves a static SPA (`dashboard/public/`, vanilla JS/CSS, **no build step**)
and pushes a `DashboardState` over SSE (`src/dashboard/*`). The map is almost pure
frontend reading that state; the one backend change is fetching the *full* plane
set instead of trackable-only.

### Backend (the one real addition — surface all planes + their flags)

Today `collect()` calls `client.scanTrackable()` → `scan_aircraft` with the
default `only_trackable=true`, and the dashboard `AircraftRow` (`state.ts`) drops
the trackability flags. To grey out untrackable planes the map needs the full set
with flags:

1. **`src/dashboard/client.ts`** — `scanTrackable()` (rename to `scanAircraft()`
   or keep the name) calls `scan_aircraft` with `only_trackable=false` and a
   larger `limit` (e.g. 50). Extend `AircraftRowZ` to parse the flags the tool
   already emits per row: `reachable`, `sun_safe`, `slew_ok`, `in_sector`.
2. **`src/dashboard/state.ts`** — `AircraftRow` gains `reachable`/`sunSafe`/
   `slewOk`/`inSector: boolean` and a derived `trackable: boolean`
   (`reachable && sunSafe && slewOk && inSector`). **Rename `adsb.trackable` →
   `adsb.aircraft`** — it now holds *all* nearby planes, so the old name would
   mislead. Every consumer of `adsb.trackable` (mergeState, the SSE payload, and
   the `app.js` list renderer) updates to `adsb.aircraft`, and the list renderer
   filters to `a.trackable` client-side so its on-screen behavior is unchanged.
3. **`src/dashboard/server.ts` / the SSE poller** — no shape change beyond the
   above; `mergeState` passes the list through.
4. **The existing trackable-list renderer (`app.js`)** — now that the list can
   receive untrackable planes, it filters to `trackable` ones so its current
   behavior (trackable planes with Track buttons) is unchanged. The map uses the
   whole set.

The sector arc is already reachable via `GET /api/sector` (added by the
azimuth-sector feature); the map reuses it, or reads it from a shared cache the
compass widget already fetches.

### Frontend (`dashboard/public/`, the map itself)

- **`index.html`** — a `<canvas>` (square) in the right rail near the ADS-B list,
  plus a small legend.
- **`app.js`** — a `renderMiniMap(state, sector)` that runs each SSE tick:
  - **Projection:** `bearing/range → screen`. Center = rig. `r_px = (range_km /
    maxRangeKm) * radius`; `x = cx + r_px*sin(az)`, `y = cy − r_px*cos(az)`
    (north up, east right; az in degrees true). A pure helper
    `azRangeToXY(azDeg, rangeKm, maxRangeKm, cx, cy, radius)` — unit-tested.
  - **Rings:** concentric circles at labeled km values up to `maxRangeKm`
    (default `adsbMaxRangeKm` = 100), with a N tick.
  - **Dots:** bright fill for `trackable`, grey for not. The tracked target
    (`tracking.hex`) gets a highlight ring and a **laser line** from center out to
    it, plotted from `tracking.targetAzDeg` + `tracking.targetRangeM` (both already
    in the SSE state). (A separate "servo lag" line showing the rig's *current*
    boresight is deferred — the dashboard state doesn't carry the rig's ENU
    pointing azimuth, only device `panDeg`; converting it needs the calibration
    the daemon holds, so that's a later daemon-surface addition, not v1.)
  - **Sector wedge:** the open arc shaded (same bearings/`inArc` semantics as the
    compass widget), clipped to the outer ring, drawn under the dots.
  - Dots beyond `maxRangeKm` are clamped to the rim or omitted (they aren't
    fetched anyway, since `scan_aircraft` filters by range).
- **`style.css`** — ring/dot/laser/wedge/legend styling; theme-aware if the
  dashboard already is.

### Interactivity

- **Hover:** nearest-dot hit-test (within a few px) → a tooltip with callsign/hex,
  altitude (m/ft), range (km), elevation (°).
- **Click a bright dot:** POST the existing `track` control action (the same one
  the list's Track buttons call) with that hex. Grey dots are inert. The click is
  gated by the same E-STOP latch the other motion controls honor (skip if
  latched), and all safety (sun-lock/limits/deadman) stays enforced by the daemon.

## Data flow

SSE tick → `DashboardState.adsb` (all planes + flags) + `tracking` (target) +
`/api/sector` → `renderMiniMap` draws rings, sector wedge, dots (bright/grey),
target highlight + laser line. Hover reads the same dot set; click → `track`
control → daemon `track_aircraft`.

## Decisions (picked defaults)

- **Fixed range scale** = `adsbMaxRangeKm` (not auto-scale) — stable, and it's the
  true max any plotted plane can have. A zoom control is a later refinement.
- **Elevation lives in the hover tooltip**, not encoded as dot size/color — keeps
  a top-down map readable.
- **Placement:** right rail beside the ADS-B trackable list (spatial + tabular
  views together). Layout tweak, not load-bearing.

## Error handling

- No calibration / no rig location → `scan_aircraft` errors; the map renders the
  rings + "not calibrated" placeholder (mirrors how the list handles it).
- Empty/failed ADS-B source → rings only, no dots (graceful, never throws).
- A plane with a missing/NaN azimuth or range is skipped, not drawn at the origin.

## Testing

**Unit (vitest):**
- `azRangeToXY`: north/east/south/west map to up/right/down/left; range 0 → center;
  `maxRangeKm` → rim; a known (az,range) → expected (x,y).
- The derived `trackable` flag on the dashboard `AircraftRow` (all four sub-flags
  true → trackable; any false → not), and that `mergeState` carries the full plane
  list with flags intact.
- The client Zod parse tolerates the flags being present (and still parses when a
  future tool output adds fields — non-strict).

**On-host manual (no automated E2E, per dashboard convention):** the canvas
renders rings + a north-up picture; bright vs grey dots match the list's
trackable set; the sector wedge matches the compass widget; the tracked plane
shows the laser line; hover shows a tooltip; clicking a bright dot starts tracking
and clicking a grey one does nothing.

## Files

- Modify: `src/dashboard/client.ts` (fetch all + parse flags), `src/dashboard/state.ts`
  (`AircraftRow` flags + `trackable`), `dashboard/public/index.html`,
  `dashboard/public/app.js` (renderMiniMap + hover/click + list filter), `dashboard/public/style.css`.
- Create: `src/dashboard/minimap.ts` (or a section of a geometry util) for the pure
  `azRangeToXY` + trackable-flag helpers so they're unit-testable; `test/minimap.test.ts`.
- Possibly: a small tweak to how the trackable list filters (client-side) now that
  the state carries all planes.
