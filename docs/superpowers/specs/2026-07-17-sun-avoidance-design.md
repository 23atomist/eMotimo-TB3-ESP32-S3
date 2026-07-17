# Sun Avoidance — Design Spec

**Date:** 2026-07-17
**Status:** approved (brainstorm), pending spec review
**Layer:** safety supervisor over layer 3 (target tracking)

## The hazard

Seconds of direct sun on the camera sensor destroys it (~$2000, observed on this
rig). The tracker currently has **zero** sun awareness and will slew the boresight
through the sun to follow an aircraft. The sun is a **moving** hazard: it tracks
~15°/hour, and near solar noon its *azimuth* sweeps ~60°/hour. In Arizona in July
the sun reaches ~77.6° elevation at solar noon — only ~12.4° from zenith — so the
midday danger zone is a **cone around vertical**, not a compass direction.

Because the hazard moves, any response that merely **stops and holds** is wrong:
a rig halted 5° from the sun is burned in ~20 minutes; halted at a 20° cone edge,
~80 minutes. The correct response to a trip is to **actively park away from the
sun and stay there** — safe unattended.

## Non-negotiable principles

1. **Refusing to move is always survivable; moving on bad data is not.** Every
   ambiguous case fails to *stop*, never to a guessed slew.
2. **Guard whenever protection is possible.** Protect all motion when the inputs
   exist; when they don't, say so loudly rather than pretend.
3. **The cone is sized from a measurement, not a guess** — see Calibration-error
   measurement below.
4. **Pure math, one stateful owner.** Same split that made layers 2–3 reviewable.

## Inputs and their trust

| Input | Source | Trust |
|---|---|---|
| Sun az/el | NOAA algorithm from rig lat/lon + UTC | ~0.01°, effectively exact |
| Rig lat/lon | `CalibrationStore` | operator-entered |
| `R` (mount→ENU) | layer 2 TRIAD solve | **accuracy never hardware-validated** |
| UTC clock | host system | **unverifiable inside the daemon** |
| Boresight pan/tilt | rig telemetry (5 Hz) | up to 200 ms stale |

The two weak inputs — `R` and the clock — are exactly the two the **shadow test**
(below) validates simultaneously. A one-hour clock error shifts the sun ~15°
(larger than the cone) with *no symptom*; the only honest verification is the
shadow test plus `get_sun` reporting the assumed UTC for an eyeball check against
the real sky.

## Architecture

Two phases. Phase 1 is enough to run the calibration-error measurement today; it
depends only on `point_at_azel`, which layer 2 already ships.

### Phase 1 — solar position + inspection

- **`src/geo/sun.ts`** (pure). `sunAzEl(rig, tMs)` → `{ azDeg, elDeg }` via the
  NOAA solar-position algorithm (geometric mean longitude/anomaly → equation of
  centre → apparent longitude → declination + equation of time → hour angle →
  az/el), including atmospheric refraction near the horizon. `sunEnu(rig, tMs)` →
  unit `Vec3` `[cos el·sin az, cos el·cos az, sin el]`, matching the project's
  existing ENU frame and azimuth-from-north-clockwise convention (as used by
  `azElRange` and `velocityFromSpeedHeading`).
- **`get_sun` MCP tool** — reports sun az/el, the **assumed UTC**, the current
  boresight→sun separation (when calibrated), and the guard state + reason.
  Read-only; the pre-flight sanity check and the readout for the shadow test.

### Phase 2 — the guard

- **`src/track/sunguard.ts`** (pure). Three predicates:
  - separation check: `angleBetweenDeg(boresightEnu(R,pan,tilt), sunEnu) < cone`;
  - predictive check: same, on the **predicted** boresight over the stopping
    horizon `telemetryAge + tickPeriod + decelMs(rate)` (reusing the layer-3
    limit-guard horizon; self-annealing — negligible when slow, full ~750 ms /
    ~14° at 19 °/s). **Rate source:** `max(rate from telemetry position deltas,
    daemon commanded rate)`. Telemetry deltas are coarse at 5 Hz but are the only
    source that sees a **physical nunchuck** operator the daemon never commanded;
    the commanded rate covers the daemon's own motion. Taking the max is the
    conservative choice — it never under-estimates the horizon.
  - park-path planner: returns a safe park target or "no safe path".
- **`src/track/supervisor.ts`** — `SunSupervisor`, stateful, **one per rig,
  daemon-wide**, constructed in `main()` beside `TrackingSession` and threaded
  into `buildApp` (a per-connection supervisor would fight over the motors).
  Ticks on the injected `Scheduler`/`now` seams (deterministic tests, no wall
  clock). It is the **top motion authority**: on a trip it calls `session.stop()`
  and `device.clearJog()`, sets a sun-lockout the motion tools honor, then drives
  the park.

`sun.ts` and `sunguard.ts` are pure and exhaustively testable offline; the
supervisor holds all state and is the only thing that talks to the rig.

## The cone

One config value, `sunConeDeg`, sized from measurement:

```
cone = R_error + FOV/2 + tracking_error + 0.27° (sun radius) + margin
```

- `R_error` — from the shadow test; the dominant, previously-unknown term.
- `FOV/2` — half the lens field of view (~2.5° for a 400 mm full-frame lens).
- `tracking_error` — ~0.5° (simulation only).
- Stopping distance is handled **predictively**, not added to the cone.

Generous default until the shadow test provides `R_error`. The formula is recorded
so the cone is re-derivable on a lens change.

### Calibration-error measurement (the shadow test) — run today, camera OFF

1. `get_sun` → sun az/el + assumed UTC.
2. `point_at_azel(sunAz, sunEl)` with the **camera removed**.
3. Aim a straight edge / rod along the boresight and read its shadow: dead-on the
   sun, the shadow collapses to a point. Any offset **is** the combined `R`+clock
   error, in degrees.
4. A point-shadow validates **both** `R` and the clock (a 1-hour clock error would
   read as ~15° azimuth offset). Size the cone from the measured offset.

No camera is at risk — there is no camera on the rig during this test.

## Park logic

Convert the sun to pan/tilt via `enuToPanTilt(R, sunEnu)`. Park attitude:
**tilt down to a configured `parkTiltDeg`** (short of the mechanical stop), pan
chosen to avoid sweeping the lens through the sun.

**Frame constraint (this project's recurring bug seam):** `enuToPanTilt` returns
**user-frame** pan/tilt, and telemetry-derived `pan`/`tilt` are user-frame
(`applySign(stepsToDeg(steps), sign)`). All guard math — separation, crossing,
detour — is done in user frame. The device-frame conversion happens exactly once,
where the park drives the actuator (via the same `moveToUserAngle` path the
pointing tools use), never inside the guard. A sign applied twice or dropped here
would aim the "safe" park *at* the sun.

The direct tilt-down sweep is dangerous only when it **crosses** the sun's
elevation: `parkTilt < sunTilt < currentTilt`. This can arise only when the sun is
**below** the boresight — a **low** sun. The required pan detour is
`≈ cone / cos(sunTilt)`, which diverges near zenith — but near zenith the sun is
*above* the boresight, so the crossing case cannot occur. **The degeneracy and the
danger never co-occur**; for a low sun `cos(sunTilt) ≈ 1`, so a pan detour of
roughly one cone-width clears it.

**Why tilt-down and not azimuth-away:** the park destination must be safe *even if
`R` is badly wrong*, since `R` is the very input the guard can't fully trust.
"Tilt to a low angle" is a **mount-frame** fact — the lens points groundward
because the rig is bolted upright, independent of any calibration. "180° from the
sun's azimuth" depends entirely on `R` being correct. So the *destination* is
R-independent; only the *path check* uses `R` (and a wrong `R` there fails toward
the pan-detour or the hard fault, not toward the sun). In Arizona daytime the sun
is always well above `parkTiltDeg`, so a groundward park always increases
separation at the destination.

Park decision:
1. **Direct tilt-down** if the sweep's minimum separation from the sun stays
   outside the cone.
2. Otherwise **pan away** from the sun's azimuth far enough to clear, then tilt
   down.
3. **No safe path** (pan limits block the detour) → **hard fault: stop, do NOT
   move, alarm.** A park that cannot find a safe route must never pick the
   least-bad sweep through the sun.

## Safety envelope

**Active when** calibrated (rig location + `R`) **and** sun above horizon.
Otherwise `disabled`, reporting which: `uncalibrated` | `sun_below_horizon` |
`manually_disabled`.

**Guard scope:** when active, guard **all** motion — tracking, `point_at`,
`point_at_azel`, `goto_angle`, `jog` — via the sun-lockout, same shape as the
existing `"tracking active; stop_tracking first"` guard, so a client streaming a
jog vector cannot out-vote it. When not active (uncalibrated), allow only manual
jog/goto and **report plainly that the guard is OFF** — this is what lets the
uncalibrated landmark-sighting pass happen without an override tool that would
become habit.

**Fail-closed rules:**
- **Stale telemetry → stop motion, `fault`, do NOT park.** A park path needs a
  known boresight; a park from a stale position could sweep anywhere.
- **Sun computation fails (bad lat/lon) → stop, `fault`.**
- **`set_home` invalidates `R`.** It re-zeroes the step origin, but `R` was solved
  against the old origin, so `boresightEnu(R, pan, tilt)` — and the guard — would
  be silently wrong. `set_home` must clear `orientation`, dropping the guard to
  `disabled(uncalibrated)` and forcing re-calibration. (This is the Task-7
  "valid-but-stale `R`" issue, promoted from a tracking-accuracy bug to a
  burn-the-camera bug.)

**Explicitly NOT protected against** (stated so the guard doesn't oversell):
- **A stopped daemon.** The supervisor runs only while the daemon runs. Procedural
  mitigation: park down before ending a session. Documented, not enforced.
- **The physical nunchuck.** The supervisor sees that motion via telemetry and
  parks against it, but cannot gate the rig's own joystick against a human who
  keeps pushing.
- **Clouds.** Not modeled (conservative — it guards the sun's true position).

**Existing layers remain underneath, unchanged:** Device TTL watchdog, firmware
750 ms deadman, `/api/stop` joystick latch, soft limits, tracking arbitration. The
supervisor sits above them as the authority that can stop the session.

## Tool surface (2 new → 21 total)

- **`get_sun`** — sun az/el, assumed UTC, boresight separation, guard state+reason.
  Read-only.
- **`get_sun_guard` / `set_sun_guard`** — inspect state; enable/disable and set
  `sunConeDeg`, `parkTiltDeg`. **Disable is explicit and reported in every
  status** (for the uncalibrated calibration pass; not a habitual override).

No tool commands a park — the supervisor owns that. A manual "park now" is just
`point_at_azel` to a safe attitude.

## State machine

```
disabled ──(calibrated & sun up)──────────────> monitoring
  disabled reason: uncalibrated | sun_below_horizon | manually_disabled

monitoring ──(predicted boresight enters cone)─> parking
  on trip, regardless of cause: session.stop() + device.clearJog(), set lockout
monitoring ──(telemetry stale | sun calc fails)> fault   [stop, do NOT move]

parking ──(safe path found)──> drive park ──(arrived)──> parked
parking ──(no safe path)─────────────────────> fault     [stop, do NOT move, alarm]

parked  stays parked; lockout holds until the sun leaves the cone AND a human
        re-enables. (Auto-unlock alone would resume into a still-closing sun.)
```

**Authority boundary:** the supervisor is strictly above `TrackingSession`. It
never micromanages tracking — on a trip it stops the session outright and takes
the motors. No shared mutable state; they meet only through `session.stop()` and
the lockout flag, keeping both independently testable.

## Config (new keys)

- `sunConeDeg` — exclusion half-angle. Generous default (~25°) until the shadow
  test; then `R_error + FOV/2 + tracking_error + 0.27° + margin`.
- `parkTiltDeg` — park tilt, short of the mechanical stop (e.g. −20°, clearing the
  mount).
- `sunGuardTickHz` — supervisor tick rate (default 10, matching the servo).
- `sunGuardEnabled` — master enable (default true).

Env overrides via the existing `num()`/string pattern in `config.ts`.

## Testing

- **`sun.ts` — against published truth.** Assert `sunAzEl` vs NOAA/USNO reference
  values (arcminute tolerance), including tomorrow's Phoenix fixture (solar-noon
  el ≈ 77.6°, az ≈ 175°). Highest-confidence test in the project — external
  oracle, no mock, no hardware.
- **`sunguard.ts` — table-driven, exhaustive.** In/out of cone; predicted-crossing
  trips while the current boresight is still clear; park decisions (direct-down
  clear, pan-detour for a low crossing sun, hard-fault when no safe path); an
  explicit test that danger and the zenith degeneracy never co-occur.
- **`supervisor.ts` — via injected `Scheduler`/`now`**, no wall clock: sun→cone
  trip stops the session + sets lockout + parks; **stale telemetry → fault, no
  motion**; `set_home` → `R` cleared → `disabled(uncalibrated)`; a jog streamed
  through a trip → lockout holds (mirrors the `/api/stop` latch test); no-safe-path
  → fault, no motion.
- **`scripts/sun-guard-probe.mjs`** — bench tool for today: reads `get_sun` and
  scripts the shadow test (point at the sun, camera off, report the offset that
  sizes the cone).

End-to-end behavior against a real closing sun is not unit-testable (same as the
tracking sim); the pure layers are exhaustively covered, the integration is
covered by the shadow test and the bench probe.

## Staging for today

Phase 1 (`sun.ts` + `get_sun`) unblocks the shadow test immediately — it needs
only `point_at_azel`. Run the shadow test with the camera off to measure `R`+clock
error and size the cone. Then Phase 2 (guard + supervisor). Bench-verify the
supervisor parks against a manufactured trip (feed a near-sun attitude) before
trusting it with a lens.
