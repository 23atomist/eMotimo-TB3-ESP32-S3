# TB3 MCP Control Foundation — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design)
**Layer:** 1 of 3 (`mcp-control`)

## Goal

A standalone, always-on **TypeScript/Node daemon** that exposes the eMotimo
TB3 (ESP32-S3) to any LLM through the **Model Context Protocol**, so an LLM can
read the rig's state and drive it — read status, jog, stop, set home, run/select
built-in programs, and **move to an absolute pan/tilt angle**. This is the
control foundation that the geographic-pointing and object-tracking layers build
on top of.

## Where this sits: the three-layer roadmap

This is one program of work delivered as three sequenced specs, each producing
working, demonstrable software:

1. **`mcp-control` (this spec)** — MCP daemon + reliable control primitives,
   including a firmware absolute-goto endpoint and homing. Demonstrable on its
   own: an LLM slews the rig to a commanded angle and reads back where it landed.
2. **`geo-pointing` (future)** — calibration workflow (rig lat/long/height,
   heading/north reference, tilt zero) + coordinate math converting a target
   lat/long/height into azimuth/elevation into pan/tilt. Calls this layer's
   `gotoAngle()`.
3. **`target-tracking` (future)** — closed-loop follow of a moving object, using
   host-side continuous rate control over the telemetry feed. Builds on 1 and 2.

Layer 1 is designed so 2 and 3 add tools to *this same daemon*, reusing its
device link, telemetry cache, and `gotoAngle()` primitive.

## Hardware reality that constrains the design

The TB3 has **no GPS, no compass/magnetometer, no IMU, and no absolute
encoders.** "Home" is a pure software zero (`set_position(0,0,0)`), and position
is *step-counted* (open-loop) from that origin. Consequences carried by this
spec:

- Position drifts over long sessions and after mechanical slips; the operator
  re-homes with `set_home`. There is no way to recover absolute truth otherwise.
- There are **no endstops**; an out-of-range move can wind cables or over-rotate.
  The daemon therefore enforces configurable soft motion limits (§ Safety).
- The rig cannot know its geographic pose on its own — that is a layer-2
  calibration problem, out of scope here.

## Architecture

The daemon is two components in one process:

- **Device client** — holds one persistent link to the TB3. Subscribes to the
  5 Hz WebSocket telemetry (`pos` in steps, `moving`, `program_engaged`,
  `battery_v`, program state) and caches last-known state so tools answer
  instantly without round-tripping the device. Issues commands over HTTP
  (`/api/goto`, `/api/stop`, `/api/program`) and the joystick WebSocket
  (`/ws`). Auto-reconnects on drop.
- **MCP server** — streamable **HTTP/SSE** transport. Any MCP client on the LAN
  connects and calls the tools in § Tool Surface.

```
LLM client ──MCP / HTTP+SSE──▶  tb3-mcp daemon  ──HTTP + WS──▶  TB3 (ESP32-S3)
                                 · device state cache            /api/goto (new)
                                 · command serializer            /api/stop
                                 · safety-limit enforcement      /ws joystick
                                 · driver-lock (optional)        5 Hz telemetry
```

The daemon is the single source of truth for "where is the rig / who is
driving." It lives in a new `tb3-mcp/` directory at the repo root (firmware and
daemon in one repo).

## Units and angle conventions

- **Angles are degrees relative to software home.** `set_home` defines
  `(0, 0)`. Conversion to/from device steps uses `STEPS_PER_DEG = 444.444`.
- **Sign convention:** pan `+` = clockwise viewed from above; tilt `+` = camera
  points up; `aux` = the raw third axis, passed through without interpretation.
  Each axis has a configurable sign flip so the operator can match the physical
  rig once.
- **Speed is degrees per second (`speed_dps`)**, clamped to `max_speed_dps`. The
  firmware maps deg/s onto its internal feedrate.

## Firmware changes

Two additions, both small; everything else the daemon needs already exists
(jog via the joystick `/ws`, stop via `/api/stop`, program run/select via
`/api/program`).

### 1. `POST /api/goto` (the substantive one)

Request body: `{ "pan_deg": <float>, "tilt_deg": <float>, "speed_dps": <float?> }`.

Behavior:

- Convert degrees → steps (`× 444.444`), command the device's existing
  coordinated-move + accel/decel engine to the absolute target.
- **Stay stop-interruptible during the move:** the firmware has no pattern for
  pumping the full input path inside a blocking `while(motorMoving)` loop (the
  program's comms-alive path is a *non-blocking* state machine). Rather than
  restructure the 2015 state machine, the move runs as a blocking loop that
  drains only a pending `/api/stop` each iteration, so stop still interrupts it.
  Outbound 5 Hz telemetry keeps flowing from its own core-0 task; the LCD/menu
  freezes for the (usually brief) duration of the discrete move — an accepted
  tradeoff, since the device is "busy" during a commanded move anyway.
- **Safety gate:** reuse the OTA gate pattern — reject with `409` and
  `{"error":"busy - program engaged"}` if `Program_Engaged`. Interruptible at
  any time by `/api/stop`.
- **Response:** `202 {"ok":true}` once the move is accepted and started (not
  when it finishes). The daemon detects completion from telemetry.

### 2. `POST /api/home` (tiny)

Zeroes the software origin by calling the existing `set_position(0,0,0)`. There
is no current web path for this, so it is a small new endpoint. Rejected with
`409` while a program is engaged, for the same reason as goto.

Keeping home on the device (rather than a host-side virtual offset) means the
daemon, the LCD, and the built-in programs all share one origin — and a device
reboot can't leave the daemon's idea of "home" silently stale.

**Dependency:** `/api/goto` is deployed over the OTA path built on branch
`feat/ota-lcd-ui`, which is not yet hardware-verified. The first `/api/goto`
deploy is also the first real-world OTA test; an OTA defect would surface here.

## MCP tool surface

All inputs validated with zod; angles and speeds are checked against the safety
envelope before any command is issued (out-of-range → tool error, never a silent
clamp).

| Tool | Args | Behavior |
|---|---|---|
| `get_status` | — | Cached device state: position (deg), `moving`, `battery_v`, `program_engaged`, connectivity (`sta_ip`, connected) |
| `goto_angle` | `pan_deg`, `tilt_deg`, `speed_dps?` | Absolute coordinated move. **Blocks until arrival or timeout**, then returns final position |
| `jog` | `pan_dps`, `tilt_dps`, `aux?`, `duration_ms` | Timed rate nudge via the joystick path, for manual framing. Rate is best-effort: the joystick path is open-loop, so `dps` maps approximately (calibratable), not exactly |
| `stop` | — | Immediate stop; cancels any in-flight move and clears the queue; always wins |
| `set_home` | — | Zero the current position (software origin) |
| `list_programs` | — | The 8 built-in program names + current index + whether selectable |
| `select_program` | `index`, `commit?` | Highlight program 0..7; `commit:true` enters it (virtual C-press). No separate `run_program` — the device has no clean run-to-completion web command, so entering via `commit` is as far as the existing API goes |
| `trigger_camera` | `action` (`shoot`\|`focus`), `ms?` | Fire the shutter (`shoot`) or focus for `ms`, via the existing `/api/camera` |

### `goto_angle` completion semantics

The firmware endpoint is fire-and-forget; the tool provides the synchronous
experience. After a `202`, the daemon polls the 5 Hz telemetry until
`moving == 0` **and** `|pos − target| < tolerance` (default `0.2°` per axis), or
until a timeout of `distance / speed_dps × 1000 + 3000 ms`. On timeout it returns
an error carrying the last-known position. On success it returns the final
position in degrees.

## Safety, concurrency & limits

- **Soft motion limits** — `pan_min/max`, `tilt_min/max` (degrees), and
  `max_speed_dps`, enforced daemon-side on every `goto`/`jog`. Because there are
  no endstops, an out-of-range request is **refused with an error the LLM sees**,
  not silently clamped. Defaults are conservative placeholders (`pan ±180°`,
  `tilt ±90°`, `max_speed_dps 30`) that the operator confirms/edits; layer-2
  calibration populates the true reachable range. The daemon logs the active
  limits at startup.
- **Concurrency** — one physical rig. For the foundation, serialization is
  enforced at the **firmware busy-gate**: a `goto`/`home` while `motorMoving` or
  a program is engaged returns `409`, so a second motion command can't corrupt an
  in-flight one. `stop` always lands (it's drained even mid-move). A daemon-side
  command queue with *supersede* semantics, and an optional **driver lock**, are
  deferred as non-foundation niceties (single-operator use doesn't need them).
- **Physical remote** — the nunchuck/gamepad can always move the rig in hardware,
  outside the daemon's control. The daemon detects the resulting motion via
  telemetry and reports it in `get_status`; it does not fight it.

## Config & packaging

Single config file `tb3-mcp/config.json`, every key overridable by environment
variable:

- `device_host` (default `tb3.local`, with an IP fallback field)
- `mcp_port` (HTTP/SSE listen port)
- `mcp_token` (optional bearer token for the MCP endpoint; **off by default** on
  a trusted LAN, documented and recommended for shared networks)
- `pan_min`, `pan_max`, `tilt_min`, `tilt_max`, `max_speed_dps`
- `pan_sign`, `tilt_sign`, `aux_sign`

Runs as `node dist/server.js`. The repo ships a **launchd plist (macOS)** and a
**systemd unit template (Linux/Pi)** for the always-on story, plus a README.

## Testing strategy

- **Unit (host, no device):** steps ↔ degrees conversion, per-axis sign flips,
  limit checking and refusal, deg/s → joystick-rate mapping, and every tool's
  zod input schema.
- **Integration:** a **mock TB3** — a fake HTTP + WS server implementing
  `/api/status`, `/api/goto`, `/api/stop`, `/api/program`, `/ws`, and the 5 Hz
  telemetry push (including simulated motion so `goto_angle` completion logic is
  exercised). The whole daemon is tested end-to-end with no hardware. This mock
  is reused by layers 2 and 3.
- **MCP contract:** tools are registered with correct schemas, verified via the
  SDK's in-memory transport.
- **Firmware:** `/api/goto` gets a manual on-hardware test — move to a known
  angle and confirm arrival — plus the program-engaged rejection check.

## Out of scope (future specs)

- Geographic pointing (lat/long/height → az/el) and its calibration workflow.
- Moving-target tracking and any host-side closed-loop follow controller.
- Discovering the true pan/tilt mechanical range (done during layer-2
  calibration; layer 1 ships conservative default limits).

## Open items / dependencies

1. **OTA hardware verification** — `/api/goto` rides the OTA path from
   `feat/ota-lcd-ui`, not yet verified on hardware. First goto deploy validates it.
2. **Branch strategy** — this work depends on the OTA firmware; the branch for
   implementation is decided at plan time (merge OTA first vs. branch from it).
3. **Pan/tilt reachable range** — measured in layer 2; layer 1 uses conservative
   default soft limits until then.
