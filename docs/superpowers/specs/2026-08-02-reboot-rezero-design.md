# Reboot Re-zero — Design

**Date:** 2026-08-02
**Status:** Approved for planning

## Problem

The rig's firmware does not persist step position. `current_steps` starts at zero
wherever the head physically sits at boot — there is no homing routine and no
absolute encoder. Any power cycle, and any OTA flash (which reboots the ESP32),
silently moves the origin.

Two persisted artifacts are expressed relative to that origin:

- `~/.tb3-mcp/limits.json` — operator-taught travel limits, in degrees.
- `~/.tb3-mcp/calibration.json` — orientation and `cHead`, which map rig
  pan/tilt to ENU.

Nothing detects the change. On 2026-08-02 this drove tilt into its mechanical
stop: the guard was enforcing the previous origin's taught limits against the new
zero. The measured IMU disagreement across that reboot was 23.33°, against 1.20°
before it. Tracking pointed far enough off that targets never entered frame.

Recovery today means re-teaching all four limit edges, re-running
`characterize_imu`, re-establishing north, taking two fresh sightings, and
re-solving — roughly an evening, after every power cycle.

## Key insight

A power cycle does not invalidate the calibration. It perturbs exactly two
scalars.

The tripod, the camera on the head, and the IMU on the mount are all unmoved.
Only the step origin changed. In the pointing model:

```
boresight_ENU = R · Rz(pan) · Rx(tilt) · cHead
```

a pan-origin shift is `Rz(pan+Δpan) = Rz(pan)·Rz(Δpan)`, which folds into
`R' = R·Rz(Δpan)`. A tilt-origin shift is `Rx(tilt+Δtilt) = Rx(tilt)·Rx(Δtilt)`,
which folds into `cHead' = Rx(Δtilt)·cHead`.

So the whole problem is **Δpan and Δtilt**. Everything else already solved stays
valid, including `rS`, `dBase`, and the tripod-relative orientation.

`Rz`/`Rx` above are illustrative. The authoritative factorisation is
`mountHeadRotation(panDeg, tiltDeg)` in `src/geo/boresight.ts`, called as
`matMul(R, mountHeadRotation(geoPanSign * panDeg, tiltDeg))`. The implementer must
read that function and derive the fold-in from it rather than assuming the axis
order here — including where `geoPanSign` multiplies, since a sign error produces
a mirrored mapping rather than an offset and is easy to miss.

**The two unknowns decouple, and gravity supplies one of them.** `dBase` lies
almost exactly along the pan axis (measured: `[-0.008, -0.024, -0.9997]`), so
rotating about pan barely moves it, while a tilt shift moves it directly. This is
geometry, not luck, and it was confirmed empirically: across two pan-sign
hypotheses the gravity check moved only 2.72° → 1.20°, but a tilt-origin shift
moved it to 23.33°.

Therefore **Δtilt is recoverable from the IMU alone, with no operator action**,
and only **Δpan** requires an external reference.

## Scope

**In scope:** detecting a reboot, solving Δtilt from gravity, solving Δpan from a
stored terrestrial landmark (aircraft as fallback), applying both to the
calibration and the taught limits, and refusing automated motion until the rig is
re-zeroed.

**Out of scope:** the vision/ADS-B grid-scan bootstrap. That remains queued for
first-time setup and genuinely-moved-tripod cases, where a full N-point solve is
required. This design deliberately does not depend on it.

**Not changed:** the 2-sighting cap (`sightings: z.array(...).max(2)`) and the
`c_head` mirror ambiguity it causes. Those belong to the full-calibration work.

## Architecture

Four units, each independently testable.

### 1. Boot detector — `src/boot-watch.ts`

Polls `/api/status`. `uptime_ms` decreasing between two successive reads means the
device rebooted and the origin is gone. Emits a monotonically increasing
`bootId`.

State persists to `~/.tb3-mcp/boot.json` as `{ bootId, lastUptimeMs, lastSeenAtMs }`
so the detector survives its own restart. Two cases must be distinguished, and
polling alone cannot do it:

- **Device rebooted while the daemon watched** — `uptime_ms` decreased. Increment.
- **Device rebooted while the daemon was down** — on first read after a daemon
  restart there is no previous sample in memory. Compare against the persisted
  values: if `wallClockNow - lastSeenAtMs > uptimeMs`, the device has been up for
  less time than has elapsed, so it rebooted unobserved. Increment.

Without the second check, restarting the daemon after a power cycle would silently
adopt the stale calibration as current — the precise failure this design exists to
prevent.

`bootId` is stamped into both `calibration.json` and `limits.json`. Staleness then
lives in the files rather than being inferred at read time: any consumer can
compare a stored `bootId` against the current one.

Depends on: the device HTTP client. Consumed by: the re-zero state machine.

### 2. Δtilt solver — `src/geo/rezero.ts`

```ts
export function solveTiltOffset(
  rS: Mat3, dBaseStored: Vec3, panDeg: number, tiltDeg: number,
  gravity: Vec3, geoPanSign: number,
): { deltaTiltDeg: number; residualDeg: number };
```

One-dimensional search for the Δtilt minimising

```
angle( dBaseFromGravity(rS, panDeg, tiltDeg + Δtilt, gravity, geoPanSign), dBaseStored )
```

over ±90°, coarse-to-fine (1° sweep, then golden-section to 0.01°). The objective
is smooth and single-minimum over that interval because it is the angle between a
fixed vector and one rotated about a single axis.

Returns the residual so callers can reject a bad fit. A residual above
`MAX_TILT_RESIDUAL_DEG = 3.0` means the assumption "only the origin moved" is
false — the tripod was disturbed, or `rS` is stale — and the caller must fall
back to full recalibration rather than silently apply a wrong offset.

Pure function, no I/O. Depends on `dBaseFromGravity` only.

### 3. Δpan solver — `src/geo/rezero.ts`

```ts
export function solvePanOffset(
  R: Mat3, cHead: Vec3, geoPanSign: number,
  refEnu: Vec3, panDeg: number, tiltDeg: number,
): { deltaPanDeg: number; residualDeg: number };
```

Given a reference whose true ENU direction is known, and the pan/tilt at which the
operator has centred it, find the Δpan making the predicted boresight match:

```
minimise angle( R · Rz(geoPanSign·(panDeg+Δpan)) · Rx(tiltDeg) · cHead , refEnu )
```

Same coarse-to-fine search over ±180°. Callers pass a `tiltDeg` already corrected
by Δtilt, so this is genuinely one unknown.

`refEnu` comes from either source:

- **Landmark:** the stored ENU unit vector recorded when calibration was trusted.
- **Aircraft:** `enuDirection(rig, target)` using an ADS-B position extrapolated to
  the sighting instant, exactly as the existing sighting path does.

Residual above `MAX_PAN_RESIDUAL_DEG = 3.0` is rejected for the same reason.

### 4. Re-zero state machine — `src/rezero-tools.ts`

Owns the MCP tools, the persisted state, and the gating.

## Data model

`CalibrationProfile` (`src/calibration.ts`) gains three optional fields, so
profiles written before this change still parse:

```ts
bootId: z.number().optional(),          // origin generation this was solved under
needsRezero: z.boolean().optional(),    // set when bootId != current
landmark: z.object({
  label: z.string(),
  enu: z.array(z.number()).length(3),   // unit ENU, from the trusted calibration
  panDeg: z.number(), tiltDeg: z.number(),  // posture when recorded, for operator recall
  recordedAt: z.string(),
}).optional(),
```

`TaughtLimits` (`src/limits-store.ts`) gains `bootId: z.number().optional()`.

The landmark stores **ENU, not lat/lon**. A terrestrial reference needs only a
direction, and a direction is what survives; requiring the operator to know the
tower's coordinates would make the feature unusable.

## Behaviour on a detected reboot

Ordered so the dangerous axis is protected first.

1. **Immediately, no operator action:** read gravity, run `solveTiltOffset`. On an
   acceptable residual, apply Δtilt to `cHead` and shift `tiltMin`/`tiltMax` in the
   taught limits. **Tilt is protected within seconds of boot** — this is the axis
   that hit the motor stop.
2. Set `needsRezero: true` and stamp the new `bootId`.
3. **Refuse** `track_aircraft`, `start_tracking`, `goto`, `point_at`,
   `point_at_azel` with an error naming what is missing and how to fix it.
4. **Allow** manual jog and `teach_limit`. The operator must be able to drive to
   the landmark, and must be able to re-teach limits if they choose to.
5. Pan limits stay *disabled* (falling back to the config ceiling) until Δpan is
   known, because a stale pan limit is worse than none: it can block escape in one
   direction while permitting a drive into the stop in the other.
6. On `rezero_from_landmark` / `rezero_from_aircraft`: solve Δpan, apply
   `R' = R·Rz(Δpan)`, shift `panMin`/`panMax`, clear `needsRezero`, restore full
   limit enforcement.

Today's failure was the exact inverse: the rig drove confidently on stale numbers.
The design principle here is that an unknown origin must fail closed for anything
automated and open for anything the operator is watching.

## MCP tools

| Tool | Purpose | Precondition |
|---|---|---|
| `set_landmark(label)` | Record the current posture and its ENU as the reference | `isCalibrated()` — never record from a provisional orientation |
| `rezero_from_landmark()` | Operator has centred the landmark; solve and apply Δpan | landmark exists, `needsRezero` |
| `rezero_from_aircraft(hex)` | Fallback using an ADS-B target | target trackable with a fresh fix |
| `get_rezero_status()` | What is stale, what is needed, current Δ estimates and residuals | none |

`get_rezero_status` exists because the failure this design addresses was
*invisible*. `set_north_zero` produced something that looked calibrated and that
tracking would run on, while `isCalibrated()` quietly returned false. Any state
that gates motion must be directly readable.

## Error handling

- **Tilt residual too large** → do not apply. Report that the tripod appears to
  have moved and that full recalibration is required. Leave `needsRezero` set.
- **Pan residual too large** → same, scoped to pan.
- **No landmark recorded** → `rezero_from_landmark` fails with a message pointing
  at `set_landmark` and the aircraft fallback.
- **IMU absent or `chip: "none"`** → Δtilt is unavailable; both axes fall back to
  the config ceiling and `needsRezero` stays set. Never guess a tilt offset.
- **Stale ADS-B fix** → reject per the existing `seen_pos` policy rather than
  correlating against an extrapolated ghost.

## Testing

Unit tests, no rig required:

1. **Round-trip recovery.** Take a known-good calibration, apply a synthetic
   (Δpan, Δtilt), confirm both solvers recover them to <0.05° and that predicted
   pointing for an independent target is restored. Swept across a grid of offsets
   including large ones (±150° pan, ±60° tilt).
2. **Decoupling.** Confirm `solveTiltOffset` is insensitive to pan error —
   inject Δpan, verify the recovered Δtilt is unchanged within tolerance. This is
   the assumption the whole design rests on, so it gets an explicit test.
3. **Rejection.** Perturb `dBase` to simulate a moved tripod; confirm the residual
   exceeds threshold and no offset is applied.
4. **Limit shifting.** Confirm taught limits move with the solved offsets and that
   a rig parked outside its shifted range can still escape (the direction-aware
   `axisBlocked` behaviour must be preserved).
5. **Gating.** Confirm automated motion tools refuse while `needsRezero` is set and
   that jog and `teach_limit` still work.
6. **Boot detection.** Feed a decreasing `uptime_ms` sequence; confirm exactly one
   `bootId` increment and that both stores are stamped.

Test 1 doubles as a regression net for sign errors: a mirrored pan mapping — the
`geoPanSign` inversion found on 2026-08-02 — fails it immediately.

## Rejected alternatives

**Full recalibration after every reboot.** The status quo. Correct but costs an
evening, and discards information that is provably still valid.

**Persisting step position to EEPROM on the device.** Does not work: the head can
be moved by hand or by gravity while unpowered, so a saved count is not
trustworthy on restore. It also could not detect that it had become wrong.

**Magnetometer for Δpan.** Would make re-zero fully automatic with no operator
action. Deferred pending the `/api/mag` interference survey — on a rig whose
stepper rotors are the suspected source, this cannot be assumed to work. If the
survey comes back clean it becomes an obvious follow-up and slots into the same
`solvePanOffset` entry point.
