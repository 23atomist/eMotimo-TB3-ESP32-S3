# IMU-Aided Calibration — Design

**Status:** **VALIDATED 2026-07-22** against real roof data by a numerical compute
pass (see "Validation" below). Ready to implement. Supersedes the pre-validation
draft — the solve now recovers the camera boresight offset and a third root
cause (pan handedness) the first draft did not anticipate.

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
- The **IMU independently read the tripod as ~level (~4° pitch)** — directly
  contradicting the 144° base_tilt. The IMU is the vertical ground-truth the
  landmarks can't provide.

## Validation (2026-07-22)

Two standalone scripts (no daemon source touched) proved the approach against the
actual field data (rig `33.38318, -112.14131, 331 m`; the two sightings; and the
7-position pan+tilt IMU gravity sweep). **These scripts are the golden reference
for the unit tests** — the implementation must reproduce their numbers.

- **`tb3-mcp/scripts/imu-calib-groundtruth.mjs`** — imports the repo's *own*
  compiled helpers (`dist/geo/wgs84.js`, `dist/geo/boresight.js`,
  `dist/geo/orientation.js`) to emit ground-truth ENU/az-el and to reproduce the
  broken solve. Anchors the Python model to real repo code, not a re-derivation.
- **`tb3-mcp/scripts/imu-calib-validate.py`** — the solver + validation (numpy).
  Asserts its ENU matches `wgs84.ts` to <1e-3° and its `M(pan,tilt)·[0,1,0] ==
  panTiltToMount(pan,tilt)` — the kinematics convention is confirmed, not assumed.

Results (independently re-run, reproduces the report exactly):
- Reproduces the roof failure: current TRIAD → **heading 90.25°, base_tilt 144.56°**
  (matches the recorded 144.53° garbage).
- Gravity-anchored solve reproduces **both landmarks to 0.20°** and recovers the
  recorded postures (A: pan −26.20/tilt −31.01 vs recorded −26/−31; B:
  −125.00/−27.32 vs −125.2/−27.3).
- **High targets no longer point into the ground** (the headline):

  | target (az, el) | old broken solve | new solve → tilt |
  |---|---|---|
  | 154°, +10° | drove to −63° (into ground) | **−23.8° (in-range)** |
  | 127°, +30° | — | +0.2° |
  | 90°, +45° | — | +21.6° |

  Monotonic (higher el → higher tilt), all within limits.

## Root causes — THREE (the first draft named two)

1. **Near-horizon degeneracy.** TRIAD needs its two reference directions to span
   all three axes; two near-horizon landmarks span azimuth but barely span
   elevation, so `cross(enuA, enuB)` (world-up) is dominated by sighting noise
   and the vertical flips. Gravity supplies the missing vertical.
2. **Camera boresight offset ≈ 42.7°** (25.7° pitched *up* from the mechanical
   axis, −35° yaw) — the camera does not look down the mount's mechanical
   forward, and `panTiltToMount` does not model this. Recovered as `c_head`.
3. **Pan handedness is inverted (NEW).** The field data obeys **`az = 101 − pan`**
   (slope −1), but `panTiltToMount`/`M(pan,tilt)` produce mount-azimuth `= +pan`
   (slope +1). No proper rotation and no `c_head` can flip that slope (proven
   algebraically); the solve only works with `panTiltToMount(−pan, tilt)`.
   Heading agreement between the two landmarks collapses from **161.5° → 0.4°**
   when pan is negated. **This is the same inverted pan convention behind the jog
   left/right reversal** the operator caught on the dashboard. In the old pure-
   TRIAD path the handedness silently cancels in the calibrate→point round-trip;
   once anchored to *absolute* gravity + true landmark azimuth it no longer
   cancels and must be physically correct.

## Recovered quantities (winning convention: `pan_sign = −1`, `tilt_sign = +1`)

- **`R_s`** (IMU→head mounting): `[[0.986919, 0.106064, 0.121417], [0.028234,
  -0.855185, 0.517554], [0.158728, -0.507355, -0.846992]]`, det +1. Per-sample
  residuals rms **1.50°**, max 2.44° over the 7-position sweep — a clean, near-
  rigid mounting. The sweep spans pan AND tilt, so `R_s` is well-conditioned.
- **`d_base` = `[-0.014936, -0.073272, -0.9972]`** ⇒ **tripod tilt 4.29°** from
  vertical (NOT the 144° TRIAD claimed).
- **`c_head`** (camera axis in head frame): `[-0.520849, 0.735122, 0.433949]`.
- **`R`** (mount→world): heading ≈ **132.3°**; camera az at pan0 = 95.4°.

## Frames & model

- World = ENU; down `g_w = [0,0,-1]`.
- `R` = base orientation (maps mount-frame → world; the stored 3×3 `orientation`).
- `M(pan,tilt)` = head rotation in the mount frame — the same kinematics
  `panTiltToMount` / `mountToPanTilt` (`src/geo/boresight.ts`) encode, evaluated
  at **`(pan_sign·pan, tilt)`** with `pan_sign = −1`.
- `R_s` = fixed IMU→head mounting rotation.
- `c_head` = camera boresight unit vector in the head frame (NOT `[0,1,0]`).
- IMU gravity in its sensor frame: `g_s(pan,tilt) = R_sᵀ · M(pan,tilt)ᵀ · Rᵀ · g_w`.

Rearranged, the **base-frame down vector is constant** across all positions:

```
d_base := Rᵀ·g_w = M(pan,tilt) · R_s · g_s(pan,tilt)     (same for every pan,tilt)
```

Boresight in world for a given pan/tilt: `w = R · M(pan_sign·pan, tilt) · c_head`.

### Step 1 — characterize `R_s` (one-time, needs the rig)

Move the rig to ≥4 diverse positions spanning pan AND tilt; at each, log
`(pan_i, tilt_i, g_s_i)` where `g_s_i` = normalized **raw accel** from
`/api/imu?n=k` (average k samples), NOT the firmware `pitch/roll`. Solve for
`R_s` (and `d_base`) so `M(pan_i,tilt_i)·R_s·g_s_i` is the same unit vector for
all i (Kabsch/Wahba over the transformed samples). `R_s` is fixed while the IMU
stays mounted; persist it. Re-runs are NOT needed per calibration.

### Step 2 — IMU-anchored orientation + camera-offset solve (REVISED)

The first draft's Step 2 assumed boresight = mechanical forward; that is wrong by
the 34° offset and must instead solve `c_head`. With `R_s` known:

1. **Vertical (2 DOF):** one gravity reading gives `d_base = M(pan,tilt)·R_s·g_s`;
   build `R0` aligning mount-up to world-up. Pins the vertical.
2. **Camera offset `c_head`:** for each sighting `i`, `(R0·M(pan_sign·pan_i,
   tilt_i)·c_head)_z = sin(el_i)` is linear in `c_head`. Two sightings give two
   planes; their intersection is a null-line, and `∩` the unit sphere yields
   **≤2 candidate `c_head`**.
3. **Disambiguate:** pick the branch with `c_head · (+Y) > 0` (camera looks
   forward). Valid only if the camera is mounted within 90° of mechanical
   forward — see Risks; the robust fix is a 3rd/elevation-spread landmark.
4. **Heading (1 DOF):** `heading = az(w_i) − az(R0·M_i·c_head)`, averaged over
   sightings. **Assert the sightings agree** (per-landmark heading within ~2°);
   a larger disagreement means a degenerate/bad sighting — **warn and refuse**
   rather than emit a 144°-style result. Assemble `R` from (vertical, heading).

## Implementation

- **`src/geo/imu-orientation.ts`** (new):
  - `solveImuMounting(samples) → R_s` (Kabsch over `M·R_s·g_s` constant).
  - `solveCalibrationWithGravity(dBase, sightings, panSign) → { R, cHead,
    headingResidualDeg }`, refusing on `headingResidualDeg` over the threshold.
- **`src/calibration.ts` (`CalibrationStore`):** persist `R_s`, `c_head`, and the
  gravity sample(s) alongside `orientation`.
- **`src/config.ts`:** add `panSign` (default **−1**, pending on-rig confirm; env
  `TB3_PAN_SIGN`). Apply it consistently in the geo mount path (`point_at`,
  `solve_calibration`) — NOT in the jog/device layer (that already carries the
  operator's UI swap).
- **New MCP tools (`src/geo-tools.ts` / new module):**
  - `characterize_imu` — sweeps the rig to N positions, reads `/api/imu`, solves
    `R_s`, persists it. (Motion tool — respects limits + sun guard + deadman.)
  - `solve_calibration` gains a gravity path: when `R_s` is present, anchor the
    vertical with gravity + solve `c_head` + heading; else fall back to the
    existing TRIAD (unchanged) and warn (near-horizon degeneracy).
- Raw gravity: `GET /api/imu?n=k` returns samples with `ax,ay,az`; average +
  normalize → `g_s`. (`/api/imu` and ticks emit bare `nan` for the absent baro —
  sanitize before JSON.parse; ARRAYS need `.replace(/nan/gi,"null")`, see
  [[tb3-field-deployment-2026-07-22]].)

## Testing

- **Unit (vitest; golden numbers from `scripts/imu-calib-validate.py`):**
  - `solveImuMounting` recovers a known `R_s` from synthetic `(pan,tilt,g_s)`
    samples, and recovers the field `R_s` (rms ≤ ~1.6°) from the real sweep.
  - `solveCalibrationWithGravity` recovers the validated `R` + `c_head` from the
    real roof sightings **including the near-horizon case that fails today**;
    reproduces both landmarks to <0.5° and the recorded postures.
  - Disambiguation picks the forward (`c_head·+Y>0`) branch, not the marginally-
    better-fitting mirror.
  - Heading-disagreement guard fires on a degenerate/collinear sighting pair.
  - **Regression:** a high target (az 154°, el +10°) solves to an in-range
    **upward-ish** tilt (≈ −23.8°), NOT −63° (broken TRIAD) or −87° (level-tripod
    assumption).
- **On-rig (needs operator, hand on E-STOP):** run `characterize_imu`;
  re-calibrate with **three** landmarks (or two at clearly different elevations);
  confirm `pan_sign` on the rig; `point_at` a landmark's own coords and confirm
  it centers on the crosshair; confirm a high-elevation target maps to a sane
  (upward) tilt.

## Risks / open questions

- **Pan sign must be confirmed on-rig** (the data says −1). After the geo-layer
  fix, **re-verify jog direction** on-rig — the jog maps at the device layer, but
  it shares the same physical pan convention, so confirm the UI swap + geo sign
  don't double-correct.
- **`c_head` 2-fold ambiguity.** 2 landmarks + gravity is NOT unique: the mirror
  solution (camera-backward, pitch −15°) agrees at both landmarks but diverges up
  to **115° (mean 64°)** elsewhere, and fits *marginally better* (heading
  disagreement 0.037° vs 0.404°) — a naive best-fit picks the wrong branch. The
  `c_head·+Y>0` prior disambiguates the current data; the robust fix is to
  **require a 3rd landmark or an elevation-spread pair** before trusting a
  2-sighting solve.
- **Base tilt is essential, not optional.** Assuming a level tripod sends az154/
  el+10 to tilt **−87.7°** (near gimbal-down) with 3.2° reprojection error. The
  4.3° IMU base tilt must feed the solve — this is why the IMU earns its place.
- `M(pan,tilt)` sign/axis convention must match `boresight.ts` exactly — the
  validation asserts this; keep the assertion in the unit tests.
- IMU accel is uncalibrated (~16% high magnitude, gyro bias) — irrelevant for a
  *direction* (we normalize), which is all gravity-anchoring needs.
