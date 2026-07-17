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

### Web motion is mode-gated on the rig — use "Track (Web)"

The rig only wires the web joystick into actual motor output on screens whose input loop runs
`NunChuckQuerywithEC()` and `updateMotorVelocities2()` with the step ISR armed. On any other
screen the same input drives menu navigation instead, so **`goto_angle`, `jog`, and tracking will
report success but the rig will not move — no error, no hint, just silence.** In Dragonframe slave
mode the firmware runs a separate blocking loop that doesn't pump the web input path at all, so
`jog`, `goto_angle`, and even `stop` are all dead. **If a command stops moving the rig, check the
rig's own LCD screen first.**

**This is why a dedicated "Track (Web)" mode exists** — program index **8**, the last entry in the
rig's program menu (`select_program` with `index: 8, commit: true`, or pick it on the LCD). It
runs the velocity engine on a screen of its own, so tracking motion just works and stays working.
Use it for anything driven by layer 3.

> ✅ **Hardware-verified 2026-07-16** (camera removed). Selected purely over HTTP
> (`POST /api/program {"type":8,"select":true}`); LCD showed `Track (Web)` + the STA IP; jog moved
> the rig at 2.05 °/s at deflection 50 against a cubic-model prediction of 2.02; **a `goto`
> followed by a jog still moved** (the step ISR is correctly re-asserted — this was the mode's
> main design risk); and C+Z exited to the menu without bouncing back in. Two behaviours to know:
> `/api/stop` does **not** halt a jog (see below), and the exit is deferred while a `goto` is
> in flight, so send it once the rig is idle. Tracking a real moving target end-to-end has still
> not been done.

The gating detail is still worth knowing for diagnosing "the rig silently doesn't move" on the
other screens. The point-setting screens do pump the web input path: **"Move to Start Pt"** /
**"Move to End Pt."** (`Move_to_Startpoint()` / `Move_to_Endpoint()`, `src/_TB3_LCD_Buttons.ino`),
**"Move to Point"** (`Move_to_Point_X()`, `src/_TB3_LCD_Buttons.ino:452-506` — reached from
3-point moves, the panorama corner point, and the portrait-pano subject point), and **"Set Angle
o'View"** (`Set_angle_of_view()`, `src/TB3_PANO.ino:69-113`). They are not, however, a substitute
for Track (Web): a stray C press advances the program and silently kills tracking. (Note these
screens do not each call `DFSetup()` themselves — "Move to End Pt." only calls `startISR1()` and
inherits the rest of the motion setup from the "Move to Start Pt" screen that always precedes it.)

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
subject to the same mode-gating described above: **put the rig in "Track (Web)" (program index 8)
before tracking.** Any other screen either ignores the rate vector entirely or, on the
point-setting screens, honours it only until a stray C press advances the program and silently
kills tracking.

**`POST /api/stop` halts a jog and latches the web joystick at centre.** The latch matters: a stop
that only zeroes the rig's stored jog vector is a no-op against a client that streams one
continuously — which is exactly what the tracking servo does at `trackTickHz`. The stop would
land, and the client's next frame ~100ms later would re-apply the old vector. (That was the real
behaviour until 2026-07-16: the endpoint returned `200 {"ok":true}` and the rig kept going.)

Now the rig holds the web joystick at centre and **releases only when the client sends a centred
frame** — you must let go before you can drive again. Verified on hardware against a client
deliberately pumping `x=50` straight through the stop: motion ceased within ~0.4°, drifted 0.00°
over the next 1.5s while still being commanded, released on a centred frame, and drove again.

`/api/status` reports `joy_latched` so a latched rig doesn't look like a silently broken one. The
latch is scoped to the web path, so it can't lock out a physical gamepad operator. Layer 3's
`stop_tracking` / `stop` tools don't depend on any of this — `session.stop()` zeroes the vector and
stops the pump, which releases the latch on its own — but `/api/stop` is now a real emergency stop
rather than a suggestion.

Two other things stop a jog regardless: the daemon's `jogVectorTtlMs` watchdog and the firmware's
750ms joystick deadman.

### Workflow

0. **Select the mode** — `select_program` with `index: 8, commit: true` (or choose "Track (Web)"
   on the rig's LCD). `list_programs` reports the current mode and the full menu.
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
| `get_tracking_status` | State, wait reason (if any), label, target az/el/range, target & rig pan/tilt, measured pointing error, commanded pan/tilt rates (plus `pan_limited`/`tilt_limited` if the soft-limit guard is holding that axis at zero), target/telemetry data age. |
| `stop_tracking` | End the session and halt tracking motion. |

### States

`acquiring` (slewing onto the target) → `tracking` (rate servo) ⇄ `waiting` (motion stopped,
still estimating) → `stopped`. It auto-reacquires (drops back to `acquiring`) once the target is
reachable and fresh again, or once pointing error exceeds `trackReacquireDeg` while tracking.

A `waiting` status carries a `reason`:

| reason | meaning |
|---|---|
| `below_tilt_limit` / `pan_limit` | the target is outside the configured soft limits |
| `target_stale` | no fix newer than `trackMaxTargetAgeMs` — send `update_target` |
| `telemetry_stale` | the *rig* has gone quiet for `trackStaleTelemetryMs`; a real fault — check the link |
| `program_engaged` | a built-in program is running; tracking yields to it |
| `not_calibrated` | no solved layer-2 orientation |
| `device_busy` | the rig refused the acquire goto (HTTP 409) because it was still moving or a program was engaged. **Routine and self-healing** — the rig accepts a goto only once stopped, and it needs ~450ms to decelerate out of a jog, plus up to 200ms before the daemon even sees `moving` go false (the rig's telemetry is 5Hz — see Accuracy, below). Expect this in passing on a catch-up; it clears itself within roughly **650ms, about 6-7 ticks** at the default 10Hz tick rate — not "a tick or two". |
| `goto_failed` | the acquire goto failed for a real reason — arrival timeout, transport error, or a device rejection that wasn't a 409 |

`device_busy` and `telemetry_stale` are deliberately separate: a reacquire that catches the rig
mid-deceleration is normal operation, and reporting it as stale telemetry would blame a perfectly
healthy link.

### Arbitration

Tracking and manual control cannot fight over the rig: while a tracking session is active,
`goto_angle`, `jog`, `set_home`, `point_at`, and `point_at_azel` all refuse with `"tracking
active; stop_tracking first"`. `stop` is deliberately **not** guarded — it is the escape hatch and
always wins, stopping tracking and halting the device in one call.

### Safety

Tracking is the only thing here that commands sustained motion with **no human in the loop**, and
the rig has **no endstops**, so several independent layers back it up:

- **Soft-limit prediction**: the jog path itself does not enforce pan/tilt soft limits (see
  Tools above); the tracking session does, checking the *predicted* position ahead of the rig and
  zeroing that axis before it would cross a limit. The lookahead is **computed, not fixed**: it
  sums how stale the telemetry is, one tick period, and the firmware's actual ramp-down time for
  the rate being commanded (~450ms from the 19°/s plateau, derived from `updateMotorVelocities2`'s
  accumulator). That is ~750ms of lookahead when saturated — and near-zero cost when creeping,
  which a constant sized for the worst case could not manage. The guard reports which axis (if
  any) it is holding via `pan_limited`/`tilt_limited` in `get_tracking_status`, so a held axis is
  diagnosable instead of looking identical to "the servo is happy".
- **An aggressive `trackKp` can make the guard self-perpetuate near a limit.** The guard predicts
  forward from the *current* commanded rate; if `trackKp` is high enough (roughly **≥ 2.0**) that a
  legal target near a soft limit still produces a rate whose predicted stopping point overshoots
  it, the guard zeroes that axis every tick. Because the rig then doesn't move, the pointing error
  the next tick's rate is computed from is unchanged, reproducing the identical block forever. The
  default `trackKp = 1.0` converges instead of stalling. The symptom is `state: "tracking"` with
  `commanded_pan_dps`/`commanded_tilt_dps` pinned at `0` and the matching `pan_limited`/
  `tilt_limited` flag set — not a device fault, but the controller stuck against its own limit. If
  you tune `trackKp` up, watch for this near the edges of your configured pan/tilt range.
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
(not hardware) holds pointing error under 0.5°, but it flatters the rig in two known ways:

- **Instantaneous rate changes.** The mock's jog model changes rate the moment it is commanded;
  the real rig ramps to its plateau, and accel/decel share the same firmware constant (`accelmax`),
  so ramp-up and ramp-down take the same time. How long that is has two disagreeing answers, and
  this doesn't paper over the gap with a single confident number:
  - **Derived from firmware source** (the same derivation behind the limit-guard horizon in
    Safety, above): the velocity accumulator ramps at `accelmax = 65535/20 ≈ 3276.75` per 50ms
    cycle toward a full-scale value of `(95³/10000)×655.3×0.5 ≈ 28091.9`
    (`updateMotorVelocities2()`, `src/TB3_Nunchuck.ino`), and the accumulator maps linearly onto
    rate (`v = 20·speed/65.536`, `src/TB_DF.ino:593`). That's ~8.6 cycles, or **~430-450ms**,
    0→plateau.
  - **Measured on the rig** (Task 0, `scripts/jog-probe.mjs 192.168.4.87 100 6`): the instantaneous
    rate profile suggested roughly **twice that, ~1s**, to plateau. Take that as an upper bound,
    not a correction — it was sampled from the rig's 5Hz telemetry (200ms resolution), so a 450ms
    ramp is only ~2 samples wide and easy to over-read on a coarse probe.
  - **Bench re-measurement** (2026-07-16, full deflection from rest) favours the derivation: the
    rig averaged 7.96 °/s across [0.20s, 0.40s] and was already at 18.7 °/s by t=0.79s. That is
    consistent with a ramp appreciably shorter than 1s, though 5Hz sampling still cannot resolve
    it precisely. Settling it properly needs a temporary firmware build with faster telemetry;
    until then, treat the ramp as **~0.5s, bounded above by ~1s**.

  The plateau itself is now confirmed on hardware: a 6s full-deflection hold covered **113.19°**,
  and distance carries no sampling error (accel and decel ramps cancel), giving ≥18.87 °/s; the
  clean instantaneous samples cluster at 18.7–19.2. `maxJogDps = 19.0` is correct. Note the probe's
  *median* still reads slightly high (19.6) because 5Hz aliasing spikes are one-sided — trust the
  distance figure over the profile.

  The bench session should settle which is right; until then, treat ~450ms as the better-supported
  figure (it falls straight out of firmware constants the rig actually runs) and ~1s as a
  coarse-probe ceiling. Achievable correction bandwidth is bounded somewhere between those —
  roughly **1-2Hz**, not a flat "~1Hz".
- **4× the telemetry rate.** The mock pushes state at **20Hz**; the real rig pushes at **5Hz**
  (`vTaskDelay(pdMS_TO_TICKS(200))`, `src/tb3_web.cpp`). The control loop ticks at 10Hz, so **on
  hardware every other tick re-reads a rig position it has already seen**, halving the P-term's
  effective feedback rate. The sim never sees a stale reading.

Real-hardware error should therefore be expected to run higher than the simulation.
**No accuracy claim has been validated on the physical rig.** If
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
