# MediaMTX + WebRTC Video Transport, with MCP-Driven Capture — Design

**Status:** design, approved 2026-07-26. Follow-on to the selectable camera source
(`docs/superpowers/specs/2026-07-25-camera-source-select-design.md`), all on `main`.

## Problem / goal

The dashboard streams video as MJPEG over `multipart/x-mixed-replace`: ffmpeg
copies the UVC camera's native JPEG frames to stdout, `CameraStreamer` fans them
out to a `Set<ServerResponse>`, and the browser holds a permanently-attached
`<img src="/camera/stream">`.

Three problems with that, in the operator's priority order:

1. **Image quality / bandwidth.** MJPEG has no interframe compression: every
   frame is a standalone JPEG. At 720p30 that is both soft and expensive. H.264
   at 1080p over the same link looks materially better — and matters now that a
   zoom lens is mounted on the rig.
2. **No recording or snapshots.** There is nowhere for frames to go except a live
   viewer. Capturing an aircraft pass is impossible.
3. **Robustness.** `CameraStreamer.writeChunk` ignores `res.write()`'s return
   value and never drops frames, so a slow viewer (a phone on roof wifi) buffers
   unboundedly in the dashboard heap — a self-inflicted OOM on a long watch,
   already flagged by the 2026-07-25 whole-branch review. The hand-rolled restart
   budget and fan-out are ours to maintain and ours to get wrong.

**Latency is explicitly not a goal.** WebRTC delivers low latency as a side
effect, but no design decision here trades anything away to chase it.

Introduce MediaMTX as the media server: ffmpeg publishes H.264 to it, browsers
consume WebRTC, and the MCP daemon drives recording and snapshots from tracking
state.

## Host capability

### Known (probed 2026-07-25, recorded in the camera-source-select spec)

The industrial UVC camera on host `/dev/video4` reports:

- `MJPG`: 1920×1080, 1280×720, 1280×960, 640×480, 640×360, 640×640 — all @30 fps
- `YUYV`: 640×480, 640×360 @30 fps

**There is no native H.264 mode.** A transcode from MJPEG to H.264 is therefore
required, not optional. `-c:v copy` is retained as a configurable encoder value
only so that a future camera with a native H.264 mode needs no code change.

Separately: the current `cameraV4l2Size` default is `1280x720` while the sensor
offers `1920x1080`. Raising the capture mode is part of the quality goal.

### Not yet probed — resolve during implementation

- **Whether the host's ffmpeg build includes NVENC.** The host has an RTX 5080,
  so `h264_nvenc` would make the transcode nearly free; without it, `libx264
  -preset veryfast` carries it on CPU. The default is the software encoder
  because it always works; NVENC is opt-in after confirming
  `ffmpeg -encoders | grep nvenc`.
- **Whether `ffmpeg` is installed at all.** Flagged as unconfirmed by the
  2026-07-25 spec and still unconfirmed.
- **The exact MediaMTX control-API route for a runtime record toggle.** MediaMTX
  v1.x exposes path config patching under `/v3/config/paths/patch/{name}`. The
  implementation must confirm this against the pinned version rather than trust
  this document.

The AI-PC host was unreachable on both `192.168.4.71` and `192.168.4.95` on
2026-07-26 (the rig ESP32 at `.56` answered), so none of the above could be
probed while writing this spec.

## Scope

**In scope:**

- A third capture path, `cameraSource: "mediamtx"`: ffmpeg reads V4L2, encodes
  H.264, publishes RTSP to a local MediaMTX.
- MediaMTX as a systemd service on the host, bound to loopback for HTTP.
- WHEP signaling reverse-proxied through the dashboard so the existing auth gate
  covers video; `<img>` becomes `<video>` fed by a small vanilla WHEP client.
- Splitting `src/dashboard/camera.ts` into a folder, extracting the shared
  restart/generation supervisor.
- MCP-driven capture in the daemon: recording gated on tracking state, one
  snapshot per acquisition, plus MCP tools for manual control.
- Recording retention policy.

**Out of scope (YAGNI):**

- A recordings browser UI, a snapshot gallery, or download links. Files land on
  disk; surfacing them is its own spec once real files exist on real disk.
- Camera controls (focus / zoom / exposure via `v4l2-ctl`). Orthogonal, and
  blocked on the same host probe.
- Audio. The camera has no useful audio and the rig is on a roof.
- Remote/WAN viewing, TURN servers, authentication inside MediaMTX. LAN only;
  MediaMTX's HTTP surface stays on loopback.
- Removing the MJPEG path. It is deliberately retained (see below).
- Adaptive bitrate / multiple quality ladders.

## Architecture

```
                     ┌──────────────────────────────────────┐
  /dev/v4l/by-id/… ──┤ ffmpeg  (spawned by the dashboard)    │
                     │   MJPEG in → H.264 out                │
                     └──────────────┬───────────────────────┘
                                    │ RTSP publish
                                    ▼  rtsp://127.0.0.1:8554/tb3
                     ┌──────────────────────────────────────┐
                     │              MediaMTX                 │
                     │   systemd service, always up          │
                     │   HTTP + control API on 127.0.0.1     │
                     └───┬──────────────┬───────────────┬────┘
              WHEP/UDP   │              │ record        │ RTSP
                         ▼              ▼               ▼
                   browsers      segments on disk   one-shot ffmpeg
                                                    → snapshot .jpg

  signaling proxied: browser → dashboard /camera/whep (token gate) → :8889
  media: browser ⇄ MediaMTX directly over UDP (ICE), not through the dashboard
```

### Three ownership lines, deliberately separate

| Concern | Owner | Trigger |
|---|---|---|
| **Arming** (device open/closed) | Dashboard | Start/Stop button |
| **Recording** (the valve) | MCP daemon | Tracking state |
| **Snapshots** | MCP daemon | Entering `tracking`, keyed by ICAO |

The camera lives in the dashboard; tracking lives in the daemon. The dashboard
connects to the daemon as an MCP client, and that arrow points one way only.
Rather than add a reverse arrow, **both processes talk to MediaMTX
independently** — they run on the same host and MediaMTX's control surface is
loopback HTTP. MediaMTX is the meeting point; neither process calls the other.

**Consequence, stated plainly:** the daemon gains a capture concern it does not
have today (a small MediaMTX control client and its config). That is the price of
MCP-owned triggers, which is what was asked for.

### Arming semantics

`Start` arms the camera: ffmpeg spawns and publishes **continuously**, whether or
not anyone is watching. `Stop` kills ffmpeg and releases the USB device.

This differs from the MJPEG path, which additionally refcounts viewers and tears
the pipeline down when the last one detaches. Ingest must not depend on viewers,
because recording an unattended aircraft pass is a primary goal. The single
behavioral difference is expressed as a predicate — see the supervisor below.

**Stop is a hard release.** If the rig locks onto an aircraft while the camera is
disarmed, capture is skipped and the reason is surfaced; nothing silently
re-opens the device.

### Why the dashboard owns ffmpeg rather than MediaMTX

MediaMTX can spawn its own ingest process via `runOnDemand`/`runOnInit`, and
arming could be done by patching path config through its control API. That was
rejected:

- `Spawner` (`start(onFrame, onExit) → { kill() }`) is already the abstraction
  point in this codebase, with two working implementations.
- Arming is already `enable()` / `disable()`.
- The restart budget, backoff, and generation counter are already written,
  already debugged, and already unit-tested against fakes.
- The genuinely dangerous part — ffmpeg argv, where **flag order silently
  changes behavior** — stays in a pure function that unit tests can pin. This is
  precisely the trap the v4l2 work hit: input options placed after `-i` are
  ignored, yielding the wrong pixel format rather than an error.

Handing ingest to MediaMTX would discard all of that in exchange for retry
semantics we cannot unit-test.

### Why the MJPEG path is retained

`cameraSource` gains a third value rather than replacing the existing two.
MediaMTX is a new hard dependency and a new single point of failure for video,
introduced on a rig that is physically on a roof, at a moment when five other
merged features are already awaiting on-rig verification. Retaining a known-good
path means recovery is one line in `config.json` plus a restart, instead of a
git revert and redeploy.

The cost is two live video paths in the tree. Accepted deliberately.

## Components

### Dashboard: `src/dashboard/camera.ts` → `src/dashboard/camera/`

At 455 lines and about to grow a third pipeline, the file splits. Everything
existing **moves unchanged**; only the last two entries are new code.

```
src/dashboard/camera/
  index.ts           re-exports, so existing import sites do not churn
  supervisor.ts      NEW  generation counter + restart budget, extracted
  mjpeg-streamer.ts       CameraStreamer (viewer-refcounted multipart fan-out)
  jpeg-parser.ts          JpegFrameParser
  mtplvcap.ts             mtplvcapSpawner
  v4l2.ts                 ffmpegV4l2Args + ffmpegV4l2Spawner
  rtsp.ts            NEW  ffmpegRtspArgs + ffmpegRtspSpawner
  publisher.ts       NEW  MediaMtxPublisher (arm-driven, no viewer refcount)
```

**`supervisor.ts`** extracts the subtle lifecycle logic that now has two
consumers: the generation counter that discards late `onFrame`/`onExit`
callbacks from a killed spawner, the 5-restarts-per-60s budget with window
forgiveness, and the backoff timer. It takes a *should this be running?*
predicate:

- MJPEG streamer answers `armed && viewers > 0`
- MediaMTX publisher answers `armed`

That predicate is the entire behavioral difference between the two pipelines.
Duplicating the supervision instead is how the two copies drift apart.

**`rtsp.ts`** — `ffmpegRtspArgs(cfg): string[]`, a pure function, sibling to the
existing `ffmpegV4l2Args`:

```
ffmpeg -hide_banner -loglevel error
       -f v4l2 -input_format mjpeg
       -video_size <cameraV4l2Size> -framerate <cameraV4l2Framerate>
       -i <cameraV4l2Device>
       <encoder args>
       -f rtsp -rtsp_transport tcp <cameraMediamtxRtspUrl>
```

Encoder args by `cameraEncoder`:

| Value | Args | Notes |
|---|---|---|
| `x264` (default) | `-c:v libx264 -preset veryfast -tune zerolatency -b:v <bitrate> -pix_fmt yuv420p` | Always available |
| `nvenc` | `-c:v h264_nvenc -preset p4 -tune ll -b:v <bitrate> -pix_fmt yuv420p` | Opt-in after probing |
| `copy` | `-c:v copy` | Only for a future natively-H.264 camera |

All input options precede `-i`, as they must. `-pix_fmt yuv420p` is required for
broad browser decode compatibility.

**`publisher.ts`** — `MediaMtxPublisher`: arms/disarms an `ffmpegRtspSpawner`
over the shared supervisor, and reports the same `CameraStatus` shape
(`enabled` / `streaming` / `viewers`) the dashboard already renders. `viewers` is
sourced from MediaMTX's path-reader count rather than a local `Set`, so the
status pipeline and its rendering need no change at all — the frontend work is
confined to the video element and its attach path.

### Daemon: `src/capture/`

```
src/capture/
  mediamtx-client.ts   control API: record on/off, path health, reader count
  snapshot.ts          one-shot ffmpeg grab → .jpg
  controller.ts        tracking state → capture policy
```

**`controller.ts`** holds the policy and is the most test-worthy new unit. It
observes `TrackState` transitions (`src/track/session.ts:16` —
`"stopped" | "acquiring" | "tracking" | "waiting"`) and the tracked aircraft's
ICAO:

- **Entering `tracking`** — the rig has slewed on and settled, so the aircraft is
  genuinely in frame. If the ICAO differs from the current pass's: take one
  snapshot, and turn recording on.
- **Leaving `tracking`** — start a debounce timer. If the session has not
  returned to `tracking` when it expires, turn recording off **and clear the
  current-pass ICAO**.
- **Returning to `tracking` with the same ICAO before the timer expires** —
  cancel the debounce. No re-snapshot, no new clip.
- **Re-acquiring the same aircraft after the valve has closed** — the pass ICAO
  was cleared, so this is a new pass: new snapshot, new clip. An aircraft that
  leaves and genuinely comes back is a second event, not a continuation.

Keying on ICAO rather than on the state edge is the point: `waiting` flaps when a
target is briefly blocked or the servo saturates, and without both the ICAO key
and the debounce, a single pass becomes a dozen clip fragments and a dozen
near-identical images.

### MCP tools (`src/tools.ts`)

| Tool | Purpose |
|---|---|
| `get_capture_status` | armed / recording / last snapshot / last error |
| `capture_snapshot` | manual one-shot, independent of tracking |
| `set_capture_mode` | enable/disable automatic capture on track |
| `start_recording` / `stop_recording` | manual override of the valve |

Automatic capture defaults to **enabled**; the feature is otherwise inert
because it only fires while `cameraSource` is `"mediamtx"` and the camera is
armed.

### Frontend (`dashboard/public/`)

- `<img id="camera" src="/camera/stream">` → `<video id="camera" autoplay muted
  playsinline>`.
- New `whep.js`: a WHEP client over native `RTCPeerConnection` — POST the SDP
  offer to `/camera/whep`, apply the answer. **No new dependency**, so the
  dashboard's deliberate vanilla-JS / no-build constraint survives intact. The
  pure parts (URL building, SDP handling) are split out so they are testable
  without a browser.
- `renderCamera()`'s existing OFF / STARTING… / ON logic is unchanged; only the
  element and its attach path change.
- `autoplay` requires `muted` — without it browsers block playback. There is no
  audio track regardless.

### Dashboard route

`GET|POST /camera/whep` reverse-proxies the WHEP handshake to
`http://127.0.0.1:8889/<path>/whep`, sitting behind the **existing** `authGate`
already applied to `/camera`. MediaMTX's HTTP port is never exposed off-host.

WebRTC *media* still flows directly between browser and MediaMTX over UDP, so the
host's ICE port (8189/udp by default) must be reachable on the LAN. The proxy
unifies signaling and auth, not the media path. This is stated because it is the
one place the "single origin" framing could mislead.

## Config (`src/config.ts`)

New fields, each with a `TB3_*` env override, matching the existing pattern.

**Dashboard / transport:**

| Field | Default | Notes |
|---|---|---|
| `cameraSource` | `"mtplvcap"` | enum gains `"mediamtx"` |
| `cameraEncoder` | `"x264"` | `"x264" \| "nvenc" \| "copy"` |
| `cameraVideoBitrate` | `"6M"` | |
| `cameraMediamtxSize` | `"1920x1080"` | MediaMTX path only; see below |
| `cameraMediamtxRtspUrl` | `rtsp://127.0.0.1:8554/tb3` | publish target |
| `cameraMediamtxHttpUrl` | `http://127.0.0.1:8889` | WHEP origin, proxied |
| `cameraMediamtxPath` | `tb3` | |

**Daemon / capture:**

| Field | Default | Notes |
|---|---|---|
| `captureControlUrl` | `http://127.0.0.1:9997` | MediaMTX control API |
| `captureAutoEnabled` | `true` | auto-capture on track |
| `captureSnapshotDir` | `/var/lib/tb3/snapshots` | |
| `captureDebounceMs` | `5000` | `tracking` → off grace |
| `captureTimeoutMs` | `4000` | bound on every capture call |
| `captureFfmpegBin` | `ffmpeg` | |

**Capture size is per-path, deliberately.** A new `cameraMediamtxSize`
(default `1920x1080`) governs the MediaMTX path; `cameraV4l2Size` stays at
`1280x720` for the MJPEG path.

Raising the *shared* default was the obvious move and is wrong: the MJPEG path
feeds `CameraStreamer.writeChunk`, which ignores `res.write()` backpressure and
never drops frames. 1080p30 MJPEG is roughly 3× the byte rate of 720p30, so
raising it would measurably worsen the known unbounded-buffering OOM on the exact
path being kept as the emergency fallback. The fallback must stay conservative.
H.264 makes 1080p cheap on the MediaMTX path, where no such fan-out exists.

Note the existing behavior that makes both fields worth stating carefully: size
and framerate are **advisory** — the V4L2 driver substitutes its nearest mode and
keeps streaming, logging only at info level, which `-loglevel error` hides.

Retention is MediaMTX's own config (`recordDeleteAfter`), not ours, and lives in
the MediaMTX config file described under Deploy.

## Data flow

**Live view:** `Start` → `MediaMtxPublisher.enable()` → supervisor spawns
`ffmpegRtspSpawner` → ffmpeg publishes H.264 over RTSP to MediaMTX. A browser
loading the dashboard POSTs an SDP offer to `/camera/whep`; the dashboard
proxies it to MediaMTX; media flows browser ⇄ MediaMTX over UDP. Viewers come
and go without affecting ingest.

**Tracking capture:**

```
session: acquiring ──> tracking
   controller sees the edge, keyed by ICAO
     ├─ camera disarmed?  ──> skip, record reason, done
     ├─ same ICAO as last? ──> cancel pending debounce, done
     ├─ snapshot(icao)     ──> ffmpeg -i rtsp://…/tb3 -frames:v 1
     │                          → <icao>-<iso8601>.jpg
     └─ record ON          ──> MediaMTX control API

session: tracking ──> waiting | stopped
     └─ debounce captureDebounceMs
          ├─ back to tracking, same ICAO ──> cancel; no re-snap, no clip split
          └─ still not tracking          ──> record OFF
```

The snapshot is pulled from MediaMTX's RTSP output, **not** from the V4L2 device
— a second device consumer would contend with the publisher for the camera, and
device contention is exactly what has wedged this camera before.

## Error handling

**The hard safety rule:** the capture controller must never stall the tracking
tick. That loop is real-time control of a physical rig. Every capture call is
fire-and-forget with a bounded timeout (`captureTimeoutMs`), failures are logged
and surfaced, and **none are awaited on the control path**. This mirrors the
`withTimeout(...)` discipline the dashboard already applies to daemon calls.

| Failure | Behavior |
|---|---|
| MediaMTX service down | ffmpeg cannot publish → exits nonzero → existing restart budget (5 / 60 s) → then degrade, surface "video unavailable" |
| ffmpeg missing / device busy / device absent | Same budget. Identical to today. |
| **WHEP or ICE fails in the browser** | Explicit failure state in the UI plus bounded retry. Called out as a **regression risk**: a broken `<img>` was visibly broken, whereas a failed `RTCPeerConnection` is an indefinitely black rectangle. It must not fail silently. |
| Control API unreachable from daemon | Recording does not silently not-happen: logged, and reported through `get_capture_status` and tracking status |
| Camera disarmed at lock | Skipped with a reason, surfaced. Never auto-arms. |
| Snapshot ffmpeg hangs | Killed at `captureTimeoutMs`, logged, tracking unaffected |
| Snapshot dir unwritable | Logged once per session, capture disabled with a surfaced reason rather than erroring per-tick |
| Disk filling | MediaMTX `recordDeleteAfter` retention |
| Stop during an active recording | Recording valve closed first, then ffmpeg killed, so the segment finalizes rather than truncating |

The through-line: nothing swallows an error, and every degraded state is visible
in the dashboard rather than inferred from an absence of video.

## Testing

Following the convention this codebase already set: the spawner is not
unit-tested; its argv builder is, because flag order silently changes behavior.

**Unit (vitest):**

- `ffmpegRtspArgs(cfg)` — argv order (all input options before `-i`), encoder
  selection across all three values, bitrate/size/framerate plumbing, RTSP target.
  This gets the most attention: it is where the v4l2 work was already bitten.
- `supervisor.ts` — restart budget, window forgiveness, generation counter
  dropping late callbacks, and both predicates. Ported from the existing
  `CameraStreamer` tests, which already exercise this logic against fakes.
- `MediaMtxPublisher` — arm/disarm lifecycle against a fake `Spawner`; confirms
  ingest does **not** stop when viewers reach zero.
- `capture/controller.ts` — the policy, with a fake clock and fake control
  client. The tests that matter:
  - ICAO keying: `tracking → waiting → tracking` with the same ICAO produces
    **one** snapshot and **one** unbroken recording.
  - A different ICAO produces a new snapshot.
  - Re-acquiring the **same** ICAO *after* the valve closed produces a second
    snapshot and a second clip — a returning aircraft is a new pass.
  - Debounce: a brief `waiting` does not close the valve.
  - Disarmed camera: skipped, reason recorded, nothing thrown.
  - A hung capture call never delays a tick.
- `capture/mediamtx-client.ts` — against a stub HTTP server, including non-2xx
  and connection-refused paths.
- `whep.js` pure helpers — URL building and SDP handling, no browser required.
- `config.test.ts` — new field defaults, the `"mediamtx"` enum value, env
  overrides, and rejection of an invalid `cameraEncoder`.

**Explicitly not unit-tested, and documented as such:** `ffmpegRtspSpawner`, real
MediaMTX, real WebRTC — consistent with `mtplvcapSpawner` and
`ffmpegV4l2Spawner` today.

**Regression guard:** the existing MJPEG tests must continue to pass unchanged
after the file split. The split is a move, not a rewrite.

## On-rig verification (owed debt)

None of this is verifiable until the AI-PC returns. It joins a queue where the
IMU calibration, rig 3D view, ADS-B minimap, sector compass, sun-guard toggle,
and v4l2 source are **all** still awaiting on-rig confirmation. Recording this as
explicit debt rather than letting it blur into "done":

1. `ffmpeg -encoders | grep nvenc` → set `cameraEncoder` accordingly.
2. Confirm `ffmpeg` is installed at all.
3. Confirm the MediaMTX control-API route against the pinned version.
4. Live video in a browser at 1080p; confirm decode and no green/garbled frames.
5. `Stop` actually releases the device (`fuser /dev/video*` shows nothing).
6. A real track produces exactly one snapshot and one continuous clip.
7. A deliberately flapped track produces **one** clip, not fragments.
8. Retention prunes old segments.
9. Fallback: flipping `cameraSource` back to `"v4l2"` restores MJPEG video.
10. A second viewer joining does not disturb the first.

## Files

**New:** `src/dashboard/camera/{index,supervisor,rtsp,publisher}.ts`,
`src/capture/{mediamtx-client,snapshot,controller}.ts`,
`dashboard/public/whep.js`, `deploy/mediamtx.service`, `deploy/mediamtx.yml`.

**Moved:** `src/dashboard/camera.ts` → `camera/{mjpeg-streamer,jpeg-parser,
mtplvcap,v4l2}.ts`.

**Modified:** `src/config.ts` (new fields), `src/dashboard/server.ts` (spawner
selection, `/camera/whep` route), `src/tools.ts` (capture tools),
`src/track/session.ts` (expose transitions to the controller),
`dashboard/public/index.html` (`<video>`), `dashboard/public/app.js` (attach
path), `deploy/HOST-SETUP.md`.

**Tests:** new suites per the Testing section; existing camera tests updated for
the moved paths only.

## Deploy

MediaMTX installs as its own systemd service with a config file pinning: the
`tb3` path as `source: publisher`, recording on with segment duration and
`recordDeleteAfter` retention, HTTP/WebRTC/control bound to `127.0.0.1`, and the
ICE UDP port reachable on the LAN.

Two traps carried forward from the 2026-07-25 deploy, which cost real debugging
time and apply verbatim here:

1. **Set `cameraSource` in `config.json`, not as `Environment=` in the systemd
   unit.** The documented install step re-copies the tracked unit from git and
   would silently revert the rig.
2. **Use the `/dev/v4l/by-id/...` alias, never `/dev/video4`.** Enumeration
   churns on this host, and a shifted number opens the built-in webcam — which
   also negotiates MJPEG and shows a live, plausible, *wrong* picture.

Default `cameraSource` remains `"mtplvcap"`, so a host that does not opt in is
completely unaffected and this feature ships inert.
