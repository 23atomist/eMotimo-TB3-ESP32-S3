# Geo-Pointing (Layer 2) — Design

**Status:** approved (2026-07-15)

**Goal:** Let an LLM point the TB3 at a geographic target given as `lat / lon / height`, by converting that target into an azimuth/elevation, then into the rig's pan/tilt, and driving the rig through layer 1's `goto_angle`.

**Context:** This is layer 2 of the [three-layer LLM-control roadmap](2026-07-15-mcp-control-design.md). Layer 1 (`mcp-control`) is built and hardware-verified: it exposes `goto_angle(pan_deg, tilt_deg, speed_dps)` and `get_status` in a **user frame** (pan/tilt in degrees, related to device steps only by a sign; `set_home` defines an arbitrary mechanical zero). Layer 3 (target tracking) will build on this layer.

**The problem:** The rig has **no GPS, compass, IMU, or encoders**. Its user-frame pan/tilt zero is arbitrary and unrelated to geography. Geo-pointing is therefore entirely a **manual-calibration** problem: relate the mount's pan/tilt frame to the geographic frame by sighting known landmarks.

**Primary use case:** distant / wide-area targets (hundreds of meters to many km) — aircraft, drones, mountains, buildings. This drives two decisions: the coordinate math must be **Earth-curvature-aware** (WGS84 → ENU), and the orientation calibration must be accurate enough that fractions of a degree hold up at kilometers.

---

## Architecture

Geo-pointing **extends the existing `tb3-mcp` daemon** rather than running as a separate service — its entire job is to compute a pan/tilt and call `goto_angle`, which lives one function call away inside the daemon. A separate service would duplicate the MCP transport and add a network hop for no benefit.

New modules (pure and independently testable, matching the existing small-file style):

| Module | Responsibility | Depends on |
|---|---|---|
| `src/geo/wgs84.ts` | geodetic (lat/lon/height) → ECEF → ENU direction at the rig; azimuth/elevation/range | nothing |
| `src/geo/boresight.ts` | pan/tilt ↔ mount-frame unit vector (the kinematic convention) | nothing |
| `src/geo/orientation.ts` | TRIAD solve: two (mount-dir, ENU-dir) pairs → mount→ENU rotation `R`; and `R` + target ENU → pan/tilt | wgs84, boresight |
| `src/calibration.ts` | calibration profile (rig location, sightings, solved `R`, timestamp); atomic load/save to a JSON file | geo/* |
| `src/geo-tools.ts` | the new MCP tools; snapshots pan/tilt via `device`, calls `goto_angle` | calibration, device |

Layer 1 is untouched except that the tool-registration entry point also calls `registerGeoTools(server, device, cfg, store)`. Calibration state persists to a JSON file (default `~/.tb3-mcp/calibration.json`, overridable) so it survives daemon restarts; the rig is assumed to stay put between sessions, and re-running calibration overwrites the profile.

---

## Calibration model & coordinate math

**Core idea:** the mount's pan/tilt frame is related to the geographic frame by a single unknown 3-D rotation `R` (mount → ENU). Calibration solves for `R`; pointing applies it. `R` absorbs **both** the heading offset and any base tilt/roll, so an unlevel tripod is handled by the model rather than being an error source.

### Coordinate pipeline (per landmark or target)

1. Rig and point given as WGS84 `lat, lon, height`.
2. Convert both to **ECEF** (Earth-Centered, Earth-Fixed) using the WGS84 ellipsoid
   (`a = 6378137.0 m`, `f = 1/298.257223563`).
3. Rotate the ECEF vector rig→point into the rig's local **ENU** (East, North, Up) frame and normalize. Azimuth `= atan2(E, N)`, elevation `= asin(U)`, range `= |rig→point|`. The ENU step is what makes pointing curvature-correct at km range.

### Boresight convention

A pan/tilt pair maps to a unit vector in the mount's **own** frame:

```
d_mount(pan, tilt) = [ sin(pan)·cos(tilt),   // mount-right / east-like
                       cos(pan)·cos(tilt),   // mount-forward / north-like
                       sin(tilt) ]           // mount-up
```

Pan rotates the boresight about mount-up; tilt raises it. It inverts cleanly:
`tilt = asin(z)`, `pan = atan2(x, y)`.

### Two-landmark solve (TRIAD)

Each sighting yields a **direction pair**: the ENU direction to the landmark (pipeline step 3) and the mount-frame direction `d_mount(pan, tilt)` the operator aimed at it. Two non-parallel pairs uniquely determine the rotation `R` via the TRIAD construction (a closed-form special case of Wahba's problem):

- Build an orthonormal triad from the two mount-frame vectors (`t1 = v1`, `t2 = normalize(v1 × v2)`, `t3 = t1 × t2`) and the matching triad from the two ENU vectors.
- `R = [w1 w2 w3] · [t1 t2 t3]ᵀ`, mapping mount → ENU.

### Pointing a target

Target ENU direction → `d_mount = Rᵀ · d_enu` → invert to `(pan, tilt)` → hand to `goto_angle`.

### Datum assumption

Rig and target heights must use the **same** datum. The implementation treats heights as height-above-ellipsoid, but because ENU elevation depends on the height *difference* and the geoid separation is nearly constant across a local area, **MSL heights work equally well** — the offset cancels. No geoid model is needed. This is documented for the operator.

### Deliberately out of scope for v1 (future refinements)

- **Atmospheric refraction** (~0.3–0.5° of upward bending, only significant for near-horizon targets).
- **Lever-arm offset** between the rig's antenna/reference point and the camera nodal point (negligible unless the target is very close).

---

## MCP tool surface

Seven new tools alongside layer 1's. Heights in meters, angles in degrees.

| Tool | Args | Returns / effect |
|---|---|---|
| `set_rig_location` | `lat, lon, height_m` | Stores the rig's fixed position. Prerequisite for solving. Clears any prior sightings and solution. |
| `sight_landmark` | `lat, lon, height_m, label?` | Snapshots the **current** pan/tilt (from `get_status`) as a sighting of this known point. Returns the slot (1st/2nd) and captured pan/tilt. |
| `solve_calibration` | — | Runs TRIAD on the two sightings → stores `R`. Returns solved heading, base tilt/roll, landmark azimuth separation, and a quality note. Persists the profile. |
| `point_at` | `lat, lon, height_m, speed_dps?` | The main tool. Computes az/el → pan/tilt, checks reachability, calls `goto_angle` (blocks to arrival). Returns `{azimuth_deg, elevation_deg, range_m, pan_deg, tilt_deg}`. |
| `point_at_azel` | `azimuth_deg, elevation_deg, speed_dps?` | Direct pointing bypassing geo — a byproduct of `R`, useful for verification/debugging. |
| `get_calibration` | — | Current profile: rig location, sightings, solved heading, timestamp, `calibrated: bool`. |
| `clear_calibration` | — | Wipes the profile. |

### Typical operator/LLM flow

1. `set_rig_location(...)` — operator reads rig lat/lon/height from a map or phone GPS.
2. Watch the live camera feed, `jog` (layer 1) to center **landmark A**, then `sight_landmark(A…)`.
3. Same for **landmark B**, ideally well-separated in azimuth.
4. `solve_calibration()` → e.g. *"heading 37.2°, base tilt 1.4°, landmarks 82° apart — good geometry."*
5. `point_at(target…)` → rig slews; reports computed az/el/range and the pan/tilt used.
6. Verify: `point_at` a third known landmark and confirm it is centered in the feed.

Aiming is human-in-the-loop: the operator watches the existing websocket camera feed and jogs until the landmark is centered on a reticle; the tool only snapshots the current pan/tilt. Layer 2 does not process the video.

---

## Error handling, reachability & persistence

**Prerequisite/state errors** (returned as normal tool errors the LLM can read and act on):

- `sight_landmark` before `set_rig_location` → refuse ("set rig location first").
- `solve_calibration` with fewer than two sightings → refuse.
- `point_at` / `point_at_azel` before a solved calibration → refuse ("not calibrated").

**Input validation** (zod at the tool boundary): `lat ∈ [−90, 90]`, `lon ∈ [−180, 180]`, heights finite and within a sane band; reject otherwise with a clear message.

**Reachability** — computed after pan/tilt, before moving:

- **Below horizon / out of tilt range**: an elevation mapping to a tilt outside `[tiltMin, tiltMax]` → refuse, with the computed az/el/tilt in the message (e.g. "target at elevation −4° is below the reachable tilt range").
- **Pan wrap**: the raw `atan2` pan may fall outside `[panMin, panMax]`; try the ±360° equivalent and use whichever lands in range. If neither does, refuse with a clear message.
- Reuses layer-1 `checkPanTilt`, keeping the soft limits the single source of truth.

**Calibration quality**:

- `solve_calibration` warns when the two landmarks are poorly separated in azimuth (near-collinear → ill-conditioned `R`) and reports the separation so the operator can choose better ones.
- `sight_landmark` warns if captured while the rig is still moving (`get_status.moving`), since the pan/tilt would not be settled.

**Persistence**: the profile is written to `~/.tb3-mcp/calibration.json` (path overridable via config/env), with an **atomic** write (temp file + rename) and a **zod-validated** schema carrying a `version`. A missing or corrupt file → the daemon starts *uncalibrated* (logged), never crashing. `get_calibration` surfaces the solved-at timestamp. A bumped tripod cannot be detected automatically, so re-calibration is the operator's judgment call — documented.

---

## Testing strategy

The geo math is deterministic, so most confidence comes from **synthetic ground-truth unit tests**, no hardware required:

- **`wgs84`**: geodetic→ECEF against published reference coordinates; ENU/azimuth/elevation against known bearings (cardinal-direction sanity cases plus a hand-computed great-circle bearing).
- **`boresight`**: round-trip `pan/tilt → d_mount → invert → pan/tilt` is identity across the range.
- **`orientation` (key)**: fabricate a known mount rotation `R_true` and rig location; synthesize two landmark sightings by projecting through `R_true`; run TRIAD; assert recovered `R ≈ R_true`. Then feed a third known target through the recovered `R` and assert the resulting pan/tilt matches ground truth within tolerance — proving the whole pipeline end-to-end in software.
- **Reachability**: below-horizon target refused; pan-wrap picks the in-range equivalent; out-of-limits refused.
- **`calibration` store**: save/load round-trip, atomic write, corrupt/missing file → uncalibrated, schema-version handling.
- **Tools**: prerequisite + validation errors; `point_at` invokes `goto_angle` with the expected pan/tilt (mock `Device`); quality/conditioning warnings fire.
- **Integration** against the existing **mock TB3**: `set_rig_location → sight → sight → solve → point_at` drives the mock's goto to the correct angles.

Final validation is a real two-landmark calibration on the rig, then pointing at a known third landmark and confirming it is centered in the feed.

---

## Out of scope (this layer)

- Following/tracking a **moving** target and rate control (that is layer 3).
- Processing the camera video or auto-detecting landmarks (aiming stays human-in-the-loop).
- Atmospheric refraction and lever-arm corrections (future refinements, noted above).
- Discovering the true mechanical pan/tilt range (layer 1 ships conservative soft limits; the operator narrows them as needed).
