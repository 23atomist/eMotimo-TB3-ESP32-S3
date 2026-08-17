# N-Sighting Calibration, Range Filter, and Nearest-First Tracking

Date: 2026-08-16
Status: approved for implementation

## Problem

Field session, 2026-08-16. Tracking a target is wildly off at the start of a
pass: the pointing error sweeps from roughly +12° through 0 to −12° while the
azimuth stays visibly correct. It converges for a few seconds near the
elevation of the first calibration sighting, then diverges again. Close
aircraft — the interesting ones — never become trackable at all, and the
aircraft list churns constantly.

### Root cause

`solveCalibrationWithGravity` fits three unknowns — heading plus the two
degrees of freedom of the camera boresight `cHead` — to exactly two sightings.
`cHead` is not identifiable from two sightings. The solver absorbs sub-degree
sighting noise into a large, physically impossible camera offset.

The live profile (`~/.tb3-mcp/calibration.json`, solved 2026-08-16T23:20Z)
holds:

    cHead = [0.6835, 0.7269, 0.0666]   →  43.4° off forward

The two sightings behind it:

| label   | az     | el     | pan    | tilt  |
|---------|--------|--------|--------|-------|
| SWA509  | 337.8° | 10.0°  | +23.9  | 10.2  |
| AAL2892 | 26.4°  | 16.3°  | −22.6  | 18.5  |

Tilt spread 8.25°, elevation spread 6.29° — a ratio of 0.763. For a
forward-facing camera on a base leaning 1.2°, that ratio must be ≈1.00. The
only way a two-point exact solve can explain 0.763 is to swing the boresight
sideways until `cos(43.4°) = 0.727`. The missing ~1° is sighting noise: the
operator centres a moving aircraft on a video feed with ~300 ms of latency.

The solve amplifies that noise about 80:1. Re-running it with the sighting
tilts perturbed by ±0.5°:

    dtilt=(+0.5, −0.5):  cHead  1.5° off-axis
    dtilt=(  0 ,   0  ):  cHead 28.6° off-axis
    dtilt=(−0.5, +0.5):  cHead 38.7° off-axis

### Observed consequences

Commanded tilt against true target elevation under the stored calibration
(taught `tiltMax` = 53.6°):

| true el | commanded tilt | |
|---------|----------------|---|
| 10°     | 8.2 – 10.2     | ok |
| 20°     | 22.4 – 24.4    | ok |
| 30°     | 37.6 – 39.9    | ok |
| 35°     | 46.2 – 48.7    | ok |
| 40°     | 56.0 – 59.2    | **blocked** |
| 45°     | 69.5 – 76.0    | **blocked** |
| 50°+    | 84.8 (saturated) | **blocked** |

This accounts for every reported symptom:

- The elevation error crosses zero at the sightings' elevation (~10–16°) and
  grows with opposite sign either side of it — the +12 → 0 → −12 sweep, and the
  brief convergence "around the mark of sighting 1".
- Azimuth stays good because the heading error and the sideways `cHead` error
  very nearly cancel — "the direction is fine".
- Everything above ~37° true elevation is unreachable, so close, high-elevation
  aircraft never become trackable.

`headingResidualDeg` was 1.15° at the time — apparently healthy. It cannot
detect this failure: overfitting *lowers* the residual. A quality metric that
improves as the answer gets worse is the wrong metric.

A heading-only fit with `cHead` forced forward gives 1.2°/2.0° residuals at the
two sightings but stays within ~2° across the whole sky, and maps tilt to
elevation 1:1 so the full taught tilt range is usable again.

### Secondary defects found during diagnosis

1. **The list promises what the tracker refuses.** `enrichAircraft` computes
   `reachable` against `cfg.panMin/panMax/tiltMin/tiltMax` (±180/±90), while
   `TrackingSession` and `SunSupervisor` use `effectiveLimits(config,
   taughtEdges)` — currently pan [−79.3, 57.7], tilt [−0.4, 53.6]. Rows offer
   `[Track]`; the session then sits in `waiting / below_tilt_limit`.

2. **No range filter.** `scan_aircraft` is bounded only by `adsbMaxRangeKm`
   (100 km), so distant traffic crowds the list.

3. **Auto-tracker ignores range.** `src/agent/llm.ts`'s prompt ranks by
   interestingness — emergencies, military, heavies, rare types — and says
   nothing about proximity. `range_km` is supplied and ignored.

## Decisions

Confirmed with the operator before design:

- Sightings are **semi-permanent**: they accumulate across sessions within one
  physical setup, need an explicit "the rig moved, start over" action, and a
  staleness display. No auto-expiry.
- Calibration is **progressive**: heading-only from one sighting, camera offset
  unlocking automatically once the data supports it.
- Bad sightings are **auto-rejected as outliers and also manually deletable**,
  with rejected ones staying visible.
- Range filter is a **config default plus a UI slider**, feeding the list and
  the auto-tracker.
- Auto-tracker becomes **nearest-first, as a hard rule**.

### Solver approach

Chosen: **staged three-parameter weighted least squares.** The unknowns are
exactly heading `h` and the camera direction `(ca, ce)` in the head frame;
gravity fixes level and roll. Conditioning then falls out of the
normal-equations matrix rather than being a hand-rolled heuristic, which
matters because the failure being fixed is precisely a conditioning failure
that the existing proxy metric could not see.

Rejected: alternating Wahba/`cHead` fixpoint — `wahbaRotation` returns a free
rotation not constrained to the `Rz(h)·R0` family, diluting the gravity fix and
requiring re-projection each iteration, and it exposes no conditioning measure.
Rejected: averaging many two-sighting closed-form solves — every pair inherits
the same ill-conditioning, so averaging produces a confidently wrong answer.

## Design

### 1. Sighting store and lifecycle

`src/calibration.ts`. Remove `.max(2)` from `ProfileSchema.sightings` and the
`.slice(-2)` in `addSighting`; cap at 200 to bound file size and solve time.

`SightingSchema` gains three fields, all optional so existing profiles parse:

```ts
id: string        // stable handle for delete-from-dashboard
atIso: string     // when taken — drives the staleness display
sigmaDeg: number  // expected angular error of THIS sighting
```

`sigmaDeg` is computed once at sighting time by `sight_aircraft`, which already
has slant range, ground speed and ADS-B report age — the three quantities that
set how much a sighting can be trusted. Storing the derived value is preferred
to storing three raw inputs and re-deriving at solve time.

New methods:

- `removeSighting(id: string): boolean`
- `clearSightings(): void` — the "rig moved" action

`invalidateCalibration()` and `setRigLocation()` already clear sightings and are
unchanged. There is deliberately **no auto-expiry**: a sighting taken from a rig
that has not moved is still valid data.

**Behaviour change.** `addSighting` currently blanks a solved orientation. That
is the documented 2026-07-29 field failure — taking a sighting killed every
`[Track]` button — and it gets worse as sightings accumulate. Replaced with
**auto re-solve on every add**. The fit is sub-millisecond, so there is no
stale-solve state to manage, and the provisional/cleared-orientation special
casing goes away.

**Migration.** Legacy profiles (2 sightings, no `id`/`atIso`/`sigmaDeg`) parse
unchanged. Missing ids are backfilled on load, missing `atIso` stays null and
displays as "age unknown", and missing `sigmaDeg` falls back to a constant
`DEFAULT_SIGHTING_SIGMA_DEG = 1.0`.

The stored `R`/`cHead` are a cache of the fit, not independent state, so
**`load()` re-solves from the stored sightings whenever any exist** and
overwrites both. This is the same auto-re-solve path `addSighting` uses, so
there is exactly one place a calibration is produced. The current profile
therefore re-solves to `heading-only` with the camera forward, discarding the
43° value, on the first daemon restart after this lands and before any new
sighting is taken.

A profile with zero sightings but a stored orientation — the `set_north_zero`
provisional seed — is left exactly as-is: there is nothing to re-solve from,
and `orientationProvisional` continues to mean what it means today.

### 2. The fit

New pure module `src/geo/calibration-fit.ts`, replacing
`solveCalibrationWithGravity` (which has exactly one caller,
`geo-tools.ts`'s `solve_calibration`).

```ts
export interface FitSighting {
  panDeg: number;
  tiltDeg: number;
  enuUnit: Vec3;      // truth direction, rig → target
  sigmaDeg: number;   // 1σ expected angular error
}

export interface CalibrationFit {
  R: Mat3;
  cHead: Vec3;
  stage: "heading-only" | "full";
  headingSigmaDeg: number;
  cHeadSigmaDeg: number | null;   // null while heading-only
  residualsDeg: number[];         // per input sighting, input order
  rejected: boolean[];            // outliers dropped from the fit
  rmsDeg: number;                 // over accepted sightings
  usedCount: number;
  baseLeanDeg: number;
  tiltSpreadDeg: number;
}

export function fitCalibration(
  dBase: Vec3,
  sightings: FitSighting[],
  geoPanSign: number,
  opts?: FitOptions,
): CalibrationFit;
```

Model: `R0 = rotAlign(−dBase, +Z)` as today. Parameters `p = [h, ca, ce]` with
`cHead = normalize([sin(ca)cos(ce), cos(ca)cos(ce), sin(ce)])`. Predicted
direction for sighting *i* is `Rz(h)·R0·M(gp·panᵢ, tiltᵢ)·cHead`. Two
tangent-plane residual components per sighting, weighted `1/σᵢ²`, solved by
Gauss-Newton with a numerical Jacobian, seeded from the heading-only solution
and capped at a fixed iteration count.

**Staging and the conditioning gate.** Heading-only is fitted first (one
parameter, `cHead` frozen forward) and always succeeds with ≥1 sighting. The
full three-parameter fit is then attempted and accepted only if it passes two
independent guards:

- *Statistical* — parameter 1σ from the covariance `(JᵀWJ)⁻¹`. If
  `cHeadSigmaDeg` exceeds `maxCHeadSigmaDeg` (default 3°), the camera-offset
  parameters are not determined by the data; they stay frozen and the result is
  `stage: "heading-only"`.
- *Physical* — a `cHead` more than `maxCHeadOffAxisDeg` (default 15°) off
  forward is rejected regardless of covariance.

The current field data fails both, which is the intended outcome.

**Outlier rejection.** Runs only with ≥4 sightings — below that there is no
majority to judge an outlier against, so every sighting is retained. Fit,
compute per-sighting angular residuals, drop any above `max(3 × rms, 2°)`,
refit once. At most 30% of sightings may be rejected in one pass, and never
below 3 accepted; if the threshold would exceed that, the worst offenders up to
the cap are dropped and the rest retained. Rejected entries are reported, not
deleted — the operator can see which pass was fumbled.

`headingResidualDeg` is retired.

### 3. Consumers

`getCHead()` has six call sites across five files (`sun-tools`, `adsb-tools`,
`geo-tools` ×2, `track/session`, `track/supervisor`) and every one already
defaults to `[0,1,0]`, so none require changes.

**Reachability alignment.** `enrichAircraft` gains a trailing defaulted
`limits` parameter (matching that file's existing convention for `sector` and
`cHead`), and `scanAircraft` passes the effective taught-or-config limits so
`reachable` means what the tracker means.

**Status surface.** `get_calibration` reports `stage`, `headingSigmaDeg`,
`cHeadSigmaDeg`, `tiltSpreadDeg`, `usedCount`, `rmsDeg`, and a per-sighting
array of `{id, label, atIso, residualDeg, rejected}` in place of
`heading_residual_deg`. `dashboard/public/step-gate.js` is updated to read the
new shape.

**Dashboard.** A sightings panel listing each sighting with age, residual and a
rejected badge, a per-row delete button, and a "clear all — rig moved" control.

### 4. Range filter

The slider must also govern the auto-tracker, which runs in a separate process
and cannot observe browser state. So this is daemon-side state, following the
existing `sector-store.ts` pattern precisely.

New `src/range-store.ts` persisted to `~/.tb3-mcp/range.json`, with
`get_track_range` / `set_track_range` MCP tools and a config default
`trackMaxRangeKm: 25`.

It applies to **trackability**, so the list, the `[Track]` buttons and the agent
all agree. The map continues to show all traffic, with a range ring drawn at the
current setting — hiding traffic from a situational-awareness map would be a
regression.

### 5. Nearest-first auto-tracker

`src/agent/loop.ts` drops the LLM call. `scanAircraft` already returns
range-capped results sorted nearest-first, so selection is `trackable[0]`.

`decideAction`'s minimum-dwell guard is retained, plus a **switch margin**: hold
the current target unless it stops being trackable or a candidate is closer by
more than 20%. Without the margin, two aircraft at 12.0 and 12.1 km would
alternate every tick.

`src/agent/llm.ts` becomes dead code and is deleted along with the `llmUrl` and
`llmModel` config keys. Zod strips unknown keys, so those already present in the
deployed `config.json` remain harmless.

### 6. Out of scope

The host's systemd unit sets `TB3_MAX_AIM_OFFSET_DEG=35` against a
`trackReacquireDeg` of 10. A converged 35° offset reads as a lost target and
drives continuous reacquire. It should return to ~5 once this lands, but that
unit file carries uncommitted host-local edits and is the operator's to change.

## Testing

- **Fit, synthetic.** Generate N sightings from a known `(R, cHead)`, add
  realistic noise, assert recovery within tolerance.
- **Fit, gate.** Two low-elevation sightings must yield `heading-only`; six
  well-spread sightings must reach `full` and recover `cHead`.
- **Fit, field regression.** Built from the two real sightings above: must
  produce `stage: "heading-only"`, and must never again produce a `cHead` tens
  of degrees off forward.
- **Fit, outliers.** One gross outlier is rejected and the fit recovers.
- **Store.** N sightings persist; `removeSighting` by id; `clearSightings`;
  legacy two-sighting profile migrates with backfilled ids.
- **Enrich.** `reachable` honours taught limits, not the config ceiling.
- **Range store.** Mirrors the existing `sector-store` tests; range bounds
  trackability.
- **Agent loop.** Nearest-first selection, dwell honoured, switch margin
  prevents ping-pong.

## Success criteria

1. The stored profile re-solves to `heading-only` on first load, discarding the
   43° `cHead`.
2. Commanded tilt tracks true elevation 1:1 within ~2°, restoring the full
   taught tilt range and making high-elevation aircraft reachable.
3. Pointing error stays within a few degrees across a whole pass rather than
   sweeping ±12°.
4. Adding well-spread sightings unlocks `stage: "full"` and tightens the fit.
5. The aircraft list is bounded by the range setting; the auto-tracker selects
   the nearest trackable target.
