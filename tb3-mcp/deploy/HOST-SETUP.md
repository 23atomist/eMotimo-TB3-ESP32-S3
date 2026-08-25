# Host Setup for TB3 Dashboard

This guide covers the on-host prerequisites for running the TB3 operations dashboard and camera integration.

## Prerequisites

### 1. UVC Camera Access

The camera is a plain UVC device on `/dev/video0` (verify with `v4l2-ctl --list-devices`). Two things can still take it away from ffmpeg:

- **gvfs** (`gvfs-gphoto2-volume-monitor`) grabs PTP/MTP cameras over USB. A standard UVC webcam is not affected, but if a Nikon-style body is ever mounted again, mask it:

  ```bash
  systemctl --user mask gvfs-gphoto2-volume-monitor
  killall gvfs-gphoto2-volume-monitor   # or re-plug the camera
  ```

- **Another process holding the device** (a leftover ffmpeg, a browser tab with `getUserMedia`, Cheese, etc.) makes ffmpeg fail with `Device or resource busy`. Check with `fuser /dev/video0`.

### 2. Camera source (mediamtx | V4L2/UVC)

Two capture backends are supported. `mediamtx` (the default) encodes H.264 via ffmpeg and publishes to a local MediaMTX for WebRTC; `v4l2` serves MJPEG straight off the UVC device through the dashboard's own relay.

#### Selecting the source

`cameraSource` picks the backend **at dashboard startup** — it is not a runtime dashboard control, so changing cameras means changing config and restarting `tb3-dashboard`:

| `cameraSource` | Backend | Use when |
|---|---|---|
| `mediamtx` (default) | ffmpeg -> MediaMTX -> browser WebRTC (WHEP) | the normal setup; also enables auto-capture recording |
| `v4l2` | ffmpeg reading a UVC device into an MJPEG relay | MediaMTX misbehaves and you need a known-good picture |

> **Migration note:** the old `mtplvcap` (Nikon USB Live View) backend was removed. A `config.json` that still carries `"cameraSource": "mtplvcap"` (or the removed `cameraMtplvcapBin`/`cameraMtplvcapPort` keys are harmless, but the source value itself is NOT) now fails schema validation at startup — remove the key or set `"v4l2"`/`"mediamtx"`.

**Primary route: `config.json`.** `config.json` is gitignored (host-local, never tracked), so unlike the systemd unit it survives both `git pull` and a unit reinstall (**Service Installation** step 1 below re-copies `deploy/tb3-dashboard.service` from git, which carries no camera settings). Set the keys directly:

```json
{
  "cameraSource": "mediamtx",
  "cameraV4l2Device": "/dev/v4l/by-id/usb-<...>-video-index0",
  "cameraFfmpegBin": "ffmpeg"
}
```

Only `cameraSource` is required to switch backends — the `cameraV4l2*` / `cameraFfmpegBin` keys are optional and fall back to the defaults shown above (see **V4L2/UVC via ffmpeg** below for what each one does). Then restart:

```bash
sudo systemctl restart tb3-dashboard
journalctl -u tb3-dashboard -n 5   # the listening line ends with "camera mediamtx"
```

**Temporary override: env vars.** Every camera key also has a `TB3_CAMERA_*` env override. It's the fastest way to test a source change without touching `config.json`:

```ini
# /etc/systemd/system/tb3-dashboard.service  ([Service] section)
Environment=TB3_CAMERA_SOURCE=v4l2
Environment=TB3_CAMERA_V4L2_DEVICE=/dev/video0
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart tb3-dashboard
```

**This does not stick.** The tracked `deploy/tb3-dashboard.service` carries no camera `Environment=` lines, so the next `sudo cp deploy/tb3-dashboard.service /etc/systemd/system/` (**Service Installation** step 1) overwrites the unit and silently reverts every camera key to its default on the next restart. Use the env override for a one-off test only; put anything meant to persist in `config.json` instead.

The dashboard's Camera Start/Stop button and its status (`enabled`/`streaming`/`viewers`) behave identically for both sources — only the frame producer changes.

#### V4L2/UVC via ffmpeg (`cameraSource: "v4l2"`)

Requires **ffmpeg** on the host — the only extra dependency for this source:

```bash
sudo apt-get install ffmpeg
```

The dashboard spawns, on camera Start:

```bash
ffmpeg -hide_banner -loglevel error \
       -f v4l2 -input_format mjpeg -video_size <size> -framerate <fps> \
       -i <device> -c:v copy -f mjpeg pipe:1
```

`-c:v copy` passes the camera's native MJPEG frames through with no re-encode (low CPU, low latency). `-input_format mjpeg` is the one hard requirement: the device must advertise an `MJPG` pixel format at all, or ffmpeg exits immediately (see **Troubleshooting** below). `cameraV4l2Size` / `cameraV4l2Framerate` are advisory only — if the device doesn't advertise that exact size/framerate under `MJPG`, the V4L2 driver substitutes its nearest supported mode and streaming continues at that mode instead of failing. List the advertised modes before setting either value:

```bash
v4l2-ctl -d /dev/video0 --list-formats-ext
```

**Use the stable udev alias for `cameraV4l2Device`, not the bare device number, for anything left running unattended.** `/dev/videoN` numbering is assigned by enumeration order and is not stable across a reboot or a USB replug — if enumeration shifts, ffmpeg opens whatever now sits at that number — often another camera that also negotiates MJPEG without error, so the dashboard shows a live, plausible, completely wrong picture instead of falling back to the placeholder. Resolve the stable path once:

```bash
ls -l /dev/v4l/by-id/
```

and set `cameraV4l2Device` to the resulting path, e.g. `/dev/v4l/by-id/usb-<...>-video-index0`. `cameraV4l2Device` is passed straight through to ffmpeg's `-i`, so any path the device exposes works.

Defaults: `cameraV4l2Device` `/dev/video0`, `cameraV4l2Size` `1280x720`, `cameraV4l2Framerate` `30`, `cameraFfmpegBin` `ffmpeg` (set an absolute path if `ffmpeg` is not on the service user's `$PATH`). `/dev/video0` matches the currently mounted UVC camera and is fine for a quick probe; prefer the by-id alias above for a deployment that must survive a reboot. Stop SIGINTs ffmpeg and releases the device.

### 3. systemctl Permission for Agent Toggle

The dashboard's **Auto** toggle (and the E-STOP agent leg) shells out to `systemctl start/stop tb3-agent` **directly** — `RealSystemctl` (`src/dashboard/services.ts`) calls `execFile("systemctl", ...)`, it never invokes `sudo`. The service user must therefore have permission to control the agent service via a mechanism that governs direct `systemctl` calls, not `sudo` specifically.

**Option A: polkit rule (required — this is the only option the code path actually exercises)**

Create `/etc/polkit-1/rules.d/50-tb3-agent.rules`:

```javascript
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "tb3-agent.service" &&
      subject.user == "atomist") {
    return polkit.Result.YES;
  }
});
```

Reload polkit:

```bash
sudo systemctl reload polkit
```

**~~Option B: sudoers entry~~ — does not apply**

A `sudoers` `NOPASSWD` entry only grants permission when the command is actually run through `sudo`. Since `RealSystemctl` calls `systemctl` directly (no `sudo` prefix anywhere in the dashboard code), a sudoers rule is never consulted and will not grant the Auto toggle or E-STOP agent leg permission — set up the polkit rule (Option A) instead.

### 4. Dashboard Auth Configuration

If `dashboardAuth: true` is set in `config.json`, the dashboard's API routes (camera, status, controls, E-STOP — everything under `/api` and `/camera`) require the token to match `mcpToken` from the config. **`mcpToken` MUST be set when `dashboardAuth: true`** — if it isn't, `authGate` fails closed and *every* gated route returns `401 Unauthorized` regardless of what's presented (there is no way to authenticate against an unset token).

The token can be presented three ways:

- `Authorization: Bearer <mcpToken>` header — works for plain `fetch()` calls only.
- `?token=<mcpToken>` query param.
- `tb3_token` cookie.

In practice, only the query param matters for setup: **open the dashboard once with `?token=<mcpToken>` appended to the URL**, e.g. `http://192.168.4.104:8788/?token=<mcpToken>`. The SPA (`dashboard/public/app.js`) reads that query param on load and stores it as a `tb3_token` session cookie, which same-origin `EventSource("/api/stream")`, `<img src="/camera/stream">`, and every `fetch()` control POST then carry automatically — none of those can set a custom `Authorization` header, so the header option alone would silently 401 the SSE stream and camera feed even with a correct token elsewhere. After that first visit, plain `http://192.168.4.104:8788` works until the cookie is cleared (it is not persisted across browser data clears, a different browser, or private/incognito mode — repeat the `?token=` visit in those cases).

Default is `dashboardAuth: false` (no auth required).

### 5. Network Access

The dashboard listens on the address and port configured in `config.json` (`dashboardBind` and `dashboardPort`; defaults are `"0.0.0.0"` and `8788`). Access it from the LAN:

```
http://<host-lan-ip>:8788
```

Example: `http://192.168.4.104:8788`

## Service Installation (systemd)

Once the above prerequisites are met:

1. **Copy the service file:**

   ```bash
   sudo cp deploy/tb3-dashboard.service /etc/systemd/system/
   ```

2. **Reload systemd and enable the service:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable tb3-dashboard
   ```

3. **Start the dashboard:**

   ```bash
   sudo systemctl start tb3-dashboard
   ```

4. **Check status:**

   ```bash
   systemctl status tb3-dashboard
   ```

## Verification

1. Open `http://<host-lan-ip>:8788` in a browser.
2. Confirm the rig's status, telemetry, and camera feed load.
3. Test the camera preview or live view (if camera is plugged in and accessible).
4. Test manual controls: jog, goto, and the E-STOP button.
5. If the Auto toggle is enabled, confirm it can start/stop the `tb3-agent` service.

## Troubleshooting

**Dashboard does not start or crashes immediately**

- Check the systemd journal: `journalctl -u tb3-dashboard -n 50 -e`
- Ensure the service dependencies are running: `systemctl is-active tb3-mcp` (the core MCP daemon must be running first)
- Rebuild if needed: `npm run build` from `tb3-mcp/`

**Camera feed shows "fallback" or no video**

- Verify gvfs is masked and the camera is re-plugged
- Confirm the camera enumerates: `lsusb | grep -i nikon`, and nothing else holds it (no gphoto2/gvfs process)
- Check `config.json` for `cameraMtplvcapBin` (absolute path to the binary) and `cameraMtplvcapPort` (default 42839)
- With `cameraSource: "v4l2"`: confirm ffmpeg is installed (`ffmpeg -version`) and the device exists (`ls -l /dev/video4`)
- Check nothing else holds the device: `fuser -v /dev/video4`
- Confirm the device advertises an `MJPG` pixel format at all in `v4l2-ctl -d /dev/video4 --list-formats-ext` — that's the one thing that makes ffmpeg exit immediately (`-input_format mjpeg` can't be satisfied); after the restart budget is spent, the tile falls back to the placeholder
- ffmpeg's stderr goes to the dashboard journal: `journalctl -u tb3-dashboard -n 50`
- A bad `cameraFfmpegBin`/`cameraEncoder` does NOT crash the dashboard (E-STOP/jog/telemetry keep working even with video broken) — check the on-page error list or `journalctl -u tb3-dashboard | grep "camera configuration error"` for the specific cause
- On `cameraSource: "mediamtx"`, `Camera: DEGRADED` (as opposed to `STARTING…`) means ingest exhausted its restart budget and gave up; it self-heals on its own within ~30s (see `MediaMtxPublisher`'s recovery timer) with no operator action needed — a `DEGRADED` state that never clears after that points at something actually broken (dead ffmpeg path, MediaMTX down) rather than a transient hiccup

**Camera feed shows a live picture, but it's wrong (wrong resolution, or the wrong camera)**

- A `cameraV4l2Size`/`cameraV4l2Framerate` the device doesn't advertise is NOT a failure: the V4L2 driver silently substitutes its nearest supported mode and ffmpeg keeps streaming at that mode (the substitution is logged only at info level, hidden by `-loglevel error`). Compare what's on screen against `v4l2-ctl -d <device> --list-formats-ext` to see what mode you actually got
- `/dev/videoN` numbering is not stable across a reboot or replug. If the picture is clearly the wrong camera (e.g. the host's built-in webcam instead of the industrial UVC camera), `cameraV4l2Device` is probably pointing at a number that now belongs to a different device — switch to the stable `/dev/v4l/by-id/usb-<...>-video-index0` alias (§2, **V4L2/UVC via ffmpeg** — `ls -l /dev/v4l/by-id/`) so the config survives enumeration changes

**Auth returns 401**

- Confirm `mcpToken` is set in `config.json` — with `dashboardAuth: true` and no `mcpToken`, every gated route 401s no matter what token is presented
- If the SSE stream or camera feed specifically are 401ing while the rest of the SPA works, the `tb3_token` cookie was never stored — reopen the dashboard with `?token=<mcpToken>` in the URL once (see §4)
- If auth is disabled, `dashboardAuth: false` should be the default

**Agent toggle permission denied**

- Verify the polkit rule (§3, Option A) is in place and the service user is correct (`id -u -n` on the host should be `atomist`) — a sudoers `NOPASSWD` entry will NOT fix this, `RealSystemctl` never invokes `sudo`
- Reload polkit: `sudo systemctl reload polkit`

## MediaMTX / WebRTC (`cameraSource: "mediamtx"`)

This backend replaces the browser's MJPEG `<img>` with a `<video>` fed by WebRTC (WHEP): `ffmpeg` reads the UVC device, transcodes to H.264, and publishes RTSP into [MediaMTX](https://github.com/bluenviron/mediamtx), which serves WebRTC to the browser. The dashboard's `/camera/whep` route proxies only the SDP signaling — media itself flows **browser <-> MediaMTX directly** over UDP, so MediaMTX's WebRTC UDP port must be reachable on the LAN even though its HTTP/API/RTSP ports stay on loopback (see `deploy/mediamtx.yml`'s header comment).

### 1. Install MediaMTX

Download the release matching the host architecture and install the binary + config + unit:

```bash
curl -sL -o /tmp/mediamtx.tar.gz \
  https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz
tar -xzf /tmp/mediamtx.tar.gz -C /tmp
sudo install -m755 /tmp/mediamtx /usr/local/bin/mediamtx

sudo mkdir -p /etc/mediamtx
sudo cp deploy/mediamtx.yml /etc/mediamtx/mediamtx.yml
sudo cp deploy/mediamtx.service /etc/systemd/system/mediamtx.service

sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
systemctl status mediamtx
```

### 2. Recording/snapshot directories

`deploy/mediamtx.yml`'s `pathDefaults.recordPath` points at `/var/lib/tb3/recordings`; create it (and the sibling `snapshots` dir the MCP daemon uses for confirmation grabs) owned by the service user, `atomist` — `deploy/mediamtx.service` runs `User=atomist`, and a directory MediaMTX can't write to fails recording silently (segments just never appear, no crash):

```bash
sudo mkdir -p /var/lib/tb3/{recordings,snapshots}
sudo chown -R atomist:atomist /var/lib/tb3
```

### 3. Open the ICE UDP port on the LAN

Only `webrtcLocalUDPAddress` (`:8189`, `deploy/mediamtx.yml`) needs to be reachable from the LAN — everything else (`apiAddress`, `rtspAddress`, `webrtcAddress`) is bound to `127.0.0.1` on purpose, so the dashboard's token gate is the only way to reach signaling. If the host runs a firewall:

```bash
sudo ufw allow 8189/udp
```

(adjust for `iptables`/`nftables`/`firewalld` if that's what the host actually runs — check with `ufw status` / `iptables -L` first; this project has not standardized on one).

### 4. Configuration traps

These three have each cost real debugging time on this project — they are not boilerplate.

**Trap 1: set `cameraSource` in `config.json`, never `Environment=`.** Exactly the same trap as the `v4l2` source (§2, **Selecting the source**, above): the tracked `deploy/tb3-dashboard.service` carries no camera `Environment=` lines, so a `sudo cp deploy/tb3-dashboard.service /etc/systemd/system/` (**Service Installation** step 1) silently reverts every camera key (and any env-set source override) to its default on the next restart. Since `mediamtx` IS the default now, that failure mode is benign — but a stale `config.json` carrying `"cameraSource": "mtplvcap"` (the removed backend) fails schema validation and **refuses to boot at all**; see §2's migration note. `TB3_CAMERA_*` env overrides are fine for a one-off test; anything meant to persist belongs in `config.json`:

```json
{
  "cameraSource": "mediamtx",
  "cameraEncoder": "nvenc",
  "cameraV4l2Device": "/dev/v4l/by-id/usb-<...>-video-index0",
  "cameraFfmpegBin": "/absolute/path/to/ffmpeg"
}
```

**Trap 2: use the by-id device alias for `cameraV4l2Device`.** The `mediamtx` capture pipeline reads the same UVC device via the same `cameraV4l2Device` key as the `v4l2` MJPEG source (`ffmpegRtspArgs`, `src/dashboard/camera/rtsp.ts`) — so the identical warning applies (§2, **V4L2/UVC via ffmpeg**, above): `/dev/videoN` numbering is reassigned by enumeration order and is NOT stable across a reboot or a USB replug. Resolve the stable path once with `ls -l /dev/v4l/by-id/` and set `cameraV4l2Device` to that, e.g. `/dev/v4l/by-id/usb-<...>-video-index0` — otherwise a reboot can silently point ffmpeg at a different camera (or the host's built-in webcam) that still negotiates MJPEG without error.

**Trap 3: `cameraFfmpegBin` must be an absolute path — never a bare `ffmpeg` relying on `$PATH`.** This bit hardest when ffmpeg is managed by `asdf`: `which ffmpeg` resolves to a shim (`exec asdf exec ffmpeg ...`), and that shim **fails under systemd** because asdf's shim directory is not on the unit's `PATH` — the pipeline exits immediately with no video and an easy-to-miss error in the journal. Worse, a shim is not a fixed binary: an `asdf install ffmpeg <newer>` / `asdf global ffmpeg <newer>` bump moves what the shim resolves to without changing anything in `config.json`, so a working config can silently start pointing at a different ffmpeg build (potentially one missing the `h264_nvenc`/`h264_vulkan` encoder this path needs) after an unrelated version bump elsewhere. Get the real path with `asdf which ffmpeg` (**not** `which ffmpeg`) and set that absolute path in `config.json`:

```json
{ "cameraFfmpegBin": "/home/atomist/.asdf/installs/ffmpeg/8.1.2/bin/ffmpeg" }
```

If ffmpeg instead comes from a distro package built with hardware-encoder support (e.g. `jellyfin-ffmpeg`, which is where this host's NVENC build later came from), the same rule still applies — point at its absolute install path (e.g. `/usr/lib/jellyfin-ffmpeg/ffmpeg`), never a bare name. Re-run `ffmpeg -encoders | grep -E 'nvenc|vulkan'` against whichever absolute path is configured to confirm the encoder `cameraEncoder` selects is actually present in that build.

### 5. Daemon-side config (`tb3-mcp`) — both processes MUST read the SAME `config.json`

Everything above (Traps 1–3, **Selecting the source**) describes `config.json` from the **dashboard's** point of view. The MCP daemon (`tb3-mcp`, `deploy/tb3-mcp.service`) is a **separate process with its own config load** — `loadConfig(process.env.TB3_CONFIG ?? "config.json")`, same as the dashboard, but resolved against its own `WorkingDirectory` and its own environment. Nothing links the two beyond that they *should* be pointed at the same file.

**They currently are not, by default.** `deploy/tb3-mcp.service` sets `WorkingDirectory=/opt/tb3-mcp` and no `TB3_CONFIG`, so the daemon loads `/opt/tb3-mcp/config.json`. `deploy/tb3-dashboard.service` sets `TB3_CONFIG=/home/atomist/TB3-ESP32/tb3-mcp/config.json` explicitly. Unless these were made to agree on this host (e.g. one is a symlink to the other, or both units were edited to point at one canonical path), **the daemon and the dashboard are reading two different config files** and any key below can silently drift out of sync between them.

**Keys the daemon reads that the dashboard also cares about** (this branch made all of these shared state that must agree across both processes — see `src/server.ts`'s `main()`):

| Key | Daemon's use |
|---|---|
| `cameraMediamtxControlUrl` | `MediaMtxClient`'s base URL for the record valve (`setRecord`) and the `isArmed()` path-ready check |
| `cameraMediamtxPath` | Which MediaMTX path the daemon patches/queries — must match the path the dashboard's publisher actually publishes to (`cameraMediamtxPath` on the dashboard side) |
| `captureFfmpegBin` | The daemon's OWN ffmpeg binary, used only by `src/capture/snapshot.ts`'s `takeSnapshot()` to pull a confirmation frame from MediaMTX's RTSP output. **Separate from the dashboard's `cameraFfmpegBin`** — same binary in practice on most hosts, but a distinct config key, so it does not automatically inherit `cameraFfmpegBin`'s value or its Trap 3 fix above. Same trap applies: prefer an absolute path over a bare `ffmpeg`, since a systemd unit's minimal `PATH` (and an `asdf` shim, if that's how ffmpeg is managed on this host) can make a bare name resolve on an interactive shell but fail under `systemctl start`. The daemon preflights this at startup (the same `-version` exec check as the dashboard's `assertFfmpegUsable`) and fails loudly, not fatally: a bad value is logged and surfaced into `get_capture_status`'s `lastError` (and therefore the dashboard's "Capture: ERROR" chip) instead of crash-looping the daemon |
| `captureSnapshotDir` | Where `takeSnapshot()` writes confirmation JPEGs — must exist and be writable by the daemon's service user (see **MediaMTX / WebRTC** §2 above, which creates `/var/lib/tb3/snapshots` for exactly this) |
| `captureDebounceMs` | Grace period before the daemon closes the record valve after losing a target — purely a daemon-side tracking-tick concern, but listed here because it lives in the same shared `config.json` |

**`cameraSource` also matters to the daemon**, though it isn't in the table above: auto capture only activates when `cameraSource === "mediamtx"` (see `resolveCaptureAutoEnabled`, `src/server.ts`) — a daemon reading a config where `cameraSource` says `v4l2` (because it loaded a stale/different file than the dashboard) silently never captures anything, with no error, since it correctly believes there is no MediaMTX pipeline to talk to. And a config still naming the removed `mtplvcap` source fails validation outright — see §2's migration note.

**A unit-level `Environment=` override applies to ONLY the process whose unit sets it.** §4's Trap 1 already warns that a dashboard-only `Environment=TB3_CAMERA_*` line does not "stick" across a service reinstall — the same mechanism is also a way to accidentally desynchronize the two processes on purpose: setting `Environment=TB3_CAMERA_MEDIAMTX_PATH=...` (or any `TB3_CAPTURE_*` override) in `tb3-dashboard.service` changes what the **dashboard** publishes to, or `tb3-mcp.service` changes what the **daemon** reads/patches, but never both — there is no shared environment between the two units. Prefer `config.json` for anything meant to persist, exactly as §4 already recommends, specifically BECAUSE it's the one mechanism both processes can be pointed at simultaneously.

### Verification

1. Set the four keys from **Trap 1** above in `config.json`, restart `tb3-dashboard`, and confirm the journal's listening line ends with `camera mediamtx (nvenc)` (or whichever `cameraEncoder` is configured).
2. Open the dashboard; the video tile should show live WebRTC video within a couple of seconds of the camera being armed (Start).
3. Disarm the camera (Stop) and confirm the tile shows the `camera-off` placeholder, not a stuck last frame.
4. To exercise the failure-surfacing path deliberately: `sudo systemctl stop mediamtx`, confirm the tile switches to the `camera-error` "Camera stream failed — retrying…" message within a few seconds (not an indefinite black rectangle), then `sudo systemctl start mediamtx` and confirm it recovers on its own without a page reload.
