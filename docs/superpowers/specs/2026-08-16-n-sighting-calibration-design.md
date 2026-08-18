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
**`load()` and `addSighting()` re-solve from the stored sightings** and
overwrite both. This is one auto-re-solve path, so there is exactly one place a
calibration is produced. The current profile therefore re-solves to
`heading-only` with the camera forward, discarding the 43° value, on the first
daemon restart after this lands and before any new sighting is taken.

**The gravity anchor.** The fit needs `dBase` (base-down in the mount frame),
and `solve_calibration` currently derives it from a *live* gravity burst read —
several seconds of device I/O, refused if the rig moves during it. The store
has no device and `load()` runs at startup, so the auto-re-solve cannot do
that. Instead:

- A new top-level profile field `baseDown: [x,y,z]` records the gravity anchor
  that `solve_calibration` verified. The auto-re-solve uses `baseDown` when
  present, falling back to `imuMounting.dBase`.
- `imuMounting.dBase` is left untouched as `characterize_imu`'s own record, so
  the existing "live read disagrees with stored characterization by >2° ⇒ `R_s`
  is stale" check keeps its exact present meaning.
- If neither is available — no IMU characterization at all — there is no
  gravity anchor, the auto-re-solve is a no-op, and `solve_calibration`'s
  legacy no-IMU TRIAD path behaves exactly as today.

So `solve_calibration` remains the operation that *re-anchors the base* (live
read, movement check, writes `baseDown`); the automatic re-solve reuses that
verified anchor and only re-fits heading and `cHead` against the sightings.

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

export type FallbackReason = "under-determined" | "implausible-offset" | "inconsistent-residuals";

export interface CalibrationFit {
  R: Mat3;
  cHead: Vec3;
  stage: "heading-only" | "full";
  headingSigmaDeg: number;
  cHeadSigmaDeg: number | null;   // null while heading-only
  fallbackReason: FallbackReason | null; // null iff stage === "full"; WHY, not just THAT
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
full three-parameter fit is then attempted and accepted only if it passes
THREE independent guards:

- *Statistical* (`fallbackReason: "under-determined"`) — parameter 1σ from
  the covariance `(JᵀWJ)⁻¹`. If `cHeadSigmaDeg` exceeds `maxCHeadSigmaDeg`
  (default 3°), the camera-offset parameters are not determined by the data;
  they stay frozen and the result is `stage: "heading-only"`. Fewer than 2
  sightings (not enough to attempt a 3-parameter fit at all) reports this
  same reason — it is the same underlying cause, just caught earlier. A
  singular or otherwise unusable covariance leaves `cHeadSigmaDeg` at
  `+Infinity`, which exceeds any FINITE threshold and is therefore refused
  by the ordinary comparison; the guard deliberately does NOT test
  `!Number.isFinite`, because that would fire even when a caller passed
  `maxCHeadSigmaDeg: Infinity` to switch the guard off — which is exactly
  what the measuring fit below does, and re-freezing that fit reintroduces
  the blinding the relaxation exists to prevent. `NaN` is tested separately,
  since it has no ordering at all.
- *Physical* (`fallbackReason: "implausible-offset"`) — a `cHead` more than
  `maxCHeadOffAxisDeg` (default 15°) off forward is rejected regardless of
  covariance. Usually means a genuinely mis-mounted-camera assumption or
  under-spread geometry, but a single gross outlier can also drag an
  otherwise-good compromise fit past this bound on its own — still in the
  "the data is the problem" family, so the critical operator distinction
  (don't send them to collect more sightings) survives either way, but an
  operator-facing message built on this reason should not assume it always
  means "the camera is mounted at an odd angle".
- *Residual* (`fallbackReason: "inconsistent-residuals"`) — the converged
  fit's `rmsDeg` must not exceed `maxResidualRmsSigmaMultiple` (default 4×)
  times the sightings' own median `sigmaDeg`, floored at 1.5°. This exists
  because covariance is LOCAL CURVATURE at the converged point only: it
  reports how sharply pinned the parameters are *given that the model fits*,
  but cannot see whether the model actually fits. A wrong-basin convergence
  or genuinely inconsistent sightings can still produce tight, confident
  covariance alongside a residual far beyond what the sightings' own declared
  accuracy would predict — the first two guards are structurally blind to
  that failure mode, so this one closes it. Chosen permissively (4× is
  roughly a 99.9th-percentile bound for a couple of degrees of freedom) so
  ordinary noisy-but-correct data is never blocked.

The three are checked in the order **residual → statistical → physical**, and
the first to fail sets `fallbackReason`.

The residual check goes first, and that ordering is what makes a HEADING-ONLY
result residual-checked at all. Previously it ran last, so it was only ever
reached on the full-fit path: a result frozen by the statistical or physical
guard returned without its residuals ever being examined, and a heading-only
fit could be badly wrong while reporting a confident sigma — the exact failure
class this module exists to eliminate, surviving in the other branch. Measured
across 9300 cells, 1447 returned heading-only with `"under-determined"` while
their own residual RMS exceeded the threshold; the worst was a heading 16.197°
wrong reported alongside a `headingSigmaDeg` of 0.238°. This matters more than
it looks, because the deployed rig's calibrations are ALWAYS heading-only
(`cHead` stays locked until tilt spread is good) — so the unchecked branch was
the only branch that runs in the field, and `"under-determined"` carries the
operator instruction "add sightings with more spread", the opposite of what to
do when one sighting is simply bad.

It is deliberately the FULL fit's residuals that are tested, never the
heading-only fit's own, even though a heading-only result is what gets
reported. A heading-only fit cannot represent a real camera offset, so its
residuals are inflated by any genuine `cHead`: measured, a truth `cHead` 12°
off forward on clean sightings leaves the heading-only RMS at 12.00° while the
recovered heading is 0.230° from truth. Judging those residuals would report
`"inconsistent-residuals"` (delete a sighting) for data whose actual cure is
more tilt spread. Testing the FULL fit's residuals discriminates exactly right:
if three parameters CAN explain the sightings, nothing is wrong with the data
and the fallback is genuinely about not being able to TRUST `cHead`; if even
three parameters cannot, the sightings disagree with each other.
Under-determination makes the full fit's residuals SMALLER (it interpolates),
never larger, so putting this check first cannot steal a legitimately
under-determined case — confirmed by 0 false inconsistency trips across 420
clean no-outlier cells.

Reordering is purely diagnostic: across 9600 cells `stage`, `rejected`, `R` and
`cHead` are all bit-identical to the previous ordering; only `fallbackReason`
changes (633 cells — 380 `under-determined` → `inconsistent-residuals`, 253
`implausible-offset` → `inconsistent-residuals`, both strict refinements toward
the more specific and more actionable diagnosis).

The current field data reports `"under-determined"`, which is the intended
outcome.

**Option validation.** `FitOptions` fields are validated at the boundary
(`resolveOption`): each must be a non-negative number, with `+Infinity` legal
and meaning "this guard is switched off" (the measuring fit depends on that).
`NaN` and negatives throw. `NaN` in particular is not merely sloppy input — every
guard compares `measured > threshold`, which is false for every measured value
when the threshold is `NaN`, so an unvalidated `NaN` silently switched a guard
OFF rather than loosening it.

`fallbackReason` matters downstream, for a later task's operator-facing
`solve_calibration` fallback message: "under-determined" means add sightings
with more spread; the other two mean the DATA is the problem (a bad sighting
or a mis-mounted-camera assumption), and telling an operator with bad data to
collect more sightings sends them in the wrong direction.

**Outlier rejection.** Runs only with ≥4 sightings — below that there is no
majority to judge an outlier against, so every sighting is retained (this is
also a consequence of the reject-count arithmetic below, not just the
explicit `n>=4` check — see the cap paragraph).

Detection never measures against `result` (what is going to be REPORTED),
and never measures against a stale fit left over from a previous rejection.
On each rejection-loop iteration it calls `fitOnce` FRESH, on only the
sightings still accepted, with a separate, measurement-only `FitOptions`
in which the statistical and residual guards are relaxed to `Infinity`
unconditionally and the physical (off-axis) guard is relaxed **only where
there is enough data left for "relaxed" to still mean measuring** — never
the partially-gated fit that a first attempt at this used (residual guard
alone relaxed, the other two still live), and never a flat `Infinity` on
all three either. Three things must all hold, or detection blinds itself
or fools itself:
- *Statistical and residual guards relaxed unconditionally.* Whichever
  guard freezes the measuring fit to heading-only, every GOOD sighting
  inherits the true `cHead` offset as baseline residual, which inflates the
  leave-one-out threshold below enough to hide a real outlier.
- *Physical guard relaxed only where there is redundancy* — controlled by
  `MEASURE_UNGATED_MIN_SIGHTINGS` (5), tested against the LIVE sighting
  count each iteration. This guard has the same blinding power as the other
  two (an outlier alone can drag the measuring fit's `cHead` past the
  off-axis bound; measured, with only the residual guard relaxed, roughly
  6.5–16.5° of pan corruption at n=5..10 goes undetected for that reason).
  But it is also the only thing stopping a measuring fit from ABSORBING the
  outlier into a fabricated `cHead` when nothing else constrains it, which
  is what happens at n=4 — `MIN_SIGHTINGS_FOR_OUTLIERS` itself, where one
  sighting is a quarter of the data and three free parameters have eight
  residual components to satisfy.

  The two populations OVERLAP in off-axis magnitude, so no single number
  can separate them; only redundancy can. Measured over 279 n=4 cells (3
  `cHead` placements × truth offsets 2/4/8° × pan corruption 5–20°), a
  flatly ungated 3-parameter measuring fit lands at least 15.7° off-axis in
  EVERY cell, median 26°, even where the truth offset is 2° — it is chasing
  the outlier, not measuring the camera. On one such cell a 15° pan
  corruption pulled the outlier's own residual from 9.72° to 6.31° against a
  leave-one-out threshold of 6.82°, so it was KEPT and the reported heading
  came out 2.655° wrong. The same sweep at n≥5 tops out at 18.0°, but at
  truth offsets of 10–14° — which `maxCHeadOffAxisDeg: 15` explicitly
  permits — a legitimate measuring fit reaches 22.2°. So a flat 18° bound
  fixes n=4 and then misses 175 of 1116 real outliers at those larger truth
  offsets (heading error to 17.5°), and any bound generous enough for them
  (≥22°) lets n=4 keep over-fitting. Conditioning on the live count is 0
  misses in both populations. Note the reject cap keeps the live set at ≥5
  for every starting n≥5, so today this only engages at n=4; it is written
  against the live count so it stays correct if `MAX_REJECT_FRACTION` is
  ever raised. The sub-threshold branch is additionally capped by
  `MEASURE_SUB_THRESHOLD_MAX_OFF_AXIS_DEG` (15°, the module's own default
  physical bound) rather than simply inheriting the caller's
  `maxCHeadOffAxisDeg`: otherwise an operator loosening the REPORTED bound for
  an oddly-mounted camera would silently reopen the n=4 over-fitting
  (verified — at n=4 with a forward camera and a 15° pan fumble, defaults and
  20° reject correctly with 0.000° heading error while 30° and `Infinity`
  reject nothing and report a heading 2.655° wrong). A caller TIGHTENING the
  bound keeps their tighter value; tighter only freezes the measuring fit
  sooner, which is the safe direction.
- *Re-measure from a fresh fit after every rejection, not once up front.*
  While a real outlier is still accepted, it drags the measuring fit toward
  it, inflating every OTHER sighting's residual too — including good ones —
  so a good sighting can be rejected as collateral. Computing residuals once
  up front and only cascading the THRESHOLD (not the residuals) reproduces
  this: measured case, an 8-sighting fit with one 12°-corrupted sighting
  drops a second, entirely good sighting alongside it, the survivors fall
  out of the conditioning gate, and the recovered `cHead` collapses to
  `[0,1,0]` instead of being recovered exactly with only the real outlier
  removed.

Each iteration then rejects the single worst candidate (worst-first,
descending-error order, ties broken by index for determinism) against a
**leave-one-out** threshold: `max(3 × rms-of-the-OTHER-still-accepted-
sightings' freshly-measured residuals, 2°)`, never the candidate's own pooled
rms. A single fixed pooled threshold (`rms` computed once over every
sighting, including the outlier itself) is dead on arrival — with the rest
of the fit near-zero, `rms ≈ E/√n` for an outlier of error `E` among `n`
sightings, so detecting it needs `E > 3·E/√n ⟺ n > 9`: a lone outlier of
*any* magnitude is undetectable below 10 sightings, and every realistic
field profile here has 2–8. Excluding the candidate from its own threshold
removes this self-masking. Rejection also **cascades** — and now both halves
of it do: once the worst offender is rejected, the next iteration re-fits
and re-measures on the shrunken accepted set from scratch, so both the
RESIDUALS and the leave-one-out THRESHOLD reflect only the sightings still
under consideration. A second, milder outlier that would have been masked
alongside the first (in residual OR threshold) is now judged cleanly, and a
good sighting that only looked bad because a still-present outlier was
dragging the fit is re-measured without that drag before the next rejection
decision is made.

At most `floor(30% × n)` sightings may be rejected in one pass, capped at
`min(floor(30% × n), n − 3)` so at least 3 always remain accepted. That
second term is **not currently load-bearing**: `floor(0.3n) <= n − 3` for
every `n >= 3` (they tie exactly at `n=3` and `n=4`; the fraction is
strictly smaller for every `n >= 5`), so under today's 30% figure the
"≥3 accepted" floor never independently changes an outcome — it is kept as a
belt-and-braces bound for if the 30% figure is ever raised. If more
candidates clear their threshold than the cap allows, the worst offenders up
to the cap are dropped and the rest retained regardless of whether they also
looked bad. Rejected entries are reported, not deleted — the operator can see
which pass was fumbled.

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
