# Selectable Camera Video Source — Design

**Status:** design, approved 2026-07-25. Follow-on to the sun-guard toggle (all
dashboard work on `main`). Independent of the IMU-calibration PR #7.

## Problem / goal

The dashboard's camera source is hardcoded to `mtplvcap` (Nikon USB Live View).
The Nikon D5000 overheated in the field and was swapped for an industrial UVC
camera on `/dev/video4` (host `192.168.4.71`), which the current code cannot
stream — there is no V4L2/UVC path. Add a second capture source and a
config-level selector so a camera swap is a config + restart, not a code edit,
keeping `mtplvcap` available for when the Nikon returns.

## Host capability (probed 2026-07-25)

`v4l2-ctl -d /dev/video4 --list-formats-ext` reports the UVC camera emits
**MJPEG natively**:
- `MJPG`: 1920×1080, 1280×720, 1280×960, 640×480, 640×360, 640×640 — all @30 fps.
- `YUYV`: 640×480, 640×360 @30 fps.

Native MJPEG is the good case: ffmpeg copies the camera's JPEG frames straight
through (`-c:v copy`) with no re-encode — low CPU, low latency — and the existing
`JpegFrameParser` already splits ffmpeg's concatenated-JPEG output into frames.

**Prerequisite (not yet confirmed):** the host must have `ffmpeg` installed
(`apt install ffmpeg`); the probe confirmed `v4l2-ctl` but not `ffmpeg`. This is
a deploy step, not a code dependency.

## Scope

- **In scope:** a `ffmpegV4l2Spawner` producing MJPEG frames from a UVC device;
  a `cameraSource` config selector (+ V4L2 device/size/framerate/ffmpeg-bin
  config) chosen at daemon startup; docs for switching sources.
- **Out of scope (YAGNI):** a runtime dashboard dropdown / live source swap
  (config + restart is enough — the source changes only on a hardware swap); a
  raw-YUYV encode path (this camera does MJPEG; a raw-only camera is a later
  add); auto-detection of the device; per-viewer resolution.

## Architecture

The camera pipeline is already source-agnostic (`src/dashboard/camera.ts`):
`CameraStreamer` runs any `Spawner` (`start(onFrame, onExit) → { kill() }`) and
owns the viewer refcount, MJPEG relay, bounded restart, and placeholder frame.
This change adds a **second spawner** and a **config selector** — nothing
downstream changes. Only the frame *producer* is swapped.

### The V4L2 spawner (`src/dashboard/camera.ts`)

`ffmpegV4l2Spawner(cfg): Spawner`, a sibling of the existing `mtplvcapSpawner`:
- Spawns ffmpeg reading the UVC device and writing concatenated MJPEG frames to
  stdout:
  ```
  ffmpeg -f v4l2 -input_format mjpeg -video_size <size> -framerate <fps> \
         -i <device> -c:v copy -f mjpeg pipe:1
  ```
- Reads `proc.stdout` through a `JpegFrameParser` (already exists, already
  unit-tested for concatenated JPEGs); each parsed frame → `onFrame(jpeg)`.
- ffmpeg process `exit`/`error` → `onExit(code)`.
- `kill()` SIGINTs ffmpeg with a bounded SIGKILL backstop (same lifecycle shape
  as `mtplvcapSpawner`, minus the HTTP relay/connect-retry — ffmpeg writes
  frames straight to stdout, so there is no port and no HTTP connect step).
- Simpler than `mtplvcapSpawner`: no HTTP relay, no port, no vendor-id.

### Config (`src/config.ts`)

New fields, each with a `TB3_CAMERA_*` env override, matching the existing
`cameraMtplvcap*` pattern:
- `cameraSource: "mtplvcap" | "v4l2"` — default `"mtplvcap"` (existing behavior
  unchanged; the feature is inert until the host opts in). Env `TB3_CAMERA_SOURCE`.
- `cameraV4l2Device: string` — default `/dev/video4`. Env `TB3_CAMERA_V4L2_DEVICE`.
- `cameraV4l2Size: string` — default `1280x720`. Env `TB3_CAMERA_V4L2_SIZE`.
- `cameraV4l2Framerate: number` (int, positive) — default `30`. Env
  `TB3_CAMERA_V4L2_FRAMERATE`.
- `cameraFfmpegBin: string` — default `ffmpeg`. Env `TB3_CAMERA_FFMPEG_BIN`.

### Selection (`src/dashboard/server.ts`)

At startup, pick the spawner factory by `cfg.cameraSource`:
```
const makeSpawner = cfg.cameraSource === "v4l2"
  ? () => ffmpegV4l2Spawner(cfg)
  : () => mtplvcapSpawner(cfg);
new CameraStreamer(makeSpawner, { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled });
```
A one-line branch; the rest of `main()`/`registerRoutes` is untouched.

## Data flow

Unchanged from today except the frame producer. `enable()`/`attach()` start the
selected spawner; frames flow spawner → `CameraStreamer.pushFrame` → every
attached `/camera/stream` viewer as `multipart/x-mixed-replace`. The dashboard's
Camera Start/Stop button and status (`enabled`/`streaming`/`viewers`) work
identically regardless of source.

## Error handling

Reuses `CameraStreamer`'s existing degradation, unchanged:
- ffmpeg missing / device busy (`EBUSY`) / device absent → ffmpeg exits nonzero →
  `handleExit` → bounded backed-off restart (`MAX_RESTARTS` within
  `RESTART_WINDOW_MS`) → placeholder frame after the budget is exhausted. Viewers
  see the placeholder tile, never a broken image; the pipeline never throws.
- Stop / disable → `kill()` SIGINTs ffmpeg (SIGKILL backstop) and releases the
  device.

## Testing

**Unit (vitest):** config parsing is the testable surface — extend
`test/config.test.ts`: `cameraSource` defaults to `"mtplvcap"`, accepts `"v4l2"`,
rejects an invalid value; the V4L2 field defaults (`/dev/video4`, `1280x720`,
`30`, `ffmpeg`); the `TB3_CAMERA_*` env overrides apply.

**Not unit-tested (consistent with the codebase):** `ffmpegV4l2Spawner` is a real
subprocess + stdout relay — on-host manual, exactly as `mtplvcapSpawner` is
explicitly untested-by-design. `JpegFrameParser` (the frame splitting) is already
unit-tested for ffmpeg-style concatenated JPEGs.

**On-host manual:** with `TB3_CAMERA_SOURCE=v4l2`, the dashboard Camera Start
shows live video from `/dev/video4`; Stop releases the device; unplugging /
holding the device busy degrades to the placeholder and recovers on restart.

## Files

- Modify: `src/config.ts` (5 fields + env overrides), `src/dashboard/camera.ts`
  (add `ffmpegV4l2Spawner`), `src/dashboard/server.ts` (spawner selection).
- Test: extend `test/config.test.ts`.
- Docs: add the `TB3_CAMERA_SOURCE=v4l2` switch (+ the optional device/size/
  framerate env vars) and the `ffmpeg` host prerequisite to
  `tb3-mcp/deploy/HOST-SETUP.md` (the host deploy doc). The README config table
  does not currently list the camera keys, so no README change is required.

## Deploy

The `ffmpeg` prerequisite and the `TB3_CAMERA_SOURCE=v4l2` (+ optional device/
size/framerate) env switch go in the dashboard systemd unit on the host (recorded
in `tb3-mcp/deploy/HOST-SETUP.md`); restart `tb3-dashboard` to take effect.
Default config is unchanged, so nothing breaks for a deployment that doesn't opt
in.
