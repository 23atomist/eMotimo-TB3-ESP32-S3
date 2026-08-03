# Re-zero Frame Convention — Design

**Date:** 2026-08-03
**Status:** Approved for planning
**Supersedes the affected parts of:** `2026-08-02-reboot-rezero-design.md`
**Blocks:** merge of `feat/reboot-rezero`

## Problem

The reboot re-zero feature is correct on its first use per calibration and
degrades on every use after that. All 1238 tests pass, both typechecks are
clean, and all seven implementation tasks reviewed clean individually — because
every re-zero test in the suite exercises exactly one origin generation.

The two offsets are measured against **different reference frames** and then
consumed as if they shared one:

- `solveTiltOffset` compares against `imuMounting.dBase`, which `applyRezero`
  never refreshes. Its result is therefore **cumulative** — the total offset
  since `characterize_imu`.
- `solvePanOffset` is passed the live `orientation`, which `applyRezero` *does*
  overwrite. Its result is therefore **incremental** — the offset since the
  last re-zero.

Both are then applied as increments: `shiftAxis("tilt", -Δtilt)` onto
already-shifted edges, and `applyTiltOffset(cHead, Δtilt)` onto an already-folded
`cHead`.

Measured on a scratch copy using the rig's real `R_S` and `dBase`:

| sequence | result | correct |
|---|---|---|
| cycle 1 | pointing error 0.000° | ✓ |
| cycle 2 | `applied: true`, residual 2.28° (**under** the 3° reject threshold), pointing error 2.01° | 0° |
| cycle 3 | `applied: false`, blames the tripod; tilt limits drifted 26° | — |
| two reboots before one re-zero | tilt window slides by the *first* Δtilt and stays wrong | — |

The last row is the dangerous one. With the 23.33° offset measured on the rig on
2026-08-02, the guard would permit driving 23° past the taught floor — the
mechanical-stop incident this feature exists to prevent, reintroduced by it. And
"power-cycle, then OTA flash before re-zeroing" is ordinary: the flash is itself
a reboot.

Cycle 2 is the insidious one: `applied: true`, residual under threshold, no
error anywhere, and a silently wrong calibration *and* silently wrong limits.

**Root cause is the original spec.** It only ever described a single reboot
cycle and never stated what the second does.

## Two fixes that do not work

Both were implemented and measured before writing this.

**Re-stamping `dBase` in `applyRezero`** fixes cycle 2 exactly (pointing error
2.010° → 0.003°) but breaks cycle 3: the `onReboot` tilt residual rises to 4.43°,
past `MAX_TILT_RESIDUAL_DEG`. The pan/tilt decoupling the whole design rests on
holds *only because* `dBase` lies ~1.45° off the pan axis **in the original
frame**; re-stamping at a shifted origin tips it by Δtilt and the independence
collapses. `dBase` must stay exactly where `characterize_imu` put it.

**Cumulative bookkeeping bolted onto the current shape** (tracking how much
Δtilt has already been applied) fixes the limits and cycle 2, but cycle 3 still
fails at residual 25.4°, because `rezeroFromEnu`'s pass 2 corrects `cHead` by a
cumulative Δtilt while pass 3 feeds an incremental Δpan into a cumulative-frame
tilt solve.

The problem is not a missing adjustment. It is that no single frame convention
is stated anywhere, so each solve site picked one independently.

## Design: one baseline, two cumulative offsets

**State the convention once and derive everything from it.**

Persist an immutable **baseline** — the calibration exactly as solved — plus the
**cumulative origin offset** from that baseline's step origin to the current one:

```ts
baseline: { R0: Mat3, cHead0: Vec3 }          // written only by a real solve
originOffset: { panDeg: number, tiltDeg: number }   // zero at solve time
```

The live values are **derived, never stored**:

```
R_live     = applyPanOffset(R0, originOffset.panDeg, geoPanSign)
cHead_live = applyTiltOffset(cHead0, originOffset.tiltDeg)
```

`getOrientation()` and `getCHead()` return these, so every existing consumer is
unchanged and none of them learns about the baseline.

**Every solve runs against the baseline**, which makes both offsets cumulative
and every re-zero idempotent:

- `solveTiltOffset(rS, dBase, reportedPan, reportedTilt, gravity, gp)` — already
  compares against the untouched `dBase`, so it already returns the cumulative
  Δtilt. **No change.**
- `solvePanOffset` must be passed **`R0`**, not the live orientation, together
  with `applyTiltOffset(cHead0, ΔtiltTotal)`. It then returns the cumulative
  Δpan.

Applying a re-zero becomes an **assignment, not an accumulation**:

```ts
originOffset = { panDeg: ΔpanTotal, tiltDeg: ΔtiltTotal }
```

Run it N times with the same inputs and the state is identical. N reboots and N
re-zeros behave exactly like one — which is the property the current code lacks
and no amount of single-cycle testing could have revealed.

**Taught limits** stay in the live frame and shift by the **delta** between the
previously-applied offset and the new one, so a re-teach performed in the current
frame keeps its meaning:

```ts
limits.shiftAxis("tilt", -(newOffset.tiltDeg - appliedOffset.tiltDeg))
limits.shiftAxis("pan",  -(newOffset.panDeg  - appliedOffset.panDeg))
```

`appliedOffset` is a new optional field on `limits.json` — deliberately stored
with the limits rather than the calibration, because it describes what has
already been done *to those edges*. Storing it there also makes it survive a
daemon restart, which the current in-memory pan-limit stash does not; if it
proves sufficient on its own, the `WeakMap` stash becomes redundant and should
be removed rather than left as a second, weaker mechanism for the same job.

### Migration

A profile written before this change has `orientation`/`cHead` but no
`baseline`. On load, if `baseline` is absent and `orientation` is present, adopt
the stored values as the baseline with a zero `originOffset`. That is exactly
correct for a freshly-solved calibration and no worse than today's behaviour for
any other. No operator action, no re-solve.

## Also in scope

Four findings from the same review. All are safety-relevant and all touch code
this change already rewrites.

**I2 — `needsRezero` survives a full recalibration.** Nothing clears it except
`applyRezero`. `set_home` calls `invalidateCalibration()`, which clears
orientation, `cHead` and sightings but leaves `needsRezero`, `bootId` and
`landmark`. An operator told "full recalibration required" who then does exactly
that still gets refused, with a message that is now false, pointing at a landmark
recorded under the calibration they just discarded — following it applies a
re-zero on top of a good fresh solve. **Fix:** `invalidateCalibration()` and any
real solve (`setOrientation`, `setGravityCalibration`) clear `needsRezero`,
`bootId`, `landmark` and reset `originOffset` to zero, and write the new baseline.

**I3 — `onReboot` pairs a fresh HTTP gravity read with a possibly-frozen
WebSocket posture cache.** `connected`, `lastUpdateMs` and `moving` are all
discarded. Measured with a stale posture and a true gravity read at a real 23.33°
offset: `applied: true`, `Δtilt −6.75e−17`, `residual 0.00°`, limits shifted by
nothing — and the poll logs it as success. That is strictly worse than the
pre-feature behaviour, which at least did not claim to have handled it.
**Fix:** adopt the before/after posture + `moving` guard that `geo-tools.ts` and
`imu-tools.ts` already apply to every gravity read; refuse and leave
`needsRezero` set when telemetry is stale or the rig moved.

**I4 — in-flight automated motion is never gated.** `rezeroGuard` is called only
at four *tool entry points*. `TrackingSession.tick()` never consults it, and its
deadman is refreshed by the ADS-B poll independently of the device — so a session
started *before* the reboot survives the outage and resumes commanding jog
vectors when the WebSocket reconnects, on the stale calibration, with pan limits
cleared. **Fix:** `TrackingSession.tick()` consults the guard and parks.
`SunSupervisor` is deliberately **not** gated — it computes both its cone test
and its park plan from the orientation, so gating it removes the guard entirely;
instead `get_rezero_status` must report that sun protection is degraded while
`needsRezero` is set, and the tool description must say so.

**I5 — the re-zero tools lack the preconditions seven other
calibration-mutating tools carry.** `set_landmark`, `rezero_from_landmark` and
`rezero_from_aircraft` check neither `session.isActive()`, nor
`supervisor.isSunLocked()`, nor `moving`. **Fix:** add the established
`"tracking active; stop_tracking first"` guard, and read posture before and after
the gravity burst as I3 requires.

## Explicitly out of scope

The deferred minors triaged as "defer" by the final review: the CJS `require` in
`boot-watch.test.ts`, the gating tests that infer from error text, file and
function length, and the absent shutdown path. None interacts with the frame
convention.

## Testing

**The acceptance criterion is a multi-cycle test, because that is the entire
blind spot.** Every existing re-zero test builds a fresh store and performs one
`onReboot` and at most one `rezeroFromEnu`.

1. **Three-cycle loop against one store.** For each cycle: inject a distinct
   (Δpan, Δtilt), run `onReboot`, run `rezeroFromEnu`, then assert pointing error
   for an independent posture is < 0.1° **and** both limit edges match their
   analytically-correct values. This fails on the current branch at cycle 2 and is
   the test that would have caught this during Task 5.
2. **Idempotence.** Running `rezeroFromEnu` twice with identical inputs leaves
   the profile byte-identical after the second call.
3. **Two reboots before one re-zero.** Assert the tilt limits reflect the *total*
   offset, not the first one — the row that reintroduces the mechanical-stop
   incident.
4. **Migration.** A profile with `orientation`/`cHead` and no `baseline` loads,
   adopts them as the baseline with zero offset, and points identically to before.
5. **I2:** after `invalidateCalibration()`, `needsRezero` is false, `landmark` is
   gone, and the gated tools return their ordinary not-calibrated error rather
   than the re-zero message.
6. **I3:** a stale/disconnected posture makes `onReboot` refuse, leave the limits
   untouched, and keep `needsRezero` set — asserting it does **not** report a
   0.00° success.
7. **I4:** a session active across a simulated reboot parks and issues no further
   device commands.

## Operating constraints until this lands

`feat/reboot-rezero` must not be deployed. The rig's existing manual recovery
path is unaffected and remains correct.
