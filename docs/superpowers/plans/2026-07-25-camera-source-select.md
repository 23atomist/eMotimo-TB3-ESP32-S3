# Selectable Camera Video Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V4L2/UVC camera source (ffmpeg) alongside the existing mtplvcap source, selected by config at daemon startup, so a camera swap is a config + restart instead of a code edit.

**Architecture:** The camera pipeline is already source-agnostic — `CameraStreamer` (`src/dashboard/camera.ts`) runs any `Spawner` and owns viewer refcounting, the MJPEG relay, bounded restart, and the placeholder frame. This change adds a **second spawner** (`ffmpegV4l2Spawner`) and a **config selector** (`cameraSource`); nothing downstream changes. The UVC camera emits MJPEG natively, so ffmpeg copies its JPEG frames through with `-c:v copy` (no re-encode) and the existing `JpegFrameParser` splits them.

**Tech Stack:** TypeScript (ESM, strict), Node `child_process.spawn`, zod config schema, vitest, ffmpeg + v4l2 on the host.

**Spec:** `docs/superpowers/specs/2026-07-25-camera-source-select-design.md`

## Global Constraints

- Work happens in `tb3-mcp/`. **All commands below are run from `/Volumes/ExtData2/coding/TB3-ESP32/tb3-mcp`.**
- Branch: work on `feat/camera-source` off `main` (all recent dashboard work lands on `main`).
- ESM: every relative import must carry the `.js` suffix (e.g. `../src/config.js`), even from `.ts`.
- Default behavior must not change: `cameraSource` defaults to `"mtplvcap"`, so a host that does not opt in behaves exactly as today.
- No dashboard UI change. There is no runtime source dropdown — selection is config + restart (explicitly out of scope per the spec).
- `ffmpegV4l2Spawner` itself (subprocess + stdout relay) is **not** unit-tested, matching `mtplvcapSpawner`, which is untested-by-design. Only its pure argv builder is tested.
- Env override naming follows the existing pattern exactly: `TB3_CAMERA_*`.
- Do not `git push` — the repo owner pushes. Commit only.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/config.ts` | Modify (`:65`, `:142`) | 5 new camera fields + their `TB3_CAMERA_*` env overrides |
| `test/config.test.ts` | Modify (`:159`) | Defaults, env overrides, and invalid-source rejection |
| `src/dashboard/camera.ts` | Modify (append at `:375`) | `ffmpegV4l2Args` (pure) + `ffmpegV4l2Spawner` (subprocess) |
| `test/dashboard-camera.test.ts` | Modify (append) | argv-builder unit tests |
| `src/dashboard/server.ts` | Modify (`:6`, `:284-287`, `:301-305`) | Pick the spawner factory by `cfg.cameraSource` |
| `deploy/HOST-SETUP.md` | Modify (`:29`, `:41`, `:140-144`) | ffmpeg prerequisite + how to switch source |

---

### Task 1: Config fields for source selection and V4L2

**Files:**
- Modify: `tb3-mcp/src/config.ts:58-65` (schema) and `tb3-mcp/src/config.ts:139-142` (env overrides)
- Test: `tb3-mcp/test/config.test.ts:159` (inside the existing `describe("dashboard config", ...)` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Config` gains `cameraSource: "mtplvcap" | "v4l2"`, `cameraV4l2Device: string`, `cameraV4l2Size: string`, `cameraV4l2Framerate: number`, `cameraFfmpegBin: string`. Tasks 2 and 3 read these off `cfg`.

**Context:** `loadConfig(filePath?, env = process.env)` merges an optional JSON file with `TB3_*` env overrides and then `ConfigSchema.parse(...)`. Every field gets a zod default, so `loadConfig(undefined, {})` returns a fully-populated config — that is what the tests exercise.

- [ ] **Step 1: Write the failing tests**

In `tb3-mcp/test/config.test.ts`, insert these three tests immediately after the existing `it("camera env overrides", ...)` test (which ends at line 159) and before the `});` that closes `describe("dashboard config", ...)`:

```typescript
  it("camera source defaults to mtplvcap with v4l2 fields ready", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraSource).toBe("mtplvcap");
    expect(c.cameraV4l2Device).toBe("/dev/video4");
    expect(c.cameraV4l2Size).toBe("1280x720");
    expect(c.cameraV4l2Framerate).toBe(30);
    expect(c.cameraFfmpegBin).toBe("ffmpeg");
  });

  it("camera v4l2 env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "v4l2",
      TB3_CAMERA_V4L2_DEVICE: "/dev/video0",
      TB3_CAMERA_V4L2_SIZE: "1920x1080",
      TB3_CAMERA_V4L2_FRAMERATE: "15",
      TB3_CAMERA_FFMPEG_BIN: "/usr/bin/ffmpeg",
    });
    expect(c.cameraSource).toBe("v4l2");
    expect(c.cameraV4l2Device).toBe("/dev/video0");
    expect(c.cameraV4l2Size).toBe("1920x1080");
    expect(c.cameraV4l2Framerate).toBe(15);
    expect(c.cameraFfmpegBin).toBe("/usr/bin/ffmpeg");
  });

  it("rejects an unknown camera source", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_SOURCE: "gphoto2" })).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts -t "camera"`

Expected: FAIL — the two new positive tests fail on `expected undefined to be "mtplvcap"` (and the other `undefined` fields); the rejection test fails because an unknown key is currently ignored rather than rejected.

- [ ] **Step 3: Add the schema fields**

In `tb3-mcp/src/config.ts`, replace the `cameraMtplvcapPort` line (line 65) — the last field before the closing `})` of the schema object — with that line plus the new fields:

```typescript
    cameraMtplvcapPort: z.number().int().positive().max(65535).default(42839),
    // Which capture backend produces frames, chosen at daemon startup (there is
    // no runtime switch -- the source changes only on a hardware swap):
    // "mtplvcap" = Nikon USB Live View; "v4l2" = a UVC camera via ffmpeg.
    // Defaults to mtplvcap so an existing deployment is unaffected.
    cameraSource: z.enum(["mtplvcap", "v4l2"]).default("mtplvcap"),
    // --- V4L2/UVC source (read only when cameraSource === "v4l2") ---
    cameraV4l2Device: z.string().min(1).default("/dev/video4"),
    // Size/framerate MUST be a mode the device advertises for MJPG (check with
    // `v4l2-ctl -d <device> --list-formats-ext`) -- ffmpeg copies the camera's
    // native JPEG frames rather than re-encoding, so an unsupported mode makes
    // it exit immediately instead of transcoding.
    cameraV4l2Size: z.string().min(1).default("1280x720"),
    cameraV4l2Framerate: z.number().int().positive().default(30),
    cameraFfmpegBin: z.string().min(1).default("ffmpeg"),
```

- [ ] **Step 4: Add the env overrides**

In `tb3-mcp/src/config.ts`, replace the `set("cameraMtplvcapPort", ...)` line (line 142) — the last `set(...)` before `return ConfigSchema.parse(overrides);` — with that line plus:

```typescript
  set("cameraMtplvcapPort", num(env.TB3_CAMERA_MTPLVCAP_PORT));
  set("cameraSource", env.TB3_CAMERA_SOURCE);
  set("cameraV4l2Device", env.TB3_CAMERA_V4L2_DEVICE);
  set("cameraV4l2Size", env.TB3_CAMERA_V4L2_SIZE);
  set("cameraV4l2Framerate", num(env.TB3_CAMERA_V4L2_FRAMERATE));
  set("cameraFfmpegBin", env.TB3_CAMERA_FFMPEG_BIN);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`

Expected: PASS — all tests in the file green, including the three new ones.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(camera): cameraSource selector + V4L2 config fields"
```

---

### Task 2: The ffmpeg V4L2 spawner

**Files:**
- Modify: `tb3-mcp/src/dashboard/camera.ts` (append after `mtplvcapSpawner`, which ends at line 374)
- Test: `tb3-mcp/test/dashboard-camera.test.ts` (append a new `describe` at end of file)

**Interfaces:**
- Consumes: `cfg.cameraFfmpegBin`, `cfg.cameraV4l2Device`, `cfg.cameraV4l2Size`, `cfg.cameraV4l2Framerate` from Task 1. Also the existing module members `Spawner` (`camera.ts:9`), `JpegFrameParser` (`camera.ts:237`), and `KILL_GRACE_MS` (`camera.ts:285`, already declared above the insertion point).
- Produces:
  - `export function ffmpegV4l2Args(cfg: Config): string[]`
  - `export function ffmpegV4l2Spawner(cfg: Config): Spawner` — Task 3 imports this from `./camera.js`.

**Context:** `Spawner` is `{ start(onFrame: (jpeg: Buffer) => void, onExit: (code: number | null) => void): { kill(): void } }`. `CameraStreamer` calls `start()` when it wants frames and `kill()` on stop/disable; it treats `onExit` as "pipeline died" and applies its own bounded restart, so this spawner must never throw and must never retry internally.

The argv builder is split out as a pure function purely so flag *order* is testable: ffmpeg silently ignores `-input_format` / `-video_size` / `-framerate` if they appear after `-i`, which would yield a wrong-format or wrong-resolution stream with no error. The spawner itself stays untested-by-design (real subprocess), matching `mtplvcapSpawner`.

- [ ] **Step 1: Write the failing tests**

Append to `tb3-mcp/test/dashboard-camera.test.ts`. Also add the two imports at the top of the file — extend the existing import from `../src/dashboard/camera.js` to include `ffmpegV4l2Args`, and add the `Config` type import:

```typescript
import { CameraStreamer, JpegFrameParser, ffmpegV4l2Args, type Spawner } from "../src/dashboard/camera.js";
import type { Config } from "../src/config.js";
```

Then append at the end of the file:

```typescript
describe("ffmpegV4l2Args", () => {
  // Only the camera fields matter; the rest of Config is irrelevant here.
  const cfg = {
    cameraFfmpegBin: "ffmpeg",
    cameraV4l2Device: "/dev/video4",
    cameraV4l2Size: "1280x720",
    cameraV4l2Framerate: 30,
  } as unknown as Config;

  it("reads the device as native MJPEG and copies frames to stdout", () => {
    expect(ffmpegV4l2Args(cfg)).toEqual([
      "-hide_banner",
      "-loglevel", "error",
      "-f", "v4l2",
      "-input_format", "mjpeg",
      "-video_size", "1280x720",
      "-framerate", "30",
      "-i", "/dev/video4",
      "-c:v", "copy",
      "-f", "mjpeg",
      "pipe:1",
    ]);
  });

  it("places every input option before -i, where ffmpeg still honors it", () => {
    const args = ffmpegV4l2Args({
      ...cfg,
      cameraV4l2Device: "/dev/video0",
      cameraV4l2Size: "1920x1080",
      cameraV4l2Framerate: 15,
    } as unknown as Config);
    const inputAt = args.indexOf("-i");
    expect(inputAt).toBeGreaterThan(-1);
    for (const opt of ["-f", "-input_format", "-video_size", "-framerate"]) {
      expect(args.indexOf(opt)).toBeLessThan(inputAt);
    }
    expect(args[args.indexOf("-video_size") + 1]).toBe("1920x1080");
    expect(args[args.indexOf("-framerate") + 1]).toBe("15");
    expect(args[inputAt + 1]).toBe("/dev/video0");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard-camera.test.ts -t "ffmpegV4l2Args"`

Expected: FAIL — the file does not compile / the import resolves to `undefined`: `"ffmpegV4l2Args" is not exported by "src/dashboard/camera.ts"`.

- [ ] **Step 3: Write the implementation**

Append to the end of `tb3-mcp/src/dashboard/camera.ts` (after `mtplvcapSpawner`'s closing `}` at line 374). `spawn`, `Config`, `Spawner`, `JpegFrameParser`, and `KILL_GRACE_MS` are all already in scope:

```typescript
// ---------------------------------------------------------------------------
// ffmpegV4l2Spawner: the spawner itself is NOT unit-tested (real subprocess +
// stdout relay; verified on-host), same as mtplvcapSpawner above. Its argv
// builder is split out and unit-tested because flag ORDER matters: ffmpeg
// ignores input options placed after -i, which would silently give us the
// wrong pixel format or resolution rather than an error.
//
// ffmpeg reads the V4L2/UVC device and writes the camera's NATIVE MJPEG frames
// to stdout as bare concatenated JPEGs -- "-c:v copy" means no re-encode, so
// CPU and latency stay low. JpegFrameParser splits that byte stream into
// frames. Simpler than mtplvcapSpawner: no HTTP relay, no port, no connect
// retry, no vendor id -- ffmpeg writes straight into our pipe.
// ---------------------------------------------------------------------------

export function ffmpegV4l2Args(cfg: Config): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    // Input options -- all of these MUST precede -i to take effect.
    "-f", "v4l2",
    "-input_format", "mjpeg",
    "-video_size", cfg.cameraV4l2Size,
    "-framerate", String(cfg.cameraV4l2Framerate),
    "-i", cfg.cameraV4l2Device,
    // Output: pass the camera's JPEG frames through untouched.
    "-c:v", "copy",
    "-f", "mjpeg",
    "pipe:1",
  ];
}

export function ffmpegV4l2Spawner(cfg: Config): Spawner {
  return {
    start(onFrame, onExit) {
      let stopped = false;
      let done = false;
      const parser = new JpegFrameParser();

      // stderr is inherited so ffmpeg's diagnostics (device busy, unsupported
      // mode, missing device) land in the dashboard's journal; -loglevel error
      // keeps that quiet in the normal case.
      const proc = spawn(cfg.cameraFfmpegBin, ffmpegV4l2Args(cfg), {
        stdio: ["ignore", "pipe", "inherit"],
      });

      // Report death exactly once, and never after kill() -- CameraStreamer
      // treats a kill as an expected teardown, not a pipeline failure.
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        if (!stopped) onExit(code);
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (stopped || done) return;
        for (const frame of parser.push(chunk)) onFrame(frame);
      });
      // A broken pipe surfaces as the process 'exit' below; swallow it here so
      // it can't become an unhandled 'error' event.
      proc.stdout?.on("error", () => { /* handled via exit */ });
      proc.on("exit", (code) => finish(code));
      // Spawn failure: ffmpeg missing or not executable. Report nonzero so the
      // streamer's restart budget applies and it degrades to the placeholder.
      proc.on("error", () => finish(1));

      return {
        kill(): void {
          stopped = true;
          // SIGINT lets ffmpeg close the V4L2 device cleanly; SIGKILL backstop
          // so a wedged ffmpeg can't hold the device against the next start.
          try { proc.kill("SIGINT"); } catch { /* already dead */ }
          const hard = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* dead */ }
          }, KILL_GRACE_MS);
          proc.once("exit", () => clearTimeout(hard));
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard-camera.test.ts`

Expected: PASS — the whole file green, including the two new `ffmpegV4l2Args` tests.

- [ ] **Step 5: Verify it type-checks**

Run: `npm run build`

Expected: exits 0 with no output (`tsc -p tsconfig.build.json`). This is the real check on the spawner body, since it has no unit test.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/camera.ts test/dashboard-camera.test.ts
git commit -m "feat(camera): ffmpeg V4L2/UVC spawner producing native MJPEG frames"
```

---

### Task 3: Wire the selection and document the switch

**Files:**
- Modify: `tb3-mcp/src/dashboard/server.ts:6` (import), `:284-287` (spawner selection), `:301-305` (startup log)
- Modify: `tb3-mcp/deploy/HOST-SETUP.md:29`, `:41`, `:140-144`

**Interfaces:**
- Consumes: `ffmpegV4l2Spawner(cfg): Spawner` from Task 2; `cfg.cameraSource` from Task 1.
- Produces: nothing further consumes this — it is the top of the wiring.

**Context:** `main()` in `server.ts` constructs `new CameraStreamer(() => mtplvcapSpawner(cfg), { fallbackMs, enabled })`. `CameraStreamer` takes a **factory** (`makeSpawner: () => Spawner`), not a spawner, because it builds a fresh one per restart — so the selection swaps the factory, not the streamer. Nothing else in `main()` or `registerRoutes` changes.

The startup log line gains the active source. That is one string beyond the spec's letter, included deliberately: it is the cheapest on-host confirmation that a `TB3_CAMERA_SOURCE` env override in the systemd unit actually took effect.

- [ ] **Step 1: Update the import**

In `tb3-mcp/src/dashboard/server.ts`, line 6, replace:

```typescript
import { CameraStreamer, mtplvcapSpawner } from "./camera.js";
```

with:

```typescript
import { CameraStreamer, ffmpegV4l2Spawner, mtplvcapSpawner } from "./camera.js";
```

- [ ] **Step 2: Select the spawner by config**

In the same file, replace the `const camera = ...` block at lines 284-287:

```typescript
  const camera = new CameraStreamer(
    () => mtplvcapSpawner(cfg),
    { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled },
  );
```

with:

```typescript
  // Capture backend is chosen once, at startup: a camera swap is a config
  // change + restart, not a code edit. CameraStreamer wants a FACTORY because
  // it builds a fresh spawner on every restart.
  const makeSpawner = cfg.cameraSource === "v4l2"
    ? () => ffmpegV4l2Spawner(cfg)
    : () => mtplvcapSpawner(cfg);
  const camera = new CameraStreamer(
    makeSpawner,
    { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled },
  );
```

- [ ] **Step 3: Log the active source at startup**

In the same file, replace the `app.listen` callback body at lines 301-305:

```typescript
  app.listen(cfg.dashboardPort, cfg.dashboardBind, () => {
    console.log(`[tb3-dashboard] listening on http://${cfg.dashboardBind}:${cfg.dashboardPort}` +
      (cfg.dashboardAuth ? " (token required)" : "") +
      ` -> daemon :${cfg.mcpPort}, rig ${cfg.deviceHost}`);
  });
```

with:

```typescript
  app.listen(cfg.dashboardPort, cfg.dashboardBind, () => {
    console.log(`[tb3-dashboard] listening on http://${cfg.dashboardBind}:${cfg.dashboardPort}` +
      (cfg.dashboardAuth ? " (token required)" : "") +
      ` -> daemon :${cfg.mcpPort}, rig ${cfg.deviceHost}, camera ${cfg.cameraSource}`);
  });
```

- [ ] **Step 4: Verify the build and the whole suite**

Run: `npm run build && npm test`

Expected: build exits 0 with no output; vitest reports all test files passed, `0 failed` (roughly 342 tests — 337 before this plan, plus 3 config and 2 argv cases).

- [ ] **Step 5: Retitle the camera section in HOST-SETUP.md**

In `tb3-mcp/deploy/HOST-SETUP.md`, line 29, replace:

```markdown
### 2. mtplvcap (Nikon USB Live View)
```

with:

```markdown
### 2. Camera source (mtplvcap | V4L2/UVC)

Two capture backends are supported. `mtplvcap` (below) drives the Nikon over USB; `v4l2` drives a UVC camera through ffmpeg. Set up whichever one the mounted hardware needs — see **Selecting the source** below.

#### mtplvcap (Nikon USB Live View)
```

(Leave section numbering alone otherwise — later sections are cross-referenced by number, e.g. "see §4".)

- [ ] **Step 6: Document the selector and the V4L2 source**

In `tb3-mcp/deploy/HOST-SETUP.md`, insert the following immediately after the paragraph ending `` `cameraMtplvcapPort` defaults to `42839`. `` (line 41) and before `### 3. systemctl Permission for Agent Toggle`:

````markdown
#### Selecting the source

`cameraSource` picks the backend **at dashboard startup** — it is not a runtime dashboard control, so changing cameras means changing config and restarting `tb3-dashboard`:

| `cameraSource` | Backend | Use when |
|---|---|---|
| `mtplvcap` (default) | Nikon USB Live View | the D5000 (or another MTP body) is mounted |
| `v4l2` | ffmpeg reading a UVC device | an industrial/USB webcam is mounted |

Every camera key has a `TB3_CAMERA_*` env override, which is the easiest way to set it in the systemd unit:

```ini
# /etc/systemd/system/tb3-dashboard.service  ([Service] section)
Environment=TB3_CAMERA_SOURCE=v4l2
Environment=TB3_CAMERA_V4L2_DEVICE=/dev/video4
Environment=TB3_CAMERA_V4L2_SIZE=1280x720
Environment=TB3_CAMERA_V4L2_FRAMERATE=30
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart tb3-dashboard
journalctl -u tb3-dashboard -n 5   # the listening line ends with "camera v4l2"
```

The dashboard's Camera Start/Stop button and its status (`enabled`/`streaming`/`viewers`) behave identically for both sources — only the frame producer changes.

#### V4L2/UVC via ffmpeg (`cameraSource: "v4l2"`)

Requires **ffmpeg** on the host — the only extra dependency for this source:

```bash
sudo apt-get install ffmpeg
```

The dashboard spawns, on camera Start:

```bash
ffmpeg -f v4l2 -input_format mjpeg -video_size <size> -framerate <fps> \
       -i <device> -c:v copy -f mjpeg pipe:1
```

`-c:v copy` passes the camera's native MJPEG frames through with no re-encode (low CPU, low latency), so `cameraV4l2Size` / `cameraV4l2Framerate` **must name a mode the device advertises for `MJPG`**. List them before setting:

```bash
v4l2-ctl -d /dev/video4 --list-formats-ext
```

The industrial UVC camera on the AI-PC advertises `MJPG` at 1920x1080, 1280x720, 1280x960, 640x480, 640x360 and 640x640, all @30 fps.

Defaults: `cameraV4l2Device` `/dev/video4`, `cameraV4l2Size` `1280x720`, `cameraV4l2Framerate` `30`, `cameraFfmpegBin` `ffmpeg` (set an absolute path if `ffmpeg` is not on the service user's `$PATH`). Stop SIGINTs ffmpeg and releases the device.
````

- [ ] **Step 7: Extend the troubleshooting entry**

In `tb3-mcp/deploy/HOST-SETUP.md`, under **Camera feed shows "fallback" or no video** (around line 140), append these bullets after the existing `cameraMtplvcapBin` / `cameraMtplvcapPort` bullet:

```markdown
- With `cameraSource: "v4l2"`: confirm ffmpeg is installed (`ffmpeg -version`) and the device exists (`ls -l /dev/video4`)
- Check nothing else holds the device: `fuser -v /dev/video4`
- Confirm the configured size/framerate appears under `MJPG` in `v4l2-ctl -d /dev/video4 --list-formats-ext` — an unsupported mode makes ffmpeg exit immediately, and after the restart budget is spent the tile falls back to the placeholder
- ffmpeg's stderr goes to the dashboard journal: `journalctl -u tb3-dashboard -n 50`
```

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/server.ts deploy/HOST-SETUP.md
git commit -m "feat(camera): select spawner by cameraSource; document the v4l2 switch"
```

- [ ] **Step 9: On-host manual verification (requires the host — not a blocker for the commits above)**

On `atomist@192.168.4.71`, with the built dashboard and `TB3_CAMERA_SOURCE=v4l2`:

1. `journalctl -u tb3-dashboard -n 5` → the listening line ends with `camera v4l2`.
2. Dashboard → **Camera Start** → live video from `/dev/video4`; status goes STARTING → ON.
3. `pgrep -af ffmpeg` → exactly one ffmpeg with the configured device/size/framerate.
4. **Camera Stop** → ffmpeg is gone (`pgrep -af ffmpeg` empty), the tile shows the placeholder, and the device is free (`fuser -v /dev/video4` reports nothing).
5. Degradation: Start, then `sudo fuser -k /dev/video4` (or unplug) → the tile falls back to the placeholder after the restart budget, no crash; restoring the device and clicking Stop→Start recovers live video.
6. Regression: set `TB3_CAMERA_SOURCE=mtplvcap` (or remove it), restart → the Nikon path still works unchanged.

---

## Done when

- `npm run build` and `npm test` are green.
- Default config (`cameraSource` unset) spawns mtplvcap exactly as before.
- `TB3_CAMERA_SOURCE=v4l2` streams `/dev/video4` through ffmpeg with no re-encode.
- `deploy/HOST-SETUP.md` documents the ffmpeg prerequisite, the selector, and v4l2 troubleshooting.
- Branch `feat/camera-source` is ready to merge to `main` (the repo owner runs the push).
