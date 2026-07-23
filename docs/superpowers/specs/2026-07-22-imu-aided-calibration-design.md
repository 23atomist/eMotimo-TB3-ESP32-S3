# IMU-Aided Calibration — Design

**Status:** design, awaiting on-rig characterization (needs the operator present to move the rig safely). Written 2026-07-22 after two failed on-roof calibrations.

## Problem

`solve_calibration` solves the mount orientation with 2-point TRIAD
(`solveOrientation`, `src/geo/orientation.ts`) from two landmark sightings.
When **both landmarks are near the horizon**, the vertical/tilt axis is
near-degenerate and the solve returns a physically impossible orientation.

Observed on the roof (2026-07-22, twice):
- Landmarks: South-Mountain TV towers (az ~127°, **+3.8° el**) and a
  Sierra-Estrella peak (az ~226°, **+3.4° el**) — ~99° apart in azimuth (good),
  but both barely above the horizon.
- Solve returned `base_tilt ≈ 144°` — i.e. the mount's "up" axis pointing
  *downward*, which is nonsense.
- Consequence: tracking maps an above-horizon target to a steep **downward**
  tilt. A plane at 8000 ft drove the rig to **tilt −63°, into the ground**.
- The **IMU independently read the tripod as ~level (~3° pitch)** — directly
  contradicting the 144° base_tilt. The IMU is the vertical ground-truth the
  landmarks can't provide.

## Root cause

TRIAD needs the two reference directions to span all three axes. Two
near-horizon landmarks span azimuth but barely span elevation, so the vertical
is near-unobservable; `cross(enuA, enuB)` (which should define world-up) is
dominated by sighting noise, and small errors flip the vertical axis. This is a
geometric degeneracy — **careful aiming cannot fix it.**

## Approach

Add a **gravity reference**. The IMU accelerometer measures the gravity
direction — a vector ~90° off the horizon, exactly the axis the landmarks lack.
Use gravity to fix the **vertical (2 DOF)** and the landmark(s) to fix the
**heading (1 DOF)**. Full, robust orientation regardless of landmark elevation.

## The wrinkle: the IMU is on the moving head

The IMU sits on the pan/tilt head, so its reading depends on the current
pan/tilt, and (observed) its axes are **rotated** relative to the rig's pan/tilt
axes — pitch stayed ~3° while roll swung to −27° as the head tilted. So the
IMU→head mounting rotation `R_s` is unknown and must be characterized first.

### Frames & model

- World = ENU; down `g_w = [0,0,-1]`.
- `R` = base orientation (what calibration solves; maps mount-frame → world; the
  stored 3×3 `orientation`).
- `M(pan,tilt)` = head rotation in the mount frame from pan+tilt — the same
  kinematics `panTiltToMount` / `mountToPanTilt` (`src/geo/boresight.ts`) encode.
- `R_s` = fixed IMU→head mounting rotation (unknown).
- IMU gravity in its sensor frame: `g_s(pan,tilt) = R_sᵀ · M(pan,tilt)ᵀ · Rᵀ · g_w`.

Rearranged, the **base-frame down vector is constant** across all positions:

```
d_base := Rᵀ·g_w = M(pan,tilt) · R_s · g_s(pan,tilt)     (same for every pan,tilt)
```

### Step 1 — characterize `R_s` (one-time, needs the rig)

Move the rig to ≥4 diverse positions spanning pan AND tilt; at each, log
`(pan_i, tilt_i, g_s_i)` where `g_s_i` = normalized **raw accel** from
`/api/imu?n=k` (average k samples), NOT the firmware `pitch/roll`. Solve for
`R_s` (and `d_base`) so `M(pan_i,tilt_i)·R_s·g_s_i` is the same unit vector for
all i — a rotation fit (small nonlinear least-squares / Wahba over the
transformed samples). `R_s` is fixed while the IMU stays mounted; persist it.

### Step 2 — IMU-anchored orientation solve

With `R_s` known, one IMU reading gives the base vertical:
`d_base = M(pan,tilt)·R_s·g_s` ⇒ world-up in the base frame = `-d_base`. That
pins 2 DOF of `R`. Then one (or both) landmark sighting(s) fix the heading:
project the landmark's mount-direction and its ENU direction onto the horizontal
plane (⊥ `d_base`) and align the azimuth. Assemble `R` from (vertical, heading).

## Implementation

- `src/geo/imu-orientation.ts` (new): `solveImuMounting(samples) → R_s`;
  `solveOrientationWithGravity(dBase, mountDir, enuDir) → R`.
- `src/calibration.ts` (`CalibrationStore`): persist `R_s` + the gravity
  sample(s) alongside `orientation`.
- New MCP tools (`src/geo-tools.ts` / a new module):
  - `characterize_imu` — sweeps the rig to N positions, reads `/api/imu`, solves
    `R_s`, persists it. (Motion tool — respects limits + sun guard + deadman.)
  - `solve_calibration` gains a gravity path: when `R_s` is present, anchor the
    vertical with gravity and use landmark(s) for heading; else fall back to the
    existing TRIAD (unchanged) and warn.
- Raw gravity: `GET /api/imu?n=k` returns samples with `ax,ay,az`; average +
  normalize → `g_s`. (Remember `/api/imu` and ticks emit bare `nan` for the
  absent baro — sanitize before JSON.parse, see [[tb3-field-deployment-2026-07-22]].)

## Testing

- **Unit:** `solveImuMounting` recovers a known `R_s` from synthetic
  `(pan,tilt,g_s)` samples; `solveOrientationWithGravity` recovers a known `R`
  from a synthetic gravity + a single landmark **including the near-horizon case
  that fails today**; degenerate-input guards (collinear samples, gravity ⟂
  unavailable).
- **On-rig (needs operator, hand on E-STOP):** run `characterize_imu`;
  re-calibrate; `point_at` a landmark's own coords and confirm it centers on the
  crosshair; confirm a high-elevation target maps to a sane (upward) tilt.

## Risks / open questions

- `M(pan,tilt)` sign/axis convention must match `boresight.ts` exactly — verify
  against one known sighting before trusting the solve.
- `R_s` characterization geometry must span pan *and* tilt; clustering near the
  horizon leaves `R_s` under-constrained (same trap as today).
- IMU accel is uncalibrated (~16% high magnitude, gyro bias) — irrelevant for a
  *direction* (we normalize), which is all gravity-anchoring needs.
- **Fallback if the IMU proves too noisy:** the failure today is essentially a
  constant ~34° tilt-zero / camera-mount offset that the degenerate solve
  mis-handled. A cheaper fix is to characterize that single tilt offset (one
  gravity reading at a known pan/tilt) and apply it as a constant tilt
  correction — less general than full IMU-aided, but it fixes the observed case.
```
