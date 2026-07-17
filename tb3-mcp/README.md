# tb3-mcp

Always-on MCP daemon that lets any LLM control the eMotimo TB3 over the network.

## Run

```bash
cd tb3-mcp
npm install
cp config.example.json config.json   # edit deviceHost + limits for your rig
npm run build
npm start                             # serves MCP at http://<host>:8770/mcp
```

Dev mode (no build): `npm run dev`. Tests: `npm test`.

## Configuration

`config.json` (all keys overridable by env, e.g. `TB3_DEVICE_HOST`, `TB3_MCP_PORT`,
`TB3_MCP_TOKEN`, `TB3_MAX_SPEED_DPS`, `TB3_PAN_SIGN`):

| key | default | meaning |
|---|---|---|
| deviceHost | `tb3.local` | TB3 host or `ip:port` |
| mcpPort | `8770` | MCP HTTP/SSE listen port |
| mcpToken | (unset) | if set, clients must send `Authorization: Bearer <token>` |
| panMin/panMax | `-180/180` | pan soft limits (degrees) |
| tiltMin/tiltMax | `-90/90` | tilt soft limits (degrees) |
| maxSpeedDps | `22` | max goto speed (°/s); the firmware caps point-to-point moves at ~22.5°/s (10000 steps/s) |
| maxJogDps | `19` | °/s at full joystick deflection — **measured** on the rig (both axes, jog-probe.mjs, 2026-07-16), not a preference. This is a different ceiling from `maxSpeedDps` on purpose: jog runs through the firmware's 20kHz DDS accumulator, goto sets a direct pulse rate — the two mechanisms genuinely plateau at different rates. Note the firmware's deflection→rate curve is *cubic* with a deadband, so `jog` (which maps linearly) is approximate by design; layer-3 tracking inverts the measured cubic. |
| panSign/tiltSign/auxSign | `1` | per-axis sign flip (`1` or `-1`) |
| calibrationFile | `~/.tb3-mcp/calibration.json` | where the calibration profile is persisted (env `TB3_CALIBRATION_FILE`) |
| trackTickHz | `10` | target-tracking control loop rate (env `TB3_TRACK_TICK_HZ`) |
| trackKp | `1.0` | tracking proportional gain, °/s of rate per ° of pointing error (env `TB3_TRACK_KP`) |
| trackLeadMs | `150` | how far ahead the tracker aims the servo, to cover command + rig latency (env `TB3_TRACK_LEAD_MS`) |
| trackMaxTargetAgeMs | `5000` | target fix older than this → tracking stops and waits (env `TB3_TRACK_MAX_TARGET_AGE_MS`) |
| trackStaleTelemetryMs | `1000` | device telemetry older than this → tracking stops and waits (env `TB3_TRACK_STALE_TELEMETRY_MS`) |
| trackDeadmanMs | `120000` | total silence (no `update_target`/activity) before a tracking session ends outright (env `TB3_TRACK_DEADMAN_MS`) |
| trackReacquireDeg | `10` | pointing error above which tracking drops the rate servo and re-acquires with a goto (env `TB3_TRACK_REACQUIRE_DEG`) |
| jogVectorTtlMs | `500` | the daemon's jog keep-alive won't re-send a rate vector older than this — see Safety under Target tracking (env `TB3_JOG_VECTOR_TTL_MS`) |

**Soft limits refuse out-of-range moves** — there are no endstops. Set them to your rig's real reachable range.

## Tools

`get_status`, `goto_angle`, `jog`, `stop`, `set_home`, `trigger_camera`, `list_programs`, `select_program`.

`goto_angle` is the soft-limit-enforced primitive — out-of-range targets are refused. `jog` is
manual/supervised open-loop rate control and does **not** enforce pan/tilt soft limits, so an
operator can drive past the configured limits with sustained jogs. (There are no endstops.)

### Known limitation: web motion is mode-gated on the rig

The rig only wires the web joystick into actual motor output on screens where the firmware runs
`DFSetup()`, `NunChuckQuerywithEC()`, and `updateMotorVelocities2()` together in the same input
loop. Four screens do this today: **"Move to Start Pt"** / **"Move to End Pt."**
(`Move_to_Startpoint()` / `Move_to_Endpoint()`, `src/_TB3_LCD_Buttons.ino`), **"Move to Point"**
(`Move_to_Point_X()`, `src/_TB3_LCD_Buttons.ino:452-506` — reached from 3-point moves, the
panorama corner point, and the portrait-pano subject point), and **"Set Angle o'View"**
(`Set_angle_of_view()`, `src/TB3_PANO.ino:69-113`). On any other screen, the same input drives
menu navigation instead, so **`goto_angle`, `jog`, and tracking will report success but the rig
will not move — no error, no hint, just silence.** In Dragonframe slave mode the
firmware runs a separate blocking loop that doesn't pump the web input path at all, so `jog`,
`goto_angle`, and even `stop` are all dead. **If a command stops moving the rig, check the rig's
own LCD screen first.** A dedicated firmware "Track (Web)" mode that removes this gating is
planned but does not exist yet.

## Geo-pointing (layer 2)

Azimuth/elevation pointing requires a **calibration** that solves the mount's orientation from two sightings of known landmarks. Once calibrated, use `point_at` (geographic target) or `point_at_azel` (absolute azimuth/elevation).

### Calibration Workflow

1. **`set_rig_location`** — Set the rig's fixed WGS84 location (lat/lon/height). Clears any prior sightings and solution.
2. **Aim and sight** — Using the camera feed and `jog` to fine-tune, aim at a well-known landmark (e.g., a distant building or mountain), then call **`sight_landmark`** with its lat/lon/height and optional label. Capture the *current* pan/tilt as a sighting.
3. **Repeat** — Aim at a second landmark well-separated in azimuth (ideally >15° apart) and call `sight_landmark` again. Two sightings are required.
4. **`solve_calibration`** — Solves the mount's 3D orientation (heading and level) from the two sightings using TRIAD. Reports landmark separation (warn if <15°), heading, and base tilt. The solution is persisted to disk.
5. **`point_at`** or **`point_at_azel`** — Once calibrated, point at any geographic target or absolute azimuth/elevation. Blocks until arrival.

### Tools

| Tool | Purpose |
|---|---|
| `set_rig_location` | Set the rig's WGS84 position (lat, lon, height_m); clears sightings. |
| `sight_landmark` | Record the *current* pan/tilt as a sighting of a landmark (aim first via live feed + jog). Returns sighting slot (1/2 or 2/2). Warns if rig was moving. |
| `solve_calibration` | TRIAD-solve the mount orientation from two sightings. Reports heading (°), base tilt (°), and landmark separation (°). Persists solution. |
| `point_at` | Point at a geographic target (lat, lon, height_m). Requires calibration. Returns azimuth, elevation, range, and final pan/tilt. |
| `point_at_azel` | Point at absolute azimuth/elevation. Requires calibration. Returns final pan/tilt. |
| `get_calibration` | Report the full calibration profile: rig location, sightings, solved orientation, timestamp. |
| `clear_calibration` | Erase the calibration profile. |

### Documented Assumptions

- **Height datum**: Rig height and target heights *must* share the same vertical datum (both WGS84 ellipsoidal or both orthometric MSL). Mixing datums introduces a constant bias. The code does not model geoid separation because it cancels locally.
- **Out of scope**: Atmospheric refraction and lever-arm offset (distance from mount zero to camera). Both are small for typical applications (<0.5° refraction near horizon, <0.1° lever-arm error on distant targets).

## Target tracking (layer 3)

Continuously follow a **moving** geographic target. Requires a solved layer-2 calibration.

Unlike every other tool here, the tracking tools **return immediately** — tracking runs in the
background (a control loop at `trackTickHz`) and outlives the call. Poll `get_tracking_status` to
see how it's doing. Tracking drives the rig the same way `jog` does (a rate vector), so it is
subject to the same mode-gating described above — the rig has to be on the point-setting screen
for tracking motion to actually happen.

### Workflow

1. **Calibrate** (layer 2) — `set_rig_location`, two `sight_landmark`s, `solve_calibration`.
2. **`start_tracking`** with the target's lat/lon/height, ideally plus `speed_mps` + `heading_deg`
   (+ `climb_mps`). The rig slews to acquire (a `goto`), then switches to rate-tracking (a `jog`
   vector). A `speed_mps` given without `heading_deg` drops the *entire* stated velocity for that
   call, `climb_mps` included; `climb_mps` alone is a valid pure-vertical velocity only when
   `speed_mps` is omitted entirely.
3. **`update_target`** with each new fix; this refreshes the deadman. **A stated velocity is not
   remembered across calls** — every `start_tracking`/`update_target` call replaces the stated
   velocity outright, including replacing it with "none" if that call omits `speed_mps`/
   `heading_deg`. Whenever no velocity is stated on a given call, the estimator silently falls back
   to deriving velocity from the two most recent fixes instead, which is noisier. To keep tracking
   running on a stated velocity, resend `speed_mps` + `heading_deg` (and `climb_mps`, if used) on
   *every* `update_target` call, not just the first.
4. **`get_tracking_status`** to read state, target az/el/range, rig pan/tilt, and the **measured**
   pointing error.
5. **`stop_tracking`** when done. The layer-1 `stop` tool also ends tracking before halting the
   device — `stop` always wins.

### Tools

| Tool | Purpose |
|---|---|
| `start_tracking` | Begin following a target: `lat`, `lon`, `height_m` (required), optional `speed_mps`, `heading_deg`, `climb_mps`, `label`. Returns immediately. |
| `update_target` | Feed a new fix for the target being tracked (same fields as `start_tracking` minus `label`). Refreshes the deadman. |
| `get_tracking_status` | State, wait reason (if any), label, target az/el/range, target & rig pan/tilt, measured pointing error, commanded pan/tilt rates, target/telemetry data age. |
| `stop_tracking` | End the session and halt tracking motion. |

### States

`acquiring` (slewing onto the target) → `tracking` (rate servo) ⇄ `waiting` (motion stopped,
still estimating) → `stopped`. A `waiting` status carries a `reason`: `below_tilt_limit`,
`pan_limit`, `target_stale`, `telemetry_stale`, `program_engaged`, or `not_calibrated`. It
auto-reacquires (drops back to `acquiring`) once the target is reachable and fresh again, or once
pointing error exceeds `trackReacquireDeg` while tracking.

### Arbitration

Tracking and manual control cannot fight over the rig: while a tracking session is active,
`goto_angle`, `jog`, `set_home`, `point_at`, and `point_at_azel` all refuse with `"tracking
active; stop_tracking first"`. `stop` is deliberately **not** guarded — it is the escape hatch and
always wins, stopping tracking and halting the device in one call.

### Safety

Tracking is the only thing here that commands sustained motion with **no human in the loop**, and
the rig has **no endstops**, so several independent layers back it up:

- **Soft-limit prediction**: the jog path itself does not enforce pan/tilt soft limits (see
  Tools above); the tracking session does, checking the *predicted* position a few ticks ahead
  and zeroing that axis before it would cross a limit.
- **Stale-data gates**: stale device telemetry (`trackStaleTelemetryMs`), a stale target fix
  (`trackMaxTargetAgeMs`), or an engaged program all move the session to `waiting` and stop
  motion.
- **Deadman**: `trackDeadmanMs` of total silence (no `update_target`/activity) ends the session
  outright.
- **Daemon-side jog TTL watchdog**: every commanded rate carries a TTL (`jogVectorTtlMs`); the
  daemon's keep-alive refuses to re-send a vector past its expiry and zeroes the rig instead. This
  watchdog lives in the device client, independent of the tracking control loop, so it still fires
  if a tracking tick stalls or throws.
- **Firmware-side joystick deadman**: independently of the daemon, the firmware itself stops
  honoring joystick data 750ms after the websocket goes quiet — a second, lower-level backstop.

### Accuracy

v1 does not promise a pointing-accuracy figure — the stance here is "measure and report,
best-effort." `get_tracking_status` reports the measured `pointing_error_deg` every tick; use it
to judge how well tracking is doing for your rig and calibration. A closed-loop **simulation**
(not hardware) holds pointing error under 0.5° against an idealized mock jog model that changes
rate instantaneously; the real rig ramps to its plateau rate over roughly a second, which bounds
achievable correction bandwidth to roughly 1Hz, so real-hardware error should be expected to run
higher than the simulation. **No accuracy claim has been validated on the physical rig.** If
tracking looks off, check layer-2 calibration quality first, then tune `trackKp`, and confirm
`maxJogDps` still matches the rig (re-run the jog probe if the hardware has changed).

## Connect a client

Point any MCP client at `http://<host>:8770/mcp` (streamable HTTP). Example Claude Desktop
config entry:

```json
{ "mcpServers": { "tb3": { "url": "http://localhost:8770/mcp" } } }
```

## Always-on

- macOS: edit paths in `deploy/tb3-mcp.plist`, then `launchctl load -w ~/Library/LaunchAgents/tb3-mcp.plist`.
- Linux/Pi: edit `deploy/tb3-mcp.service`, then `systemctl enable --now tb3-mcp`.
