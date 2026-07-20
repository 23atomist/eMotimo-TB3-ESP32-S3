# TB3 Operations Dashboard — Design

**Status:** approved design, pre-implementation
**Branch:** `feat/ops-dashboard` (off `main` @ 6cbfa2c)
**Goal:** A rudimentary-but-useful single-page operations dashboard, running on the host, that (a) shows how the whole TB3 system is working at a glance and (b) drives operations — calibration, manual/autonomous tracking, and an emergency stop.

## Context

The TB3 system now spans: the ESP32 rig firmware, the `tb3-mcp` MCP daemon (rig control + geo + tracking + sun-guard + ADS-B target source), the `tb3-agent` autonomous tracker, `readsb` (ADS-B), and a Nikon D5000 camera (gphoto2/PTP) — all on the host `192.168.4.104`. There is no single view of it. This dashboard is that view plus a control surface. It holds **no rig state of its own**: it aggregates from the existing services and issues control actions through them.

The `tb3-mcp` daemon exposes rig/tracking/ADS-B/calibration state and control **only over MCP** (`:8770/mcp`, no plain HTTP), so a browser cannot talk to it directly; a small backend is required regardless (and the camera + `systemctl` need a process anyway).

## Architecture — a separate service (Approach A)

A new **`tb3-dashboard`** service in the `tb3-mcp` monorepo (reuses `config.ts`, the `McpRigClient` pattern, the vitest infra), deployed as its own systemd unit. It is **isolated from the rig-control daemon**: the daemon is safety-relevant and drives the rig; keeping the (camera-subprocess-heavy) dashboard in its own process means a dashboard/ffmpeg crash cannot take down tracking. The **E-STOP goes direct to the firmware**, so it fires even if the daemon is wedged.

```
Browser (SPA)  ──HTTP/SSE──►  tb3-dashboard (Node/Express, :8788)
   │  <img> MJPEG                     │
   │                                  ├─ MCP client → tb3-mcp :8770/mcp  (tracking, ADS-B, calibration, control tools)
   └───────────────────────────────  ├─ HTTP → ESP32 /api/status         (rig telemetry + "alive")
      /camera/stream (MJPEG)          ├─ HTTP → ESP32 /api/stop           (E-STOP, direct)
                                      ├─ shell → systemctl                (service status; agent on/off)
                                      ├─ HTTP → readsb aircraft.json       (raw ADS-B)
                                      └─ subprocess → gphoto2 | ffmpeg     (camera MJPEG)
```

### Components (backend, `tb3-mcp/src/dashboard/`)
- **`server.ts`** — Express `main()`: serves the SPA, `GET /api/state` (snapshot), `SSE /api/stream` (live feed), `POST /api/control/*` (actions), `GET /camera/stream` (MJPEG).
- **`aggregator.ts`** — every ~1 s builds one `DashboardState` by merging all sources; pushes it over SSE. A **pure merge function** is the unit-testable core.
- **`services.ts`** — `systemctl is-active`/`show` for `readsb` / `tb3-mcp` / `tb3-agent` / `llama-server`; start/stop `tb3-agent`.
- **`rig.ts`** — direct ESP32 `/api/status` poll + `/api/stop` (e-stop).
- **`camera.ts`** — the gphoto2→ffmpeg MJPEG streamer with the still-fallback (see Camera).
- **`controls.ts`** — maps dashboard actions to MCP tools (track / stop / jog / calibration) + direct-firmware e-stop + systemd agent toggle.
- **MCP client** — a small extension of the existing `McpRigClient` adding `get_status`, `get_calibration`, `set_rig_location`, `sight_landmark`, `solve_calibration`, `jog`, reusing its `resultText`/`isError` handling.

### Frontend (`tb3-mcp/dashboard/public/`)
A **dependency-free vanilla SPA** (`index.html` + `app.js` + `style.css`), no build step. Renders the SSE state; posts controls.

## Data flow & real-time

**One aggregated snapshot, pushed on a timer.** Every ~1 s the aggregator merges all sources into `DashboardState` and pushes it over SSE; the browser replaces its view (no client-side diffing).

`DashboardState` (≈1–2 KB JSON):
- `services` — `{readsb, tb3mcp, tb3agent, llama}` each `active|inactive|failed|unknown`
- `rig` — `{connected, panDeg, tiltDeg, moving, batteryV, imu, telemetryAgeMs}`
- `mode` — derived: `idle` / `manual` / `autonomous` (from tracking state + whether `tb3-agent` runs)
- `tracking` — `{state, hex, callsign, targetAzDeg, targetElDeg, targetRangeM, pointingErrorDeg, panLimited, tiltLimited}`
- `calibration` — `{calibrated, rig, sightings, solvedAt}`
- `adsb` — `{rawCount, trackable: [enriched aircraft from scan_aircraft]}`
- `sunGuard` — `{state, locked, separationDeg}`

**Transport split:**
- `GET /api/state` — initial snapshot; `SSE /api/stream` — the live feed (full snapshot per tick).
- `POST /api/control/{track|stop|estop|agent|jog|calibrate/*}` — actions return `{ok, message}`; the next SSE tick shows the effect.
- `GET /camera/stream` — a **separate** `multipart/x-mixed-replace` MJPEG feed (browser `<img src>`), independent of the SSE JSON.

**Graceful degradation is the core principle.** Each source is polled in its own try/catch — a source that is down marks *its* field unavailable/stale and the rest keep updating. The aggregator never throws.

## UI layout — camera-centric cockpit (Layout A)

- **Top bar:** the **MODE** indicator (idle / manual / autonomous), **service status LEDs** (readsb / daemon / agent / llama), and the **E-STOP** button.
- **Main (left, dominant):** the **live camera** feed, with the **jog D-pad** directly beneath it (the aim workspace, reused by calibration).
- **Right rail (compact):** **rig telemetry** (pan/tilt/moving/battery/IMU/connected), **tracking** (current target hex/callsign/az/el/range/pointing-error), the **ADS-B list** (trackable aircraft, each with a Track button), and the **calibration** panel.

## Controls & safety

**E-STOP** — big, always-visible, red, top bar. One click fires immediately (no confirm dialog). The backend does three independent things in parallel so no single failure defeats it:
1. **POST directly to ESP32 `/api/stop`** (hard rig stop; works even if the daemon is down);
2. **`stop_tracking`** via the daemon (end the session so it won't re-command);
3. **`systemctl stop tb3-agent`** (kill the autonomous decider).

It returns per-action success/failure (UI shows what stopped), then latches to a **"STOPPED"** state that requires an explicit **clear/resume** before motion controls re-enable.

**Everyday controls** (all rig motion goes *through the daemon*, so sun-guard / pan-tilt limits / deadman still apply — the dashboard cannot bypass them; the direct e-stop is a stop, always safe):
- **Manual track** — click an aircraft in the ADS-B list → `track_aircraft`; **Stop tracking** → `stop_tracking`.
- **Agent toggle** — switch → `systemctl start/stop tb3-agent`; the mode indicator follows it.
- **Jog** — D-pad nudges pan/tilt via `jog`, for aiming; disabled/labeled when sun-locked (with the reason).
- **Sun-lock is surfaced prominently** — motion controls show a locked state + reason, never a silent failure.

**Calibration flow** (a guided step-panel reusing the camera + jog):
1. Enter rig **lat/lon/height** → `set_rig_location`.
2. **Aim at landmark 1** with the jog while watching the live feed, enter that landmark's lat/lon/height, **Sight** → `sight_landmark`.
3. Repeat for **landmark 2**.
4. **Solve** → `solve_calibration` → shows heading / base-tilt / separation. (Plus a **clear calibration** escape hatch.)

**Exposure/auth:** bound to the host LAN interface. **No auth by default** (rudimentary, trusted LAN), but gate-able behind the daemon's existing shared token (`mcpToken`) via one config flag, since motion + e-stop are exposed.

## Camera streaming

`camera.ts` owns the gphoto2 pipeline as a supervised subprocess:
- **Prerequisite (setup):** release the `gvfs-gphoto2-volume-monitor` claim so gphoto2 can open the camera (mask the gvfs monitor / free the device); documented in deploy notes.
- **Liveview first:** try `gphoto2 --capture-movie --stdout` → ffmpeg → MJPEG; if the D5000 only yields preview frames, fall back to a `--capture-preview` loop muxed to MJPEG.
- **Still-fallback:** if fps drops below a threshold or streaming fails, serve one fresh `--capture-preview` JPEG every ~1–2 s.
- **One shared encoder, fanned out** to all browsers (the camera is a single physical resource; never per-client).
- **Idle when unwatched** — stop the stream at zero viewers, start on first connect (saves the D5000 battery, reduces wear).
- **Never hangs the `<img>`** — camera absent/busy → a "camera unavailable" placeholder frame; bounded auto-restart on crash.
- On-host during build: confirm the D5000's real fps, then settle liveview-vs-fallback.

## Testing

The dashboard is mostly glue, but the logic that matters is unit-testable (vitest, `fileParallelism:false`, no `any`, matching the daemon's conventions):
- **Aggregator merge fn** — mocked source results → correct `DashboardState`, correct **mode derivation** (idle/manual/autonomous), correct **graceful degradation** (a failed source → its field unavailable, others intact).
- **Control mapping** with a mock client — each action hits the right tool; the **e-stop fan-out** fires all three actions, aggregates per-action results, and one failure doesn't abort the others.
- **Parsers** — `systemctl`, readsb JSON, gphoto2 output → pure fns with fixtures.

The camera stream, live SSE, and the browser SPA are verified by **on-host manual testing** (same bar as the firmware bench + the ADS-B integration). No automated E2E for v1.

## Config additions (Zod + file + env, matching `config.ts`)
`dashboardPort` (8788), `dashboardBind` (LAN interface / `0.0.0.0`), `dashboardAuth` (bool, default false — reuse `mcpToken` when on), `cameraFps` target, `cameraFallbackMs` (still-refresh interval), `cameraDevicePort` (gphoto2 usb port, optional). `readsbUrl` reuses `adsbUrl`. The dashboard reads the daemon's config for `deviceHost`/`deviceIpFallback` (rig IP), `mcpPort`/`mcpToken`, `adsbUrl`.

## Success criteria
1. `tb3-dashboard` builds clean; opens in a browser on the host LAN; shows live service status, rig telemetry + connectivity, mode, tracking, calibration state, and the trackable ADS-B list — each panel degrading gracefully when its source is down.
2. Controls work end-to-end: manual track from the list, stop, the agent on/off toggle, and calibration (location → two sightings → solve).
3. **E-STOP** halts the rig via the firmware directly even with the daemon stopped, also ends tracking and the agent, and latches until cleared.
4. The camera panel shows live video (or the still-fallback) from the D5000, idling when unwatched.
5. Unit suites green (aggregator/mode/controls/parsers); daemon's existing 274 tests unaffected.

## Out of scope (v1)
No full ADS-B map (link out to tar1090), no camera shutter/recording control (view-only), no historical logging/recording, no multi-camera, no per-user auth (shared token only).
