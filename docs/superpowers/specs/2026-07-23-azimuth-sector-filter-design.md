# Azimuth-Sector Tracking Filter — Design

**Status:** design, approved 2026-07-23. Follow-on to the IMU-aided calibration
(independent of it — filters on `azimuthDeg`, which already exists on `main`).

## Problem

The operator's house blocks roughly half the horizon. Autonomous ADS-B tracking
will happily lock onto a plane in a blocked direction and slew the rig into the
house (and risk winding up cable). Tracking must be restricted to a configured
**open azimuth arc** — only planes whose bearing falls inside the arc are
trackable, and an in-progress track must stop if its target drifts out of the
arc.

## Scope (explicitly bounded)

- **In scope:** a soft *tracking filter*. It only ever removes planes from the
  trackable set and stops a track that leaves the arc. It never creates motion.
- **Out of scope (deliberately):** hard motion limits. Manual `jog` / `goto` /
  `point_at` stay unrestricted. The fixed device-frame "cable slack" pan limit is
  a separate, different-frame concern (the queued *pan-limit tightening* item) and
  is not derived from this world-azimuth arc.

## Model

A persisted sector:

```ts
interface TrackSector { enabled: boolean; startDeg: number; endDeg: number; }
```

- `startDeg` / `endDeg` are true-north compass bearings in `[0, 360)`.
- The **open arc** sweeps **clockwise from `startDeg` to `endDeg`**. So
  `{startDeg: 300, endDeg: 60}` is the 120° slice through north (300 → 350 → 0 →
  60); `{startDeg: 90, endDeg: 270}` is the eastern-through-south half.
- `enabled: false` ≡ full 360°, no restriction. **This is the default** — the
  feature is inert until the operator sets and enables an arc, so it introduces
  zero behavior change on its own.

## Architecture

### Daemon

1. **Pure predicate** — `src/track/sector.ts` (new):
   ```ts
   export function inArc(azDeg: number, sector: TrackSector): boolean;
   ```
   `enabled === false` → always `true`. Otherwise normalize `az`, `start`, `end`
   to `[0, 360)`; if `start <= end` inside = `start <= az <= end`; if `start > end`
   (wraps north) inside = `az >= start || az <= end`. Boundaries inclusive.

2. **Enrichment flag** — `src/adsb/enrich.ts`: `EnrichedAircraft` gains
   `inSector: boolean`, set from `inArc(e.azimuthDeg, sector)`. `enrichAircraft`
   takes the sector as a parameter (defaulting to a disabled sector, so existing
   callers/tests are unaffected — same pattern the `cHead` default uses).

3. **Trackability gate** — `src/adsb-tools.ts`:
   `isTrackable(e) = e.reachable && e.sunSafe && e.slewOk && e.inSector`. Because
   `isTrackable` already gates both the `scan_aircraft` `only_trackable` filter
   and the `track_aircraft` defense-in-depth re-check, this single change removes
   out-of-arc planes from the trackable list *and* makes `track_aircraft` refuse
   them.

4. **In-track auto-stop** — the acquisition gate (step 3) only stops a track from
   *starting* out of the arc; a plane that drifts out *mid-track* is a separate
   check. The tracking tick must evaluate `inArc(targetAz, sector)` each update
   and, when the bound target leaves the arc, stop the track and hold — the same
   place and mechanism the sun-guard enforces its cone (the `SunSupervisor` tick),
   using the existing `stop_tracking` stop path and surfacing the reason
   (`target left the tracking sector`). No new motion path is introduced. The plan
   locates this precisely: if the follower/session already re-runs the
   trackability check per snapshot it is automatic; otherwise the sector check is
   added to that tick. Behavior on stop = **stop + hold** (not park), matching a
   lost target.

5. **Persistence** — `src/sector-store.ts` (new): a tiny atomic-write JSON store
   mirroring `CalibrationStore` (Zod-validated, never throws on load, tolerates a
   missing/corrupt file by returning the default disabled sector). **Separate
   from the calibration profile on purpose:** the arc is world-azimuth and must
   survive a `clear_calibration` / recalibration (the house does not move).
   Persisted under a path from config (default alongside `calibrationFile`, e.g.
   `sector.json`).

6. **MCP tools** — a new module (or folded into `adsb-tools.ts`):
   - `get_track_sector` → `{ enabled, start_deg, end_deg }`.
   - `set_track_sector({ start_deg, end_deg, enabled })` → validates `[0,360)`,
     persists, returns the stored sector. Input schema uses Zod bounds.

7. **Wiring** — the sector store is loaded at daemon start and threaded to
   `scanAircraft` / the follower / the tracking session the same way `cfg` and the
   calibration store already are. `registerAdsbTools` reads the current sector per
   call (so a `set_track_sector` mid-session takes effect immediately, like
   `getCHead()`).

### Dashboard (`tb3-mcp/dashboard/public/`, vanilla JS)

A **compass-ring sector widget**: an SVG/canvas circle with N at top (E right),
two draggable handles for the start and end bearings, the **open arc shaded**,
live numeric bearing readouts, and an **enable** checkbox. It reads
`get_track_sector` on load and calls `set_track_sector` on change (through the
dashboard's existing control-mapping → daemon tool path). The existing ADS-B
trackable list already reflects `isTrackable`, so it self-updates as the arc
changes — no separate list plumbing. (Drawing the arc + plane bearings onto a map
is the separate *mini-map* item, not this feature.)

## Data flow

`set_track_sector` (tool, from the dashboard) → `SectorStore.save` → next
`scan_aircraft` / tracking tick reads the sector → `enrichAircraft` sets
`inSector` → `isTrackable` gates the trackable list + `track_aircraft` + the
in-track stop.

## Error handling

- Corrupt/missing sector file → default disabled sector (never throws; matches
  `CalibrationStore.load`).
- `set_track_sector` with out-of-range bearings → tool error (Zod), nothing
  persisted.
- `start === end` with `enabled: true` → treat as a zero-width arc (nothing
  trackable). Documented; the widget should make it hard to reach but the daemon
  must not crash on it.

## Testing

**Unit (vitest):**
- `inArc`: non-wrapping arc, north-wrapping arc (`300→60`), both boundaries
  inclusive, `enabled: false` always true, zero-width arc.
- `enrichAircraft` sets `inSector` from the sector; disabled default leaves it
  `true`.
- `isTrackable` false when `inSector` false (other flags true).
- `scan_aircraft` drops out-of-arc planes under `only_trackable`, and
  `track_aircraft` refuses an out-of-arc hex.
- In-track: a bound target whose bearing crosses out of the arc stops the track
  (assert via the session/follower seam, mirroring the sun-guard test).
- `SectorStore` persist/load round-trip; corrupt-file → disabled default;
  survives independently of the calibration profile.
- `set_track_sector` / `get_track_sector` validation + round-trip.

**On-host manual (no automated E2E, same as the rest of the dashboard):** the
compass widget renders, dragging updates the arc + persists, out-of-arc planes
leave the trackable list, and an active track stops when its plane crosses the
boundary.

## Safety

Purely subtractive: the filter can only remove planes from trackable and stop a
track — it never commands motion, and manual control stays unrestricted (the
operator's explicit choice). Default-disabled means no behavior change until an
arc is set. The in-track stop reuses the trusted existing stop path.

## Files

- Create: `src/track/sector.ts`, `src/sector-store.ts`, sector-tools (new module
  or in `adsb-tools.ts`), `test/sector.test.ts`, `test/sector-store.test.ts`,
  dashboard compass widget (in `dashboard/public/`).
- Modify: `src/adsb/enrich.ts` (`inSector`), `src/adsb/types.ts`
  (`EnrichedAircraft.inSector`), `src/adsb-tools.ts` (`isTrackable`,
  `scanAircraft` sector param, tool registration), the tracking follower/session
  tick (in-track re-check), `src/config.ts` (sector file path), `src/server.ts`
  (load + thread the store), dashboard `index.html`/`app.js`/`style.css`.
