# MediaMTX + WebRTC Transport with MCP-Driven Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MJPEG multipart relay with ffmpeg → MediaMTX → WebRTC, and add recording + snapshots driven by the MCP daemon's tracking state.

**Architecture:** MediaMTX runs as an always-up systemd service with one path (`source: publisher`). The dashboard spawns ffmpeg to publish H.264 into it (reusing the existing `Spawner` abstraction and restart-budget logic), and reverse-proxies WHEP signaling so the existing auth gate covers video. The MCP daemon independently drives recording and snapshots via MediaMTX's control API — neither process calls the other; both meet at MediaMTX.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 24, Express, Zod, vitest. Frontend is vanilla JS with **no build step**. MediaMTX (external, systemd). ffmpeg 8.1.2 (asdf-managed on the host).

**Spec:** `docs/superpowers/specs/2026-07-26-mediamtx-webrtc-design.md`

## Global Constraints

- **No new npm dependencies.** WHEP uses native `RTCPeerConnection`; the control API uses native `fetch`.
- **`dashboard/public/` is vanilla JS + CSS, served static, NO build step.** ES modules only, shared with vitest where testable.
- **Tests: vitest.** `npm test` at `tb3-mcp/`. Every task ends green.
- **Typechecking — two configs, and `npm run build` is NOT enough.** `npm run build` uses `tsconfig.build.json`, whose `include` is `src/**/*.ts` only, so it never checks the test tree. Also run `npx tsc -p tsconfig.json --noEmit`, which does.
  - **Known baseline (measured at branch point `24157a2`): exactly 2 errors**, both `TS7016`, in `test/minimap.test.ts:2` and `test/rigview-math.test.ts:2`. They come from importing untyped plain-JS ES modules out of `dashboard/public/` — the deliberate no-build-step architecture. Do not "fix" them.
  - **Your task must add no error beyond that baseline**, with one expected exception: Tasks 8 and 12 add `whep.js` and `capture-label.js` tests that import from `dashboard/public/` the same way, so each legitimately adds one more `TS7016` of exactly that shape. Any *other* new error is a regression.
  - There is no CI and no `typecheck` npm script; this check is manual and easy to skip, which is precisely how a regression landed in Task 4.
- **Imports use `.js` extensions** (NodeNext ESM), even from `.ts` sources.
- **The capture path must never block the tracking tick.** Every capture call is fire-and-forget with a bounded timeout; none are awaited on the control path.
- **Default `cameraSource` stays `"mtplvcap"`.** This feature ships inert; a host that doesn't opt in is unaffected.
- **Existing MJPEG tests must keep passing unchanged.** The file split is a move, not a rewrite.
- **Encoder default is `"nvenc"`.** The operator installed `jellyfin-ffmpeg8` (8.1.2-2-trixie) on 2026-07-26, which provides `h264_nvenc`, the `v4l2` demuxer, the `rtsp` muxer, and `mjpeg_cuvid`. `vulkan` stays implemented as a verified fallback.
- **Never use a bare `"ffmpeg"` on the host** — config carries absolute paths. The binary is `/usr/lib/jellyfin-ffmpeg/ffmpeg` (with `/usr/local/bin/ffmpeg` symlinked to it). A toolchain change silently moves this path; it already moved once.
- **Camera device is always the `/dev/v4l/by-id/...` alias**, never `/dev/videoN`.

## Plan Refinements to the Spec

Two deliberate deviations, both noted here rather than applied silently:

1. **`mediamtx-client.ts` lives at `src/mediamtx/client.ts`, not `src/capture/`.** The spec placed it daemon-side, but the dashboard also needs it (to read the path's reader count for `viewers`). Shared placement avoids duplicating it.
2. **Phase 1 (Tasks 1–8) is independently shippable.** It delivers working WebRTC video with no capture features. Verify it on the rig before starting Phase 2.

---

# PHASE 1 — Transport

### Task 1: Split `camera.ts` into `camera/`, extract `SpawnSupervisor`

Pure refactor. No behavior change. Existing tests must pass untouched except for the import path.

**Files:**
- Create: `src/dashboard/camera/index.ts`, `src/dashboard/camera/supervisor.ts`, `src/dashboard/camera/jpeg-parser.ts`, `src/dashboard/camera/mjpeg-streamer.ts`, `src/dashboard/camera/mtplvcap.ts`, `src/dashboard/camera/v4l2.ts`
- Delete: `src/dashboard/camera.ts`
- Modify: `test/dashboard-camera.test.ts:3` (import path only)
- Test: `test/camera-supervisor.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface Spawner { start(onFrame: (jpeg: Buffer) => void, onExit: (code: number | null) => void): { kill(): void } }`
  - `class SpawnSupervisor` — `constructor(makeSpawner: () => Spawner, opts: SupervisorOpts)`, methods `sync(): void`, `running(): boolean`, `frameSeen(): boolean`, `teardown(): void`, `stop(): void`
  - `interface SupervisorOpts { fallbackMs: number; shouldRun: () => boolean; onFrame?: (jpeg: Buffer) => void; onDegraded?: () => void; maxRestarts?: number; restartWindowMs?: number }`
  - `class CameraStreamer`, `class JpegFrameParser`, `function mtplvcapSpawner(cfg: Config): Spawner`, `function ffmpegV4l2Args(cfg: Config): string[]`, `function ffmpegV4l2Spawner(cfg: Config): Spawner` — all unchanged, re-exported from `index.ts`
  - `interface CameraStatus { enabled: boolean; streaming: boolean; viewers: number }`

- [ ] **Step 1: Write the failing supervisor test**

Create `test/camera-supervisor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpawnSupervisor, type Spawner } from "../src/dashboard/camera/supervisor.js";

function fakeSpawnerFactory() {
  const state = {
    starts: 0,
    kills: 0,
    lastOnFrame: null as ((jpeg: Buffer) => void) | null,
    lastOnExit: null as ((code: number | null) => void) | null,
  };
  const makeSpawner = (): Spawner => ({
    start(onFrame, onExit) {
      state.starts += 1;
      state.lastOnFrame = onFrame;
      state.lastOnExit = onExit;
      return { kill: () => { state.kills += 1; } };
    },
  });
  return { makeSpawner, state };
}

describe("SpawnSupervisor", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start while shouldRun() is false", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => false });
    sup.sync();
    expect(f.state.starts).toBe(0);
    expect(sup.running()).toBe(false);
  });

  it("starts once when shouldRun() is true and is idempotent", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => true });
    sup.sync();
    sup.sync();
    sup.sync();
    expect(f.state.starts).toBe(1);
    expect(sup.running()).toBe(true);
  });

  it("ignores frames from a torn-down generation", () => {
    const f = fakeSpawnerFactory();
    const frames: Buffer[] = [];
    const sup = new SpawnSupervisor(f.makeSpawner, {
      fallbackMs: 1500, shouldRun: () => true, onFrame: (b) => frames.push(b),
    });
    sup.sync();
    const staleOnFrame = f.state.lastOnFrame!;
    sup.teardown();
    staleOnFrame(Buffer.from([0xff, 0xd8]));
    expect(frames).toHaveLength(0);
  });

  it("restarts after fallbackMs when the pipeline exits", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => true });
    sup.sync();
    f.state.lastOnExit!(1);
    expect(f.state.starts).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(f.state.starts).toBe(2);
  });

  it("gives up and reports degraded after exceeding the restart budget", () => {
    const f = fakeSpawnerFactory();
    const onDegraded = vi.fn();
    const sup = new SpawnSupervisor(f.makeSpawner, {
      fallbackMs: 10, shouldRun: () => true, onDegraded, maxRestarts: 3, restartWindowMs: 60_000,
    });
    sup.sync();
    for (let i = 0; i < 4; i++) {
      f.state.lastOnExit!(1);
      vi.advanceTimersByTime(10);
    }
    expect(onDegraded).toHaveBeenCalled();
    expect(f.state.starts).toBe(4); // initial + 3 restarts, then the budget stops it
  });

  it("does not restart when shouldRun() has gone false", () => {
    const f = fakeSpawnerFactory();
    let run = true;
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => run });
    sup.sync();
    run = false;
    f.state.lastOnExit!(1);
    vi.advanceTimersByTime(100);
    expect(f.state.starts).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd tb3-mcp && npx vitest run test/camera-supervisor.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard/camera/supervisor.js`.

- [ ] **Step 3: Create `src/dashboard/camera/supervisor.ts`**

```ts
export interface Spawner {
  start(onFrame: (jpeg: Buffer) => void, onExit: (code: number | null) => void): { kill(): void };
}

export interface SupervisorOpts {
  // How long to wait before restarting a dead pipeline.
  fallbackMs: number;
  // The single behavioral difference between pipelines: the MJPEG streamer
  // answers `armed && viewers > 0`; the MediaMTX publisher answers `armed`.
  shouldRun: () => boolean;
  onFrame?: (jpeg: Buffer) => void;
  // Called once when the restart budget is exhausted.
  onDegraded?: () => void;
  maxRestarts?: number;
  restartWindowMs?: number;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

// Owns the spawn/restart/teardown lifecycle shared by every camera pipeline:
// a generation counter that discards callbacks from a killed spawner, a bounded
// restart budget with window forgiveness, and a backoff timer.
export class SpawnSupervisor {
  private handle: { kill(): void } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private restartWindowStart = 0;
  private stopped = false;
  private seenFrame = false;
  // Bumped on every teardown so a late frame/exit callback from an outgoing
  // spawner cannot resurrect a stale frame or null out a fresh handle.
  private generation = 0;

  constructor(
    private readonly makeSpawner: () => Spawner,
    private readonly opts: SupervisorOpts,
  ) {}

  running(): boolean { return this.handle !== null; }
  frameSeen(): boolean { return this.seenFrame; }

  // Reconcile the pipeline against shouldRun(). Safe to call repeatedly.
  sync(): void {
    if (this.stopped) return;
    if (this.opts.shouldRun()) this.start();
    else this.teardown();
  }

  // Tear the current pipeline down without ending the supervisor's life.
  teardown(): void {
    this.clearRestartTimer();
    this.kill();
    this.restartCount = 0;
    this.seenFrame = false;
  }

  // Permanent shutdown.
  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private start(): void {
    if (this.stopped || this.handle) return;
    const gen = ++this.generation;
    this.seenFrame = false;
    const spawner = this.makeSpawner();
    this.handle = spawner.start(
      (jpeg) => {
        if (gen !== this.generation) return;
        this.seenFrame = true;
        this.opts.onFrame?.(jpeg);
      },
      (code) => { if (gen === this.generation) this.handleExit(code); },
    );
  }

  private kill(): void {
    if (!this.handle) return;
    this.generation++;
    try { this.handle.kill(); } catch { /* already dead */ }
    this.handle = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  private handleExit(code: number | null): void {
    this.handle = null;
    if (this.stopped) return;
    if (!this.opts.shouldRun()) return; // expected teardown, not a failure

    const max = this.opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    const window = this.opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    const now = Date.now();
    if (now - this.restartWindowStart > window) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
    this.restartCount += 1;

    if (this.restartCount > max) {
      console.error(`[tb3-camera] pipeline exited (code=${code}) ${this.restartCount} times within ${window}ms; giving up`);
      this.seenFrame = false;
      this.opts.onDegraded?.();
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.opts.fallbackMs);
  }
}
```

- [ ] **Step 4: Run the supervisor test — it should pass**

Run: `npx vitest run test/camera-supervisor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Move the existing code into the folder, unchanged**

Split `src/dashboard/camera.ts` verbatim:
- `jpeg-parser.ts` ← `JpegFrameParser` (lines 233–263) + the `SOI`/`EOI` constants.
- `mjpeg-streamer.ts` ← `CameraStatus`, `CameraStreamerOpts`, `BOUNDARY`, `PLACEHOLDER_JPEG*`, `frameChunk()`, `CameraStreamer` (lines 13–231). Import `Spawner` from `./supervisor.js`.
- `mtplvcap.ts` ← `mtplvcapSpawner` + `CONNECT_RETRIES`, `CONNECT_DELAY_MS`, `NIKON_VENDOR_ID`, `KILL_GRACE_MS`, `activeProc`. Import `JpegFrameParser` from `./jpeg-parser.js`.
- `v4l2.ts` ← `ffmpegV4l2Args`, `ffmpegV4l2Spawner`. Import `JpegFrameParser` from `./jpeg-parser.js` and `KILL_GRACE_MS` from `./mtplvcap.js` (export it there).

**Do not refactor `CameraStreamer` to use `SpawnSupervisor` in this task.** Keeping it untouched is what makes the existing tests a valid regression guard for the move.

This leaves the restart/generation logic duplicated between `CameraStreamer` and `SpawnSupervisor` **for the duration of Phase 1 only** — a known, tracked condition, not an oversight. **Task 8b migrates it** once WebRTC is proven on the rig, so the risky refactor of the fallback path happens while a known-good path exists. Reviewers: this duplication is expected until Task 8b.

Create `src/dashboard/camera/index.ts`:

```ts
export { SpawnSupervisor, type Spawner, type SupervisorOpts } from "./supervisor.js";
export { JpegFrameParser } from "./jpeg-parser.js";
export { CameraStreamer, type CameraStatus, type CameraStreamerOpts } from "./mjpeg-streamer.js";
export { mtplvcapSpawner } from "./mtplvcap.js";
export { ffmpegV4l2Args, ffmpegV4l2Spawner } from "./v4l2.js";
```

Delete `src/dashboard/camera.ts`.

- [ ] **Step 6: Update the two import sites**

In `test/dashboard-camera.test.ts:3` and `src/dashboard/server.ts:6`, change
`from "../src/dashboard/camera.js"` / `from "./camera.js"` to
`.../camera/index.js` / `./camera/index.js`.

- [ ] **Step 7: Full suite must be green**

Run: `npm test`
Expected: PASS. All pre-existing camera tests pass **unchanged** — that is the regression guard for this refactor.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/camera src/dashboard/server.ts test/dashboard-camera.test.ts test/camera-supervisor.test.ts
git rm src/dashboard/camera.ts
git commit -m "refactor(camera): split camera.ts into camera/, extract SpawnSupervisor"
```

---

### Task 2: Config fields for the MediaMTX path

**Files:**
- Modify: `src/config.ts:75` (enum), `src/config.ts:87` (new fields), `src/config.ts:170` (env overrides)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` gains `cameraSource: "mtplvcap" | "v4l2" | "mediamtx"`, `cameraEncoder: "vulkan" | "nvenc" | "x264" | "copy"`, `cameraVideoBitrate: string`, `cameraMediamtxSize: string`, `cameraMediamtxRtspUrl: string`, `cameraMediamtxHttpUrl: string`, `cameraMediamtxPath: string`, `cameraMediamtxControlUrl: string`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
describe("MediaMTX camera config", () => {
  it("defaults the MediaMTX fields", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraSource).toBe("mtplvcap");        // still inert by default
    expect(c.cameraEncoder).toBe("nvenc");
    expect(c.cameraVideoBitrate).toBe("6M");
    expect(c.cameraMediamtxSize).toBe("1920x1080");
    expect(c.cameraMediamtxRtspUrl).toBe("rtsp://127.0.0.1:8554/tb3");
    expect(c.cameraMediamtxHttpUrl).toBe("http://127.0.0.1:8889");
    expect(c.cameraMediamtxControlUrl).toBe("http://127.0.0.1:9997");
    expect(c.cameraMediamtxPath).toBe("tb3");
  });

  it("keeps cameraV4l2Size at 720p so the MJPEG fallback stays conservative", () => {
    // 1080p MJPEG is ~3x the byte rate and CameraStreamer.writeChunk has no
    // backpressure -- raising this would worsen a known OOM on the fallback path.
    const c = loadConfig(undefined, {});
    expect(c.cameraV4l2Size).toBe("1280x720");
  });

  it("accepts mediamtx as a source", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(c.cameraSource).toBe("mediamtx");
  });

  it("applies MediaMTX env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_ENCODER: "vulkan",
      TB3_CAMERA_VIDEO_BITRATE: "12M",
      TB3_CAMERA_MEDIAMTX_SIZE: "3840x2160",
      TB3_CAMERA_MEDIAMTX_PATH: "cam2",
    });
    expect(c.cameraEncoder).toBe("vulkan");
    expect(c.cameraVideoBitrate).toBe("12M");
    expect(c.cameraMediamtxSize).toBe("3840x2160");
    expect(c.cameraMediamtxPath).toBe("cam2");
  });

  it("rejects an unknown encoder", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_ENCODER: "h265" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `cameraEncoder` is undefined.

- [ ] **Step 3: Add the fields**

In `src/config.ts`, replace the `cameraSource` line (currently line 75):

```ts
    // "mtplvcap" = Nikon USB Live View; "v4l2" = a UVC camera via ffmpeg
    // producing MJPEG for the in-process relay; "mediamtx" = a UVC camera via
    // ffmpeg encoding H.264 and publishing to a local MediaMTX for WebRTC.
    cameraSource: z.enum(["mtplvcap", "v4l2", "mediamtx"]).default("mtplvcap"),
```

Then, after `cameraFfmpegBin` (line 87), add:

```ts
    // --- MediaMTX/WebRTC source (read only when cameraSource === "mediamtx") ---
    // The camera has no native H.264 mode, so this path always transcodes.
    // "nvenc" is the default: jellyfin-ffmpeg8 on the host provides
    // h264_nvenc, and NVENC is far better exercised in WebRTC pipelines than
    // Vulkan encode. "vulkan" is a verified fallback on this hardware. All
    // values are validated against `ffmpeg -encoders` at startup.
    cameraEncoder: z.enum(["nvenc", "vulkan", "x264", "copy"]).default("nvenc"),
    cameraVideoBitrate: z.string().min(1).default("6M"),
    // Separate from cameraV4l2Size ON PURPOSE: the MJPEG fallback must stay at
    // 720p because its fan-out has no backpressure. 4K is valid here but the
    // camera shares a 480 Mbps USB controller with the ADS-B receiver and
    // draws 91 Mbps at 4K30 -- move one device off that bus first.
    cameraMediamtxSize: z.string().min(1).default("1920x1080"),
    cameraMediamtxRtspUrl: z.string().min(1).default("rtsp://127.0.0.1:8554/tb3"),
    cameraMediamtxHttpUrl: z.string().min(1).default("http://127.0.0.1:8889"),
    cameraMediamtxControlUrl: z.string().min(1).default("http://127.0.0.1:9997"),
    cameraMediamtxPath: z.string().min(1).default("tb3"),
```

After `set("cameraFfmpegBin", ...)` (line 170), add:

```ts
  set("cameraEncoder", env.TB3_CAMERA_ENCODER);
  set("cameraVideoBitrate", env.TB3_CAMERA_VIDEO_BITRATE);
  set("cameraMediamtxSize", env.TB3_CAMERA_MEDIAMTX_SIZE);
  set("cameraMediamtxRtspUrl", env.TB3_CAMERA_MEDIAMTX_RTSP_URL);
  set("cameraMediamtxHttpUrl", env.TB3_CAMERA_MEDIAMTX_HTTP_URL);
  set("cameraMediamtxControlUrl", env.TB3_CAMERA_MEDIAMTX_CONTROL_URL);
  set("cameraMediamtxPath", env.TB3_CAMERA_MEDIAMTX_PATH);
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(camera): config fields for the MediaMTX/WebRTC source"
```

---

### Task 3: `ffmpegRtspArgs` — the pure argv builder

The highest-value test in this plan. Every mistake here fails **silently at runtime** rather than erroring.

**Files:**
- Create: `src/dashboard/camera/rtsp.ts`
- Modify: `src/dashboard/camera/index.ts`
- Test: `test/camera-rtsp-args.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `Spawner` + `KILL_GRACE_MS` (Task 1).
- Produces: `function ffmpegRtspArgs(cfg: Config): string[]`, `function ffmpegRtspSpawner(cfg: Config): Spawner`, `function encoderName(cfg: Config): string | null` (returns the ffmpeg encoder id, or `null` for `copy`).

- [ ] **Step 1: Write the failing test**

Create `test/camera-rtsp-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ffmpegRtspArgs, encoderName } from "../src/dashboard/camera/rtsp.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", ...over });
}
const idx = (a: string[], f: string): number => a.indexOf(f);

describe("ffmpegRtspArgs — ordering invariants", () => {
  it("puts every v4l2 input option BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg());
    const i = idx(a, "-i");
    expect(i).toBeGreaterThan(-1);
    for (const flag of ["-f", "-input_format", "-video_size", "-framerate"]) {
      expect(idx(a, flag)).toBeLessThan(i);
    }
  });

  it("puts vulkan hw-device init BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(idx(a, "-init_hw_device")).toBeLessThan(idx(a, "-i"));
    expect(idx(a, "-filter_hw_device")).toBeLessThan(idx(a, "-i"));
  });

  it("puts the RTSP target last", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/tb3");
    expect(a[a.length - 2]).toBe("-rtsp_transport");   // -f rtsp -rtsp_transport tcp <url>
  });
});

describe("ffmpegRtspArgs — encoder selection", () => {
  it("vulkan uses hwupload and never -pix_fmt yuv420p", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(a).toContain("h264_vulkan");
    expect(a).toContain("format=nv12,hwupload");
    expect(a).not.toContain("yuv420p");
  });

  it("nvenc uses -pix_fmt yuv420p and no vulkan device", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc" }));
    expect(a).toContain("h264_nvenc");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
    expect(a).not.toContain("format=nv12,hwupload");
  });

  it("x264 uses libx264 with a low-latency preset", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "x264" }));
    expect(a).toContain("libx264");
    expect(a).toContain("veryfast");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
  });

  it("copy passes through and sets no bitrate", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "copy" }));
    expect(a).toContain("copy");
    expect(a).not.toContain("-b:v");
  });

  it("encoderName maps config to the ffmpeg encoder id", () => {
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "vulkan" }))).toBe("h264_vulkan");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "nvenc" }))).toBe("h264_nvenc");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "x264" }))).toBe("libx264");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "copy" }))).toBeNull();
  });
});

describe("ffmpegRtspArgs — plumbing", () => {
  it("uses cameraMediamtxSize, NOT cameraV4l2Size", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_MEDIAMTX_SIZE: "3840x2160", TB3_CAMERA_V4L2_SIZE: "640x480" }));
    expect(a[idx(a, "-video_size") + 1]).toBe("3840x2160");
  });

  it("plumbs device, framerate, bitrate and target", () => {
    const a = ffmpegRtspArgs(cfg({
      TB3_CAMERA_V4L2_DEVICE: "/dev/v4l/by-id/usb-4K_USB_Camera-video-index0",
      TB3_CAMERA_V4L2_FRAMERATE: "25",
      TB3_CAMERA_VIDEO_BITRATE: "12M",
      TB3_CAMERA_MEDIAMTX_RTSP_URL: "rtsp://127.0.0.1:8554/cam2",
    }));
    expect(a[idx(a, "-i") + 1]).toBe("/dev/v4l/by-id/usb-4K_USB_Camera-video-index0");
    expect(a[idx(a, "-framerate") + 1]).toBe("25");
    expect(a[idx(a, "-b:v") + 1]).toBe("12M");
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/cam2");
  });

  it("requests MJPEG input (the camera has no native H.264)", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[idx(a, "-input_format") + 1]).toBe("mjpeg");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/camera-rtsp-args.test.ts`
Expected: FAIL — cannot resolve `rtsp.js`.

- [ ] **Step 3: Implement `src/dashboard/camera/rtsp.ts`**

```ts
import { spawn } from "node:child_process";
import type { Config } from "../../config.js";
import type { Spawner } from "./supervisor.js";
import { KILL_GRACE_MS } from "./mtplvcap.js";

// The ffmpeg encoder id for the configured encoder; null means stream copy.
export function encoderName(cfg: Config): string | null {
  switch (cfg.cameraEncoder) {
    case "vulkan": return "h264_vulkan";
    case "nvenc": return "h264_nvenc";
    case "x264": return "libx264";
    case "copy": return null;
  }
}

// Reads the UVC device's MJPEG, transcodes to H.264, publishes RTSP to MediaMTX.
//
// TWO independent ordering rules apply and BOTH fail silently if broken:
//   1. -init_hw_device / -filter_hw_device must precede the input, or the
//      Vulkan filter chain has no device and falls back or errors obscurely.
//   2. All v4l2 input options must precede -i, or ffmpeg ignores them and
//      negotiates some other mode -- yielding a live, plausible, WRONG stream.
export function ffmpegRtspArgs(cfg: Config): string[] {
  const enc = encoderName(cfg);
  const vulkan = cfg.cameraEncoder === "vulkan";

  const pre: string[] = ["-hide_banner", "-loglevel", "error"];
  if (vulkan) pre.push("-init_hw_device", "vulkan=vk:0", "-filter_hw_device", "vk");

  const input: string[] = [
    "-f", "v4l2",
    "-input_format", "mjpeg",
    "-video_size", cfg.cameraMediamtxSize,
    "-framerate", String(cfg.cameraV4l2Framerate),
    "-i", cfg.cameraV4l2Device,
  ];

  const out: string[] = [];
  if (enc === null) {
    out.push("-c:v", "copy");
  } else if (vulkan) {
    // Vulkan encodes from a GPU-side nv12 frame; -pix_fmt does not apply.
    out.push("-vf", "format=nv12,hwupload", "-c:v", enc, "-b:v", cfg.cameraVideoBitrate);
  } else if (enc === "h264_nvenc") {
    out.push("-c:v", enc, "-preset", "p4", "-tune", "ll", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p");
  } else {
    out.push("-c:v", enc, "-preset", "veryfast", "-tune", "zerolatency", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p");
  }

  return [...pre, ...input, ...out, "-f", "rtsp", "-rtsp_transport", "tcp", cfg.cameraMediamtxRtspUrl];
}

// NOT unit-tested (real subprocess), same convention as ffmpegV4l2Spawner.
// Unlike the MJPEG spawners this never calls onFrame: ffmpeg writes straight to
// MediaMTX over RTSP, so there is no frame stream to relay.
export function ffmpegRtspSpawner(cfg: Config): Spawner {
  return {
    start(_onFrame, onExit) {
      let stopped = false;
      let done = false;

      const proc = spawn(cfg.cameraFfmpegBin, ffmpegRtspArgs(cfg), {
        stdio: ["ignore", "ignore", "inherit"],
      });

      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        if (!stopped) onExit(code);
      };

      proc.on("exit", (code) => finish(code));
      proc.on("error", () => finish(1)); // ffmpeg missing or not executable

      return {
        kill(): void {
          stopped = true;
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

In `src/dashboard/camera/mtplvcap.ts`, change `const KILL_GRACE_MS = 4000;` to `export const KILL_GRACE_MS = 4000;`.

Add to `src/dashboard/camera/index.ts`:

```ts
export { ffmpegRtspArgs, ffmpegRtspSpawner, encoderName } from "./rtsp.js";
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/camera/rtsp.ts src/dashboard/camera/index.ts src/dashboard/camera/mtplvcap.ts test/camera-rtsp-args.test.ts
git commit -m "feat(camera): ffmpegRtspArgs + RTSP publisher spawner"
```

---

### Task 4: MediaMTX control-API client

**Files:**
- Create: `src/mediamtx/client.ts`
- Test: `test/mediamtx-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PathInfo { name: string; ready: boolean; readers: number }`
  - `class MediaMtxClient` — `constructor(opts: { controlUrl: string; path: string; timeoutMs?: number })`, methods `pathInfo(): Promise<PathInfo | null>`, `setRecord(on: boolean): Promise<void>`, `lastError(): string | null`
  - `function parsePathInfo(json: unknown): PathInfo | null`

- [ ] **Step 1: Write the failing test**

Create `test/mediamtx-client.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { MediaMtxClient, parsePathInfo } from "../src/mediamtx/client.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("parsePathInfo", () => {
  it("reads name, ready and reader count", () => {
    expect(parsePathInfo({ name: "tb3", ready: true, readers: [{}, {}] }))
      .toEqual({ name: "tb3", ready: true, readers: 2 });
  });

  it("treats a missing readers array as zero", () => {
    expect(parsePathInfo({ name: "tb3", ready: false })).toEqual({ name: "tb3", ready: false, readers: 0 });
  });

  it("returns null for junk", () => {
    expect(parsePathInfo(null)).toBeNull();
    expect(parsePathInfo({ nope: 1 })).toBeNull();
  });
});

describe("MediaMtxClient", () => {
  const mk = () => new MediaMtxClient({ controlUrl: "http://127.0.0.1:9997", path: "tb3", timeoutMs: 500 });

  it("returns parsed path info on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ name: "tb3", ready: true, readers: [{}] }), { status: 200 })));
    expect(await mk().pathInfo()).toEqual({ name: "tb3", ready: true, readers: 1 });
  });

  it("returns null and records the error on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const c = mk();
    expect(await c.pathInfo()).toBeNull();
    expect(c.lastError()).toContain("404");
  });

  it("returns null and records the error when the socket is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const c = mk();
    expect(await c.pathInfo()).toBeNull();
    expect(c.lastError()).toContain("ECONNREFUSED");
  });

  it("setRecord PATCHes the record flag", async () => {
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mk().setRecord(true);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v3/config/paths/patch/tb3");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ record: true });
  });

  it("setRecord rejects on failure so callers can surface it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(mk().setRecord(false)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/mediamtx-client.test.ts`
Expected: FAIL — cannot resolve `client.js`.

- [ ] **Step 3: Implement `src/mediamtx/client.ts`**

```ts
export interface PathInfo {
  name: string;
  ready: boolean;
  readers: number;
}

export function parsePathInfo(json: unknown): PathInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  return {
    name: o.name,
    ready: o.ready === true,
    readers: Array.isArray(o.readers) ? o.readers.length : 0,
  };
}

const DEFAULT_TIMEOUT_MS = 3000;

// Talks to MediaMTX's control API over loopback. Both the dashboard (reader
// count) and the daemon (record valve) use this; neither process calls the
// other, so MediaMTX is where they meet.
//
// NOTE: verify /v3/config/paths/patch/{name} against the pinned MediaMTX
// version at deploy time -- the route is version-dependent.
export class MediaMtxClient {
  private readonly controlUrl: string;
  private readonly path: string;
  private readonly timeoutMs: number;
  private err: string | null = null;

  constructor(opts: { controlUrl: string; path: string; timeoutMs?: number }) {
    this.controlUrl = opts.controlUrl.replace(/\/+$/, "");
    this.path = opts.path;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  lastError(): string | null { return this.err; }

  private async call(url: string, init?: RequestInit): Promise<Response> {
    const ctl = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(url, { ...init, signal: ctl });
    if (!res.ok) throw new Error(`mediamtx HTTP ${res.status}`);
    return res;
  }

  // Soft read: never throws. A missing MediaMTX must not break status polling.
  async pathInfo(): Promise<PathInfo | null> {
    try {
      const res = await this.call(`${this.controlUrl}/v3/paths/get/${encodeURIComponent(this.path)}`);
      const info = parsePathInfo(await res.json());
      this.err = info ? null : "unparseable path info";
      return info;
    } catch (e: unknown) {
      this.err = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  // Hard write: throws so the caller can log and surface it. Recording must
  // never silently not-happen.
  async setRecord(on: boolean): Promise<void> {
    try {
      await this.call(`${this.controlUrl}/v3/config/paths/patch/${encodeURIComponent(this.path)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record: on }),
      });
      this.err = null;
    } catch (e: unknown) {
      this.err = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
}
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mediamtx test/mediamtx-client.test.ts
git commit -m "feat(mediamtx): control-API client for path info and the record valve"
```

---

### Task 5: `MediaMtxPublisher`

**Files:**
- Create: `src/dashboard/camera/publisher.ts`
- Modify: `src/dashboard/camera/index.ts`
- Test: `test/camera-publisher.test.ts`

**Interfaces:**
- Consumes: `SpawnSupervisor`, `Spawner` (Task 1); `CameraStatus` (Task 1).
- Produces: `class MediaMtxPublisher` — `constructor(makeSpawner: () => Spawner, opts: { fallbackMs: number; enabled?: boolean })`, methods `enable(): void`, `disable(): void`, `stop(): void`, `status(): CameraStatus`, `setReaderCount(n: number): void`, `isArmed(): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/camera-publisher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MediaMtxPublisher } from "../src/dashboard/camera/publisher.js";
import type { Spawner } from "../src/dashboard/camera/supervisor.js";

function fakeSpawnerFactory() {
  const state = { starts: 0, kills: 0, lastOnExit: null as ((c: number | null) => void) | null };
  const makeSpawner = (): Spawner => ({
    start(_onFrame, onExit) {
      state.starts += 1;
      state.lastOnExit = onExit;
      return { kill: () => { state.kills += 1; } };
    },
  });
  return { makeSpawner, state };
}

describe("MediaMtxPublisher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not publish until armed", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    expect(f.state.starts).toBe(0);
    expect(p.status().enabled).toBe(false);
  });

  it("publishes on enable() with ZERO viewers -- ingest must not depend on viewers", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    p.enable();
    expect(f.state.starts).toBe(1);
    expect(p.status()).toEqual({ enabled: true, streaming: true, viewers: 0 });
  });

  it("keeps publishing when the reader count drops to zero", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    p.enable();
    p.setReaderCount(3);
    expect(p.status().viewers).toBe(3);
    p.setReaderCount(0);
    expect(p.status().viewers).toBe(0);
    expect(f.state.kills).toBe(0);          // the whole point: unattended recording
    expect(p.status().streaming).toBe(true);
  });

  it("starts armed when constructed with enabled: true", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    expect(f.state.starts).toBe(1);
  });

  it("disable() kills the publisher and releases the device", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    p.disable();
    expect(f.state.kills).toBe(1);
    expect(p.status()).toEqual({ enabled: false, streaming: false, viewers: 0 });
  });

  it("restarts a dead publisher while still armed", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    f.state.lastOnExit!(1);
    vi.advanceTimersByTime(1500);
    expect(f.state.starts).toBe(2);
  });

  it("does not restart after disable()", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    p.disable();
    vi.advanceTimersByTime(10_000);
    expect(f.state.starts).toBe(1);
  });

  it("isArmed reflects the arm state for the capture controller", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    expect(p.isArmed()).toBe(false);
    p.enable();
    expect(p.isArmed()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/camera-publisher.test.ts`
Expected: FAIL — cannot resolve `publisher.js`.

- [ ] **Step 3: Implement `src/dashboard/camera/publisher.ts`**

```ts
import { SpawnSupervisor, type Spawner } from "./supervisor.js";
import type { CameraStatus } from "./mjpeg-streamer.js";

export interface MediaMtxPublisherOpts {
  fallbackMs: number;
  enabled?: boolean;
}

// Arm-driven publisher: while armed, ffmpeg publishes to MediaMTX whether or
// not anyone is watching. That is the deliberate difference from CameraStreamer
// -- recording an unattended aircraft pass requires ingest that viewers do not
// gate. Stop is still a hard device release.
export class MediaMtxPublisher {
  private armed: boolean;
  private readers = 0;
  private readonly sup: SpawnSupervisor;

  constructor(makeSpawner: () => Spawner, opts: MediaMtxPublisherOpts) {
    this.armed = opts.enabled ?? false;
    this.sup = new SpawnSupervisor(makeSpawner, {
      fallbackMs: opts.fallbackMs,
      shouldRun: () => this.armed,
    });
    this.sup.sync();
  }

  isArmed(): boolean { return this.armed; }

  status(): CameraStatus {
    return {
      enabled: this.armed,
      // No frame callback exists on this path (ffmpeg writes straight to
      // RTSP), so "streaming" means the publisher process is up. Whether
      // MediaMTX considers the path ready is reported separately via
      // setReaderCount's poll.
      streaming: this.sup.running(),
      viewers: this.readers,
    };
  }

  // Fed by the dashboard's periodic MediaMTX path poll.
  setReaderCount(n: number): void { this.readers = Math.max(0, n); }

  enable(): void {
    this.armed = true;
    this.sup.sync();
  }

  disable(): void {
    this.armed = false;
    this.readers = 0;
    this.sup.sync();
  }

  stop(): void {
    this.armed = false;
    this.readers = 0;
    this.sup.stop();
  }
}
```

Add to `src/dashboard/camera/index.ts`:

```ts
export { MediaMtxPublisher, type MediaMtxPublisherOpts } from "./publisher.js";
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/camera/publisher.ts src/dashboard/camera/index.ts test/camera-publisher.test.ts
git commit -m "feat(camera): MediaMtxPublisher -- arm-driven ingest independent of viewers"
```

---

### Task 6: Startup encoder validation

A misconfigured encoder must fail loudly at startup, not as five restarts and a misleading "video unavailable".

**Files:**
- Create: `src/dashboard/camera/encoder-check.ts`
- Modify: `src/dashboard/camera/index.ts`
- Test: `test/camera-encoder-check.test.ts`

**Interfaces:**
- Consumes: `encoderName` (Task 3), `Config` (Task 2).
- Produces: `function parseEncoderList(stdout: string): Set<string>`, `function assertEncoderAvailable(cfg: Config, available: Set<string>): void` (throws `Error` with a remediation message), `function probeEncoders(ffmpegBin: string): Promise<Set<string>>`.

- [ ] **Step 1: Write the failing test**

Create `test/camera-encoder-check.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEncoderList, assertEncoderAvailable } from "../src/dashboard/camera/encoder-check.js";
import { loadConfig } from "../src/config.js";

// Real shape of `ffmpeg -encoders` output, including the header it must skip.
const SAMPLE = `Encoders:
 V..... = Video
 ------
 V..... h264_v4l2m2m         V4L2 mem2mem H.264 encoder wrapper (codec h264)
 V....D h264_vulkan          H.264/AVC (Vulkan) (codec h264)
 A..... aac                  AAC (Advanced Audio Coding)
`;

describe("parseEncoderList", () => {
  it("extracts encoder names and skips the header", () => {
    const s = parseEncoderList(SAMPLE);
    expect(s.has("h264_vulkan")).toBe(true);
    expect(s.has("h264_v4l2m2m")).toBe(true);
    expect(s.has("aac")).toBe(true);
    expect(s.has("Encoders:")).toBe(false);
    expect(s.has("=")).toBe(false);
  });

  it("returns an empty set for empty output", () => {
    expect(parseEncoderList("").size).toBe(0);
  });
});

describe("assertEncoderAvailable", () => {
  const cfg = (enc: string) => loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", TB3_CAMERA_ENCODER: enc });

  it("passes when the encoder is present", () => {
    expect(() => assertEncoderAvailable(cfg("vulkan"), parseEncoderList(SAMPLE))).not.toThrow();
  });

  it("throws a remediation message naming the missing encoder", () => {
    expect(() => assertEncoderAvailable(cfg("nvenc"), parseEncoderList(SAMPLE)))
      .toThrow(/h264_nvenc/);
  });

  it("lists what IS available so the operator can pick", () => {
    expect(() => assertEncoderAvailable(cfg("x264"), parseEncoderList(SAMPLE)))
      .toThrow(/h264_vulkan/);
  });

  it("never throws for copy -- no encoder is required", () => {
    expect(() => assertEncoderAvailable(cfg("copy"), new Set())).not.toThrow();
  });

  it("skips the check entirely when the source is not mediamtx", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_ENCODER: "nvenc" });
    expect(() => assertEncoderAvailable(c, new Set())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/camera-encoder-check.test.ts`
Expected: FAIL — cannot resolve `encoder-check.js`.

- [ ] **Step 3: Implement `src/dashboard/camera/encoder-check.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../../config.js";
import { encoderName } from "./rtsp.js";

const execFileAsync = promisify(execFile);

// `ffmpeg -encoders` prints a header, a legend, a "------" rule, then one
// encoder per line as: " V....D name  description".
export function parseEncoderList(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = /^\s[A-Z.]{6}\s+(\S+)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

export async function probeEncoders(ffmpegBin: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(ffmpegBin, ["-hide_banner", "-encoders"], {
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  return parseEncoderList(stdout);
}

// Fail fast and legibly. Without this, a missing encoder surfaces as ffmpeg
// dying, five restarts, and a "video unavailable" tile -- which reads as a
// camera fault rather than a config error.
export function assertEncoderAvailable(cfg: Config, available: Set<string>): void {
  if (cfg.cameraSource !== "mediamtx") return;
  const needed = encoderName(cfg);
  if (needed === null) return; // "copy" requires no encoder
  if (available.has(needed)) return;

  const have = [...available].filter((e) => e.includes("264")).sort();
  throw new Error(
    `cameraEncoder="${cfg.cameraEncoder}" needs ffmpeg encoder "${needed}", ` +
    `which ${cfg.cameraFfmpegBin} does not provide. ` +
    `Available H.264 encoders: ${have.length ? have.join(", ") : "(none)"}. ` +
    `Set cameraEncoder to one of those, or install an ffmpeg build that has "${needed}".`,
  );
}
```

Add to `src/dashboard/camera/index.ts`:

```ts
export { parseEncoderList, probeEncoders, assertEncoderAvailable } from "./encoder-check.js";
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/camera/encoder-check.ts src/dashboard/camera/index.ts test/camera-encoder-check.test.ts
git commit -m "feat(camera): validate the configured encoder at startup"
```

---

### Task 7: Dashboard wiring — source selection, WHEP proxy, reader poll

**Files:**
- Modify: `src/dashboard/server.ts` (imports ~line 6, `registerRoutes` ~line 264, `main()` ~line 284, status collection ~line 98)
- Test: `test/dashboard-whep.test.ts`

**Interfaces:**
- Consumes: `MediaMtxPublisher` (Task 5), `ffmpegRtspSpawner` (Task 3), `MediaMtxClient` (Task 4), `probeEncoders`/`assertEncoderAvailable` (Task 6).
- Produces: `function whepTargetUrl(cfg: Config): string`; route `POST /camera/whep`; a `CameraLike` union so the rest of the server treats both pipelines identically.

- [ ] **Step 1: Write the failing test**

Create `test/dashboard-whep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { whepTargetUrl } from "../src/dashboard/server.js";
import { loadConfig } from "../src/config.js";

describe("whepTargetUrl", () => {
  it("builds the MediaMTX WHEP endpoint from host url + path", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:8889/tb3/whep");
  });

  it("honors a custom path and host", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx",
      TB3_CAMERA_MEDIAMTX_HTTP_URL: "http://127.0.0.1:9999",
      TB3_CAMERA_MEDIAMTX_PATH: "cam2",
    });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:9999/cam2/whep");
  });

  it("tolerates a trailing slash on the host url", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx",
      TB3_CAMERA_MEDIAMTX_HTTP_URL: "http://127.0.0.1:8889/",
    });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:8889/tb3/whep");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/dashboard-whep.test.ts`
Expected: FAIL — `whepTargetUrl` is not exported.

- [ ] **Step 3: Add `whepTargetUrl` and the WHEP proxy route**

In `src/dashboard/server.ts`, update the camera import:

```ts
import {
  CameraStreamer, MediaMtxPublisher, ffmpegV4l2Spawner, mtplvcapSpawner,
  ffmpegRtspSpawner, probeEncoders, assertEncoderAvailable,
} from "./camera/index.js";
import { MediaMtxClient } from "../mediamtx/client.js";
```

Add near the other helpers:

```ts
export function whepTargetUrl(cfg: Config): string {
  return `${cfg.cameraMediamtxHttpUrl.replace(/\/+$/, "")}/${cfg.cameraMediamtxPath}/whep`;
}
```

In `registerRoutes`, alongside the existing `/camera/stream` route (line 264), add:

```ts
  // WHEP signaling proxy. The browser POSTs an SDP offer here and gets the
  // answer back; this keeps video behind the SAME token gate as everything
  // else on /camera and lets MediaMTX's HTTP port stay on loopback.
  //
  // Only signaling is proxied -- WebRTC media flows browser <-> MediaMTX
  // directly over UDP, so the host's ICE port must be reachable on the LAN.
  app.post("/camera/whep", async (req: Request, res: Response) => {
    if (cfg.cameraSource !== "mediamtx") {
      res.status(404).type("text/plain").send("WebRTC is not the active camera source");
      return;
    }
    try {
      const offer = await readRawBody(req);
      const upstream = await fetch(whepTargetUrl(cfg), {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer,
        signal: AbortSignal.timeout(5000),
      });
      const answer = await upstream.text();
      if (!upstream.ok) {
        res.status(502).type("text/plain").send(`mediamtx WHEP HTTP ${upstream.status}`);
        return;
      }
      // Location carries the resource URL used for ICE trickle / teardown.
      const loc = upstream.headers.get("location");
      if (loc) res.setHeader("Location", loc);
      res.status(201).type("application/sdp").send(answer);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[tb3-dashboard] WHEP proxy failed: ${msg}`);
      res.status(502).type("text/plain").send("WHEP proxy failed");
    }
  });
```

Add the body reader helper (Express has no raw SDP parser configured):

```ts
function readRawBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
```

- [ ] **Step 4: Wire the publisher into `main()`**

Replace the spawner-selection block (~line 284):

```ts
  // Capture backend is chosen once, at startup: a camera swap is a config
  // change + restart, not a code edit.
  const camera: CameraLike = cfg.cameraSource === "mediamtx"
    ? new MediaMtxPublisher(() => ffmpegRtspSpawner(cfg),
        { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled })
    : new CameraStreamer(
        cfg.cameraSource === "v4l2" ? () => ffmpegV4l2Spawner(cfg) : () => mtplvcapSpawner(cfg),
        { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled });

  // Fail fast on a bad encoder rather than after five silent restarts.
  // Placed BEFORE the publisher can be armed by cameraStartEnabled -- a clear
  // startup error beats a camera that looks armed and never produces video.
  if (cfg.cameraSource === "mediamtx") {
    assertEncoderAvailable(cfg, await probeEncoders(cfg.cameraFfmpegBin));
  }
```

Then, **before** the existing `const sources` line, build the MediaMTX client and
the reader poll, and thread the client through `Sources` so `buildControlDeps`
constructs the right `cameraStop` in one shot. Do **not** reassign a field on
`deps` after the fact — the project's coding standard is to construct correctly
rather than mutate.

```ts
  // Only the MediaMTX path has a control surface; null on the MJPEG paths.
  const mtx = camera instanceof MediaMtxPublisher
    ? new MediaMtxClient({
        controlUrl: cfg.cameraMediamtxControlUrl, path: cfg.cameraMediamtxPath, timeoutMs: 2000,
      })
    : null;

  // Feed the publisher MediaMTX's reader count so status().viewers stays
  // meaningful now that the dashboard no longer holds the viewer sockets.
  if (camera instanceof MediaMtxPublisher && mtx) {
    const poll = setInterval(() => {
      void mtx.pathInfo().then((info) => camera.setReaderCount(info?.readers ?? 0));
    }, 2000);
    poll.unref();
  }
```

Add `mtx: MediaMtxClient | null` to the `Sources` interface and include it in the
existing `const sources` literal. Then change `buildControlDeps`'s `cameraStop`
(line ~121) from `() => s.camera.disable()` to:

```ts
    cameraStop: () => {
      // Close the recording valve BEFORE killing the publisher so MediaMTX
      // finalizes the segment instead of having its source vanish mid-write.
      // The daemon normally owns this valve, but Stop is a dashboard action and
      // ordering matters more here than ownership purity. Fire-and-forget: a
      // dead MediaMTX must never block the Stop button, which is also the
      // operator's way to release a misbehaving camera.
      if (s.mtx) {
        void s.mtx.setRecord(false).catch((e: unknown) => {
          console.error(`[tb3-dashboard] could not close the record valve on Stop: ${
            e instanceof Error ? e.message : String(e)}`);
        });
      }
      s.camera.disable();
    },
```

**Why this exists:** the spec requires "Stop during an active recording → valve closed first, then ffmpeg killed, so the segment finalizes rather than truncating." Without it, Stop yanks the publisher out from under an open recorder.

Change the `Sources.camera` type and the `registerRoutes` parameter from `CameraStreamer` to a union:

```ts
export type CameraLike = CameraStreamer | MediaMtxPublisher;
```

Use `CameraLike` in the `Sources` interface (line 22) and in `registerRoutes`'s signature (line 185). `enable()`, `disable()`, `stop()` and `status()` exist on both. Guard the one method that does not:

```ts
  app.get("/camera/stream", (_req: Request, res: Response) => {
    if (!(camera instanceof CameraStreamer)) {
      res.status(404).type("text/plain").send("MJPEG stream is not the active camera source");
      return;
    }
    camera.attach(res);
  });
```

Update the startup log line (~line 310) to include the encoder when relevant:

```ts
      ` -> daemon :${cfg.mcpPort}, rig ${cfg.deviceHost}, camera ${cfg.cameraSource}` +
      (cfg.cameraSource === "mediamtx" ? ` (${cfg.cameraEncoder})` : ""));
```

- [ ] **Step 5: Tests pass**

Run: `npm test`
Expected: PASS. Existing dashboard tests still green — `CameraStreamer` behavior is unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/server.ts test/dashboard-whep.test.ts
git commit -m "feat(dashboard): select the MediaMTX publisher, proxy WHEP signaling"
```

---

### Task 8: Frontend — `<video>` + WHEP client, and deploy assets

**Files:**
- Create: `dashboard/public/whep.js`, `deploy/mediamtx.yml`, `deploy/mediamtx.service`
- Modify: `dashboard/public/index.html:35`, `dashboard/public/app.js` (el map ~line 33, `renderCamera` ~line 310), `deploy/HOST-SETUP.md`
- Test: `test/whep.test.ts`

**Interfaces:**
- Consumes: `POST /camera/whep` (Task 7).
- Produces: `dashboard/public/whep.js` exporting `function whepUrl(base: string): string` and `class WhepSession` with `connect(video)`, `close()`, `state()`.

- [ ] **Step 1: Write the failing test**

Create `test/whep.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { whepUrl, sdpLooksValid } from "../dashboard/public/whep.js";

describe("whepUrl", () => {
  it("appends the whep path to a bare base", () => {
    expect(whepUrl("")).toBe("/camera/whep");
  });
  it("preserves an auth token query so the gate still applies", () => {
    expect(whepUrl("?token=abc")).toBe("/camera/whep?token=abc");
  });
});

describe("sdpLooksValid", () => {
  it("accepts an SDP answer", () => {
    expect(sdpLooksValid("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n")).toBe(true);
  });
  it("rejects empty or non-SDP bodies", () => {
    expect(sdpLooksValid("")).toBe(false);
    expect(sdpLooksValid("WHEP proxy failed")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/whep.test.ts`
Expected: FAIL — cannot resolve `whep.js`.

- [ ] **Step 3: Implement `dashboard/public/whep.js`**

```js
// WHEP (WebRTC-HTTP Egress Protocol) client over the native RTCPeerConnection.
// Deliberately dependency-free: the dashboard is vanilla JS with no build step.
//
// The pure helpers are exported separately so vitest can cover them without a
// browser; WhepSession itself needs real WebRTC and is verified on-host.

export function whepUrl(query) {
  return "/camera/whep" + (query || "");
}

export function sdpLooksValid(body) {
  return typeof body === "string" && body.startsWith("v=0");
}

export class WhepSession {
  constructor(query) {
    this.query = query || "";
    this.pc = null;
    this.resource = null;
    this._state = "idle";
  }

  state() { return this._state; }

  async connect(videoEl) {
    this.close();
    this._state = "connecting";

    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only: host candidates suffice
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => { videoEl.srcObject = ev.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      if (pc.connectionState === "connected") this._state = "connected";
      // A failed peer connection is an indefinitely BLACK video element with
      // no error -- unlike a broken <img>, which at least looked broken. This
      // must surface, so record it and let app.js render + retry.
      else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this._state = "failed";
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(whepUrl(this.query), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    const answer = await res.text();
    if (!res.ok || !sdpLooksValid(answer)) {
      this._state = "failed";
      this.close();
      throw new Error("WHEP negotiation failed: HTTP " + res.status);
    }
    this.resource = res.headers.get("Location");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  close() {
    if (this.pc) { try { this.pc.close(); } catch { /* already closed */ } }
    this.pc = null;
    this.resource = null;
    this._state = "idle";
  }
}
```

- [ ] **Step 4: Swap the element and attach path**

`dashboard/public/index.html:35` — replace the `<img>`:

```html
        <video id="camera" autoplay muted playsinline></video>
```

(`muted` is required — browsers block `autoplay` without it. There is no audio track regardless.)

In `dashboard/public/app.js`, import at the top:

```js
import { WhepSession } from "./whep.js";
```

Add near the other module state (~line 123):

```js
let whep = null;
let whepRetryTimer = null;
```

Extend `renderCamera` (~line 310) so the WebRTC path attaches when armed and surfaces failure:

```js
// On the MediaMTX path the <video> is attached on demand rather than held open
// like the old <img>: a peer connection to a disarmed camera would just sit
// black. Retry is bounded and visible -- a silent black rectangle is the one
// regression WebRTC could introduce over the MJPEG <img>.
function syncWhep(enabled) {
  if (!window.RTCPeerConnection) return;
  if (enabled && (!whep || whep.state() === "failed" || whep.state() === "idle")) {
    if (whepRetryTimer) return;
    whep = whep || new WhepSession(authQuery());
    whep.connect(el.camera).catch(() => {
      el.cameraFrame?.classList.add("camera-error");
      whepRetryTimer = setTimeout(() => { whepRetryTimer = null; }, 3000);
    });
    el.cameraFrame?.classList.remove("camera-error");
  } else if (!enabled && whep) {
    whep.close();
    el.camera.srcObject = null;
  }
}
```

Call `syncWhep(c.enabled)` at the end of `renderCamera` when `CAMERA_SOURCE === "mediamtx"`. Expose the source to the frontend by adding it to the SSE state payload in `src/dashboard/server.ts`'s status collection (line 98): `camera: { ...s.camera.status(), source: cfg.cameraSource }`.

Add a `.camera-error` rule to `dashboard/public/style.css` mirroring the existing `.camera-off` treatment, with a visible message.

- [ ] **Step 5: Write the deploy assets**

`deploy/mediamtx.yml`:

```yaml
# TB3 MediaMTX. HTTP surfaces stay on loopback -- the dashboard reverse-proxies
# WHEP signaling so the existing token gate covers video. Only the ICE UDP port
# is reachable on the LAN, because WebRTC media flows browser <-> MediaMTX
# directly and cannot be proxied without putting every byte back through Node.
logLevel: info

api: yes
apiAddress: 127.0.0.1:9997

rtsp: yes
rtspAddress: 127.0.0.1:8554

webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: :8189

hls: no
rtmp: no
srt: no

pathDefaults:
  # Recording is OFF here on purpose. The MCP daemon opens and closes this
  # valve from tracking state via the control API; a static "yes" would record
  # continuously and defeat the point.
  record: no
  recordPath: /var/lib/tb3/recordings/%path/%Y-%m-%d_%H-%M-%S-%f
  recordFormat: fmp4
  recordSegmentDuration: 1h
  recordDeleteAfter: 168h

paths:
  tb3:
    source: publisher
```

`deploy/mediamtx.service`:

```ini
[Unit]
Description=MediaMTX for TB3 video
After=network.target

[Service]
Type=simple
User=atomist
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
# A suspend/resume on this host can leave the process wedged; always come back.
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Append a section to `deploy/HOST-SETUP.md` covering: installing MediaMTX, `mkdir -p /var/lib/tb3/{recordings,snapshots}` owned by `atomist`, opening 8189/udp on the LAN, and — repeating the two traps verbatim — setting `cameraSource` in **`config.json`** (never `Environment=`), and using the **by-id** device alias. Add the third trap: `cameraFfmpegBin`/`captureFfmpegBin` must be the **absolute asdf path**, because the shims are not on the systemd `PATH` and an asdf version bump silently moves it.

- [ ] **Step 6: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/public/whep.js dashboard/public/index.html dashboard/public/app.js dashboard/public/style.css deploy/ test/whep.test.ts src/dashboard/server.ts
git commit -m "feat(dashboard): WebRTC video element + WHEP client, MediaMTX deploy assets"
```

**🚩 PHASE 1 COMPLETE — verify on the rig before Phase 2.**

Run verification items 1–5 and 9–10 from the spec's checklist. Host config to set in `config.json`:

```json
  "cameraSource": "mediamtx",
  "cameraEncoder": "nvenc",
  "cameraFfmpegBin": "/usr/lib/jellyfin-ffmpeg/ffmpeg",
  "captureFfmpegBin": "/usr/lib/jellyfin-ffmpeg/ffmpeg"
```

The old `h264_vulkan`-playability risk is largely retired by the NVENC install. **The highest remaining unknown is the MediaMTX control-API route** (`/v3/config/paths/patch/{name}`), which is version-dependent — but that only bites in Phase 2, so Phase 1 can be verified independently of it.

---

### Task 8b: Migrate `CameraStreamer` onto `SpawnSupervisor`

Retires the duplication Task 1 deliberately left. **Run only after Phase 1 is verified on the rig** — this refactors the fallback path, so it should happen while a known-good WebRTC path exists.

**Files:**
- Modify: `src/dashboard/camera/mjpeg-streamer.ts`
- Test: `test/dashboard-camera.test.ts` (must pass **unchanged** — it is the guard)

**Interfaces:**
- Consumes: `SpawnSupervisor` (Task 1).
- Produces: no API change. `CameraStreamer`'s public surface (`enable`, `disable`, `attach`, `stop`, `status`, `viewerCount`) is identical.

- [ ] **Step 1: Confirm the guard is green before touching anything**

Run: `npx vitest run test/dashboard-camera.test.ts`
Expected: PASS. These tests are the whole safety net for this task — if they are not green first, stop.

- [ ] **Step 2: Replace CameraStreamer's private lifecycle with the supervisor**

Delete these members from `CameraStreamer`: `spawnerHandle`, `restartTimer`, `restartCount`, `restartWindowStart`, `generation`, `frameSeen`, and the methods `startPipeline`, `stopPipeline`, `killSpawner`, `clearRestartTimer`, `handleExit`. Also delete the now-unused `MAX_RESTARTS` and `RESTART_WINDOW_MS` constants.

Add a supervisor whose predicate expresses the MJPEG path's rule — armed **and** someone watching:

```ts
  private readonly sup: SpawnSupervisor;

  constructor(
    makeSpawner: () => Spawner,
    private readonly opts: CameraStreamerOpts,
  ) {
    this.enabled = opts.enabled ?? false;
    this.sup = new SpawnSupervisor(makeSpawner, {
      fallbackMs: opts.fallbackMs,
      // The ONE behavioral difference from MediaMtxPublisher: a camera nobody
      // is watching must not hold the device open.
      shouldRun: () => this.enabled && this.writers.size > 0,
      onFrame: (jpeg) => this.pushFrame(jpeg),
      onDegraded: () => { this.latestFrame = null; this.broadcastPlaceholder(); },
    });
  }
```

Rewrite the public methods to reconcile through the supervisor:

```ts
  status(): CameraStatus {
    return { enabled: this.enabled, streaming: this.sup.running() && this.sup.frameSeen(), viewers: this.writers.size };
  }

  enable(): void {
    if (this.stopped) return;
    this.enabled = true;
    this.sup.sync();
  }

  disable(): void {
    if (this.stopped) return;
    this.enabled = false;
    this.sup.teardown();
    this.latestFrame = null;
    this.broadcastPlaceholder();
  }

  stop(): void {
    this.stopped = true;
    this.sup.stop();
    for (const res of this.writers) {
      try { res.end(); } catch { /* already gone */ }
    }
    this.writers.clear();
  }
```

In `attach()`, replace the trailing `if (this.writers.size === 1) this.startPipeline();` with `this.sup.sync();`, and in the `detach` closure replace `if (this.writers.size === 0) this.stopPipeline();` with `this.sup.sync();`.

- [ ] **Step 3: The guard must still pass, unchanged**

Run: `npx vitest run test/dashboard-camera.test.ts`
Expected: PASS, with **no edits to the test file**. If a test needs changing to pass, the refactor changed behavior — revert and reconsider rather than editing the test.

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/camera/mjpeg-streamer.ts
git commit -m "refactor(camera): migrate CameraStreamer onto SpawnSupervisor"
```

---

# PHASE 2 — MCP-driven capture

### Task 9: Snapshot grabber

**Files:**
- Create: `src/capture/snapshot.ts`
- Test: `test/capture-snapshot.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces: `function snapshotArgs(cfg: Config, outPath: string): string[]`, `function snapshotPath(dir: string, icao: string, iso: string): string`, `function takeSnapshot(cfg: Config, icao: string, nowIso: string): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `test/capture-snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { snapshotArgs, snapshotPath } from "../src/capture/snapshot.js";
import { loadConfig } from "../src/config.js";

const cfg = (over: Record<string, string> = {}) =>
  loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", ...over });

describe("snapshotPath", () => {
  it("names files <icao>-<iso>.jpg with colons stripped", () => {
    expect(snapshotPath("/var/lib/tb3/snapshots", "ABC123", "2026-07-26T18:04:05.000Z"))
      .toBe("/var/lib/tb3/snapshots/ABC123-2026-07-26T18-04-05.000Z.jpg");
  });

  it("lowercases and strips unsafe characters from the icao", () => {
    expect(snapshotPath("/s", "../etc/passwd", "2026-07-26T00:00:00.000Z"))
      .toBe("/s/etcpasswd-2026-07-26T00-00-00.000Z.jpg");
  });
});

describe("snapshotArgs", () => {
  it("pulls ONE frame from the RTSP stream, not the v4l2 device", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a).toContain("rtsp://127.0.0.1:8554/tb3");
    // A second /dev/video consumer would contend with the publisher for the
    // camera, which is exactly what has wedged this hardware before.
    expect(a.join(" ")).not.toContain("/dev/video");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("uses TCP transport and overwrites the target", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a).toContain("-rtsp_transport");
    expect(a).toContain("tcp");
    expect(a).toContain("-y");
    expect(a[a.length - 1]).toBe("/tmp/x.jpg");
  });

  it("puts -rtsp_transport BEFORE -i or ffmpeg ignores it", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a.indexOf("-rtsp_transport")).toBeLessThan(a.indexOf("-i"));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/capture-snapshot.test.ts`
Expected: FAIL — cannot resolve `snapshot.js`.

- [ ] **Step 3: Implement `src/capture/snapshot.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

// Colons are illegal in filenames on some targets and awkward everywhere;
// the icao is sanitized because it ultimately derives from an external feed.
export function snapshotPath(dir: string, icao: string, iso: string): string {
  const safeIcao = icao.replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  return path.join(dir, `${safeIcao}-${iso.replace(/:/g, "-")}.jpg`);
}

// Grab a single frame from MediaMTX's RTSP output -- NOT from the V4L2 device.
// A second device consumer would contend with the publisher for the camera.
export function snapshotArgs(cfg: Config, outPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",     // must precede -i
    "-i", cfg.cameraMediamtxRtspUrl,
    "-frames:v", "1",
    "-q:v", "2",
    "-y",
    outPath,
  ];
}

// NOT unit-tested end-to-end (real subprocess). Bounded by captureTimeoutMs so
// a wedged ffmpeg can never delay the tracking tick that triggered it.
export async function takeSnapshot(cfg: Config, icao: string, nowIso: string): Promise<string> {
  const out = snapshotPath(cfg.captureSnapshotDir, icao, nowIso);
  await execFileAsync(cfg.captureFfmpegBin, snapshotArgs(cfg, out), {
    timeout: cfg.captureTimeoutMs,
    killSignal: "SIGKILL",
  });
  return out;
}
```

Add the daemon-side config fields to `src/config.ts` (schema + env overrides), and matching assertions to `test/config.test.ts`:

```ts
    // --- MCP-driven capture (daemon side) ---
    captureAutoEnabled: z.boolean().default(true),
    captureSnapshotDir: z.string().min(1).default("/var/lib/tb3/snapshots"),
    // Grace before the recorder closes: TrackState flaps to "waiting" when a
    // target is briefly blocked, and without this one pass becomes fragments.
    captureDebounceMs: z.number().int().positive().default(5000),
    // Hard bound on EVERY capture call. The tracking tick is real-time control
    // of a physical rig and must never wait on capture.
    captureTimeoutMs: z.number().int().positive().default(4000),
    captureFfmpegBin: z.string().min(1).default("ffmpeg"),
```

```ts
  set("captureAutoEnabled", bool(env.TB3_CAPTURE_AUTO_ENABLED));
  set("captureSnapshotDir", env.TB3_CAPTURE_SNAPSHOT_DIR);
  set("captureDebounceMs", num(env.TB3_CAPTURE_DEBOUNCE_MS));
  set("captureTimeoutMs", num(env.TB3_CAPTURE_TIMEOUT_MS));
  set("captureFfmpegBin", env.TB3_CAPTURE_FFMPEG_BIN);
```

- [ ] **Step 4: Tests pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/snapshot.ts src/config.ts test/capture-snapshot.test.ts test/config.test.ts
git commit -m "feat(capture): one-shot RTSP snapshot grabber + capture config"
```

---

### Task 10: Capture controller — the policy

The most test-worthy unit in the plan. All timing is injected so tests are deterministic.

**Files:**
- Create: `src/capture/controller.ts`
- Test: `test/capture-controller.test.ts`

**Interfaces:**
- Consumes: `MediaMtxClient` (Task 4), `TrackState` from `src/track/session.ts`.
- Produces:
  - `interface CaptureDeps { setRecord(on: boolean): Promise<void>; snapshot(icao: string): Promise<string>; isArmed(): Promise<boolean>; now(): number; nowIso(): string }`
  - `interface CaptureStatus { autoEnabled: boolean; recording: boolean; passIcao: string | null; lastSnapshot: string | null; lastError: string | null; lastSkipReason: string | null }`
  - `class CaptureController` — `constructor(deps: CaptureDeps, opts: { debounceMs: number; autoEnabled: boolean })`, methods `onTrack(state: TrackState, icao: string | null): void`, `status(): CaptureStatus`, `setAuto(on: boolean): void`, `manualSnapshot(icao?: string): Promise<string>`, `setRecording(on: boolean): Promise<void>`, `dispose(): void`

- [ ] **Step 1: Write the failing test**

Create `test/capture-controller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";

function deps(over: Partial<CaptureDeps> = {}) {
  const calls = { record: [] as boolean[], snaps: [] as string[] };
  const d: CaptureDeps = {
    setRecord: async (on) => { calls.record.push(on); },
    snapshot: async (icao) => { calls.snaps.push(icao); return `/s/${icao}.jpg`; },
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    ...over,
  };
  return { d, calls };
}
const mk = (d: CaptureDeps, debounceMs = 5000) =>
  new CaptureController(d, { debounceMs, autoEnabled: true });

// onTrack() is deliberately fire-and-forget, so its work lands in the microtask
// queue rather than being awaitable. advanceTimersByTimeAsync(0) drains
// microtasks under fake timers; a bare vi.runAllTicks() does NOT and would
// make these assertions race.
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe("CaptureController", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("snapshots once and opens the recorder on entering tracking", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);
    expect(calls.record).toEqual([true]);
  });

  it("does NOT fire on acquiring -- the rig has not settled yet", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("acquiring", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("a brief flap to waiting does not re-snap or split the clip", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("waiting", "ABC123");
    vi.advanceTimersByTime(1000);
    c.onTrack("tracking", "ABC123");
    await flush();
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);   // ONE image
    expect(calls.record).toEqual([true]);      // ONE unbroken clip
  });

  it("closes the recorder once the debounce actually expires", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("waiting", "ABC123");
    vi.advanceTimersByTime(5001);
    await flush();
    expect(calls.record).toEqual([true, false]);
  });

  it("a different aircraft gets its own snapshot", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("tracking", "DEF456");
    await flush();
    expect(calls.snaps).toEqual(["ABC123", "DEF456"]);
  });

  it("re-acquiring the SAME aircraft after the valve closed is a new pass", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("stopped", null);
    vi.advanceTimersByTime(5001);
    await flush();
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123", "ABC123"]);
    expect(calls.record).toEqual([true, false, true]);
  });

  it("skips with a reason when the camera is disarmed, and never auto-arms", async () => {
    const { d, calls } = deps({ isArmed: async () => false });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
    expect(c.status().lastSkipReason).toMatch(/disarm/i);
  });

  it("does nothing at all when auto capture is off", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.setAuto(false);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("surfaces a control-API failure instead of swallowing it", async () => {
    const { d } = deps({ setRecord: async () => { throw new Error("ECONNREFUSED"); } });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(c.status().lastError).toContain("ECONNREFUSED");
  });

  it("onTrack RETURNS SYNCHRONOUSLY even when capture hangs forever", () => {
    const { d } = deps({
      snapshot: () => new Promise<string>(() => { /* never resolves */ }),
      setRecord: () => new Promise<void>(() => { /* never resolves */ }),
    });
    const c = mk(d);
    const t0 = performance.now();
    c.onTrack("tracking", "ABC123");   // must not await anything
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/capture-controller.test.ts`
Expected: FAIL — cannot resolve `controller.js`.

- [ ] **Step 3: Implement `src/capture/controller.ts`**

```ts
import type { TrackState } from "../track/session.js";

export interface CaptureDeps {
  setRecord(on: boolean): Promise<void>;
  snapshot(icao: string): Promise<string>;
  isArmed(): Promise<boolean>;
  now(): number;
  nowIso(): string;
}

export interface CaptureStatus {
  autoEnabled: boolean;
  recording: boolean;
  passIcao: string | null;
  lastSnapshot: string | null;
  lastError: string | null;
  lastSkipReason: string | null;
}

export interface CaptureControllerOpts {
  debounceMs: number;
  autoEnabled: boolean;
}

// Turns TrackState transitions into capture actions.
//
// SAFETY RULE: onTrack() is called from the tracking tick, which is real-time
// control of a physical rig. It NEVER awaits. Every capture call is
// fire-and-forget; failures are recorded and surfaced, never propagated.
export class CaptureController {
  private auto: boolean;
  private recording = false;
  private passIcao: string | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private lastSnapshot: string | null = null;
  private lastError: string | null = null;
  private lastSkipReason: string | null = null;

  constructor(
    private readonly deps: CaptureDeps,
    private readonly opts: CaptureControllerOpts,
  ) {
    this.auto = opts.autoEnabled;
  }

  status(): CaptureStatus {
    return {
      autoEnabled: this.auto,
      recording: this.recording,
      passIcao: this.passIcao,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      lastSkipReason: this.lastSkipReason,
    };
  }

  setAuto(on: boolean): void {
    this.auto = on;
    if (!on) this.closeNow();
  }

  onTrack(state: TrackState, icao: string | null): void {
    if (!this.auto) return;

    if (state === "tracking" && icao) {
      // Same aircraft, still the current pass: cancel a pending close so a
      // flap through "waiting" cannot fragment the clip or re-snapshot.
      if (this.passIcao === icao) { this.cancelClose(); return; }
      this.beginPass(icao);
      return;
    }

    // Left "tracking". Start the grace timer; only a timer that actually
    // expires closes the valve and clears the pass.
    if (this.passIcao !== null && this.closeTimer === null) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        this.closeNow();
      }, this.opts.debounceMs);
    }
  }

  async manualSnapshot(icao?: string): Promise<string> {
    const p = await this.deps.snapshot(icao ?? "manual");
    this.lastSnapshot = p;
    return p;
  }

  async setRecording(on: boolean): Promise<void> {
    await this.deps.setRecord(on);
    this.recording = on;
  }

  dispose(): void { this.cancelClose(); }

  private beginPass(icao: string): void {
    this.cancelClose();
    this.passIcao = icao;
    // Fire-and-forget: the tracking tick must not wait on the camera.
    void this.deps.isArmed().then((armed) => {
      if (!armed) {
        // Stop is a hard release. Never auto-arm; report and move on.
        this.lastSkipReason = `camera disarmed at lock on ${icao}; capture skipped`;
        console.warn(`[tb3-capture] ${this.lastSkipReason}`);
        this.passIcao = null;
        return;
      }
      this.lastSkipReason = null;
      void this.deps.snapshot(icao)
        .then((p) => { this.lastSnapshot = p; })
        .catch((e: unknown) => this.recordError("snapshot", e));
      void this.deps.setRecord(true)
        .then(() => { this.recording = true; })
        .catch((e: unknown) => this.recordError("record on", e));
    }).catch((e: unknown) => this.recordError("isArmed", e));
  }

  private closeNow(): void {
    this.cancelClose();
    this.passIcao = null;   // cleared, so a genuine return is a NEW pass
    if (!this.recording) return;
    void this.deps.setRecord(false)
      .then(() => { this.recording = false; })
      .catch((e: unknown) => this.recordError("record off", e));
  }

  private cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  private recordError(what: string, e: unknown): void {
    this.lastError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    // Never silently not-happen.
    console.error(`[tb3-capture] ${this.lastError}`);
  }
}
```

- [ ] **Step 4: Tests pass**

Run: `npx vitest run test/capture-controller.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/capture/controller.ts test/capture-controller.test.ts
git commit -m "feat(capture): tracking-state capture policy with ICAO keying and debounce"
```

---

### Task 11: MCP tools + daemon wiring

**Files:**
- Modify: `src/tools.ts` (register capture tools), `src/server.ts:54` (construct + pass the controller), `src/track/session.ts` (emit transitions)
- Test: `test/capture-tools.test.ts`

**Interfaces:**
- Consumes: `CaptureController` (Task 10), `MediaMtxClient` (Task 4), `takeSnapshot` (Task 9).
- Produces: MCP tools `get_capture_status`, `capture_snapshot`, `set_capture_mode`, `start_recording`, `stop_recording`. `TrackSession` gains `onStateChange(cb: (state: TrackState, icao: string | null) => void): void`.

- [ ] **Step 1: Write the failing test**

Create `test/capture-tools.test.ts`, following the existing `test/tools.test.ts` registration pattern (read it first for the harness shape):

```ts
import { describe, it, expect, vi } from "vitest";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";

function ctl(over: Partial<CaptureDeps> = {}) {
  const calls = { record: [] as boolean[], snaps: [] as string[] };
  const d: CaptureDeps = {
    setRecord: async (on) => { calls.record.push(on); },
    snapshot: async (i) => { calls.snaps.push(i); return `/s/${i}.jpg`; },
    isArmed: async () => true,
    now: () => 0,
    nowIso: () => "2026-07-26T00:00:00.000Z",
    ...over,
  };
  return { c: new CaptureController(d, { debounceMs: 5000, autoEnabled: true }), calls };
}

describe("capture tool surface", () => {
  it("get_capture_status reports the full shape", () => {
    const { c } = ctl();
    expect(c.status()).toEqual({
      autoEnabled: true, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    });
  });

  it("set_capture_mode(false) disables auto capture and closes the valve", async () => {
    const { c, calls } = ctl();
    await c.setRecording(true);
    c.setAuto(false);
    await vi.waitFor(() => expect(calls.record).toEqual([true, false]));
    expect(c.status().autoEnabled).toBe(false);
  });

  it("capture_snapshot works independently of tracking", async () => {
    const { c, calls } = ctl();
    const p = await c.manualSnapshot("XYZ789");
    expect(p).toBe("/s/XYZ789.jpg");
    expect(calls.snaps).toEqual(["XYZ789"]);
    expect(c.status().lastSnapshot).toBe("/s/XYZ789.jpg");
  });

  it("start/stop_recording override the valve manually", async () => {
    const { c, calls } = ctl();
    await c.setRecording(true);
    expect(c.status().recording).toBe(true);
    await c.setRecording(false);
    expect(calls.record).toEqual([true, false]);
  });

  it("a failing manual snapshot rejects so the tool reports the error", async () => {
    const { c } = ctl({ snapshot: async () => { throw new Error("ffmpeg timeout"); } });
    await expect(c.manualSnapshot("ABC")).rejects.toThrow(/ffmpeg timeout/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/capture-tools.test.ts`
Expected: FAIL initially only if `CaptureController` is missing; it exists from Task 10, so confirm these specific behaviors pass or fix the gaps they expose.

- [ ] **Step 3: Emit state transitions from the session**

In `src/track/session.ts`, add a listener list and fire it wherever `this.state` is assigned:

```ts
  private stateListeners: ((s: TrackState, icao: string | null) => void)[] = [];

  onStateChange(cb: (s: TrackState, icao: string | null) => void): void {
    this.stateListeners.push(cb);
  }

  // Call INSTEAD of assigning this.state directly, so every transition is
  // observable. Emits only on an actual change to avoid a per-tick storm.
  private setState(next: TrackState): void {
    if (this.state === next) return;
    this.state = next;
    const icao = this.currentIcao();   // existing accessor for the tracked target
    for (const cb of this.stateListeners) {
      try { cb(next, icao); } catch { /* a listener must never break tracking */ }
    }
  }
```

Replace every `this.state = "..."` assignment with `this.setState("...")`. Add `currentIcao(): string | null` if no equivalent exists, returning the tracked aircraft's hex or `null`.

- [ ] **Step 4: Register the tools**

In `src/tools.ts`, add to `registerTools` (which gains a `capture: CaptureController` parameter):

```ts
  server.registerTool("get_capture_status",
    { description: "Recording/snapshot state: whether auto capture is on, whether the recorder is open, the current pass ICAO, and the last snapshot or error." },
    async () => ({ content: [{ type: "text", text: JSON.stringify(capture.status(), null, 2) }] }));

  server.registerTool("set_capture_mode",
    { description: "Enable or disable automatic capture on track lock.",
      inputSchema: { enabled: z.boolean() } },
    async ({ enabled }) => {
      capture.setAuto(enabled);
      return { content: [{ type: "text", text: `auto capture ${enabled ? "enabled" : "disabled"}` }] };
    });

  server.registerTool("capture_snapshot",
    { description: "Take one snapshot now, independent of tracking state.",
      inputSchema: { icao: z.string().optional() } },
    async ({ icao }) => {
      const p = await capture.manualSnapshot(icao);
      return { content: [{ type: "text", text: `snapshot written to ${p}` }] };
    });

  server.registerTool("start_recording",
    { description: "Manually open the recording valve." },
    async () => { await capture.setRecording(true); return { content: [{ type: "text", text: "recording started" }] }; });

  server.registerTool("stop_recording",
    { description: "Manually close the recording valve." },
    async () => { await capture.setRecording(false); return { content: [{ type: "text", text: "recording stopped" }] }; });
```

- [ ] **Step 5: Construct the controller in `src/server.ts`**

Before `registerTools(...)` (line 54):

```ts
  const mtx = new MediaMtxClient({
    controlUrl: cfg.cameraMediamtxControlUrl,
    path: cfg.cameraMediamtxPath,
    timeoutMs: cfg.captureTimeoutMs,
  });
  const capture = new CaptureController({
    setRecord: (on) => mtx.setRecord(on),
    snapshot: (icao) => takeSnapshot(cfg, icao, new Date().toISOString()),
    // The daemon does not own the camera; MediaMTX reporting the path ready
    // IS the armed signal, and it needs no dashboard round-trip.
    isArmed: async () => (await mtx.pathInfo())?.ready === true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  }, { debounceMs: cfg.captureDebounceMs, autoEnabled: cfg.captureAutoEnabled });

  session.onStateChange((state, icao) => capture.onTrack(state, icao));
```

Pass `capture` into `registerTools(server, device, cfg, session, supervisor, store, capture)`.

- [ ] **Step 6: Tests + typecheck**

Run: `npm test && npm run build`
Expected: PASS. Existing `session.test.ts` and `tracking-sim.test.ts` must stay green — `setState` is a refactor of assignment, not a behavior change.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/server.ts src/track/session.ts test/capture-tools.test.ts
git commit -m "feat(capture): MCP capture tools wired to tracking state transitions"
```

---

### Task 12: Surface capture state in the dashboard

**Files:**
- Modify: `src/dashboard/client.ts` (add `getCaptureStatus`), `src/dashboard/server.ts` (add to the aggregator ~line 88), `dashboard/public/app.js` (render), `dashboard/public/index.html` (indicator), `dashboard/public/style.css`
- Test: `test/dashboard-capture-state.test.ts`

**Interfaces:**
- Consumes: `get_capture_status` MCP tool (Task 11), `CaptureStatus` (Task 10).
- Produces: `function renderCaptureLabel(s: CaptureStatus | null): { text: string; cls: string }` — extracted as a pure function so it is testable without a DOM.

- [ ] **Step 1: Write the failing test**

Create `test/dashboard-capture-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderCaptureLabel } from "../dashboard/public/capture-label.js";

describe("renderCaptureLabel", () => {
  it("shows a dash when the daemon has not reported yet", () => {
    expect(renderCaptureLabel(null)).toEqual({ text: "Capture: —", cls: "capture-unknown" });
  });

  it("shows REC with the aircraft while recording", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: true, passIcao: "ABC123",
      lastSnapshot: "/s/ABC123.jpg", lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: REC ABC123", cls: "capture-rec" });
  });

  it("shows armed-and-waiting when auto is on but nothing is tracked", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: ready", cls: "capture-ready" });
  });

  it("shows OFF when auto capture is disabled", () => {
    expect(renderCaptureLabel({
      autoEnabled: false, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: OFF", cls: "capture-off" });
  });

  it("an error outranks everything -- it must never be invisible", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: true, passIcao: "ABC123",
      lastSnapshot: null, lastError: "record on: ECONNREFUSED", lastSkipReason: null,
    })).toEqual({ text: "Capture: ERROR", cls: "capture-error" });
  });

  it("a skip reason is shown rather than looking idle", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: false, passIcao: null, lastSnapshot: null,
      lastError: null, lastSkipReason: "camera disarmed at lock on ABC123; capture skipped",
    })).toEqual({ text: "Capture: skipped (disarmed)", cls: "capture-skip" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/dashboard-capture-state.test.ts`
Expected: FAIL — cannot resolve `capture-label.js`.

- [ ] **Step 3: Implement `dashboard/public/capture-label.js`**

```js
// Pure label logic, split out so it is testable without a DOM. Ordering is
// deliberate: an error must never be masked by a healthy-looking state.
export function renderCaptureLabel(s) {
  if (!s) return { text: "Capture: —", cls: "capture-unknown" };
  if (s.lastError) return { text: "Capture: ERROR", cls: "capture-error" };
  if (s.lastSkipReason) return { text: "Capture: skipped (disarmed)", cls: "capture-skip" };
  if (!s.autoEnabled) return { text: "Capture: OFF", cls: "capture-off" };
  if (s.recording) return { text: "Capture: REC " + (s.passIcao || ""), cls: "capture-rec" };
  return { text: "Capture: ready", cls: "capture-ready" };
}
```

- [ ] **Step 4: Wire it through**

In `src/dashboard/client.ts`, add `getCaptureStatus()` calling the `get_capture_status` tool, mirroring the existing `getTrackingStatus()` shape.

In `src/dashboard/server.ts`'s aggregator (line ~88), add a bounded call alongside the others:

```ts
    tryResult(() => withTimeout(s.client.getCaptureStatus(), COLLECT_CALL_TIMEOUT_MS, "getCaptureStatus")),
```

and include `capture` in the returned state object plus the degraded fallback (line ~136) as `capture: null`.

In `dashboard/public/index.html`, add a `<span id="capture-status" class="stat">` beside the camera controls. In `app.js`, import `renderCaptureLabel` and apply it in the state render:

```js
const cap = renderCaptureLabel(state.capture);
el.captureStatus.textContent = cap.text;
el.captureStatus.className = "stat " + cap.cls;
```

Add `.capture-rec` (red), `.capture-error` (red), `.capture-skip` (amber), `.capture-ready`/`.capture-off`/`.capture-unknown` (muted) rules to `style.css`.

- [ ] **Step 5: Tests + typecheck**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/public/capture-label.js dashboard/public/app.js dashboard/public/index.html dashboard/public/style.css src/dashboard/client.ts src/dashboard/server.ts test/dashboard-capture-state.test.ts
git commit -m "feat(dashboard): surface capture state (REC / skipped / error)"
```

---

### Task 13: ffmpeg binary preflight for every ffmpeg-using source

**Added 2026-07-26 in response to a live field bug**, not planned up front.

The host sat on `Camera: STARTING…` indefinitely. Root cause: `cameraFfmpegBin` pointed at `/home/atomist/.asdf/installs/ffmpeg/8.1.2/bin/ffmpeg`, which had been removed when `jellyfin-ffmpeg8` was installed. The failure chain is silent by construction:

```
spawn(cameraFfmpegBin) → ENOENT → onExit(1) → restart budget 5×/60s
  → exhausted → placeholder frame → frameSeen stays false
  → status(): { enabled: true, streaming: false } → UI renders "STARTING…" forever
```

Task 6 built exactly the guard for this — `probeEncoders()` would have thrown loudly on a missing binary — but `assertEncoderAvailable` is gated on `cameraSource === "mediamtx"`, so the `v4l2` and `mtplvcap` paths still fail silently. Close that gap.

**Files:**
- Modify: `src/dashboard/camera/encoder-check.ts`, `src/dashboard/server.ts`
- Test: `test/camera-encoder-check.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `encoderName` (Task 3).
- Produces: `function assertFfmpegUsable(cfg: Config): Promise<void>` — throws a remediation-bearing `Error` when the configured binary is missing or not executable. Runs for **every** source that spawns ffmpeg.

- [ ] **Step 1: Write the failing test**

Add to `test/camera-encoder-check.test.ts`:

```ts
import { assertFfmpegUsable } from "../src/dashboard/camera/encoder-check.js";

describe("assertFfmpegUsable", () => {
  const cfg = (over: Record<string, string> = {}) =>
    loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2", ...over });

  it("rejects with a message naming the missing path and the config key", async () => {
    const c = cfg({ TB3_CAMERA_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg" });
    await expect(assertFfmpegUsable(c)).rejects.toThrow(/\/nope\/does\/not\/exist\/ffmpeg/);
    await expect(assertFfmpegUsable(c)).rejects.toThrow(/cameraFfmpegBin/);
  });

  it("checks the v4l2 path too, not only mediamtx -- this is the field bug", async () => {
    // The live failure was cameraSource=v4l2 with a dead asdf ffmpeg path;
    // Task 6's encoder check skipped it because it only ran for mediamtx.
    await expect(assertFfmpegUsable(cfg({ TB3_CAMERA_FFMPEG_BIN: "/nope/ffmpeg" })))
      .rejects.toThrow();
  });

  it("skips entirely for mtplvcap, which does not spawn ffmpeg", async () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mtplvcap", TB3_CAMERA_FFMPEG_BIN: "/nope/ffmpeg",
    });
    await expect(assertFfmpegUsable(c)).resolves.toBeUndefined();
  });

  it("accepts a real executable", async () => {
    await expect(assertFfmpegUsable(cfg({ TB3_CAMERA_FFMPEG_BIN: process.execPath })))
      .resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/camera-encoder-check.test.ts`
Expected: FAIL — `assertFfmpegUsable` is not exported.

- [ ] **Step 3: Implement it**

In `src/dashboard/camera/encoder-check.ts`:

```ts
import { access, constants } from "node:fs/promises";

// Sources that actually spawn ffmpeg. mtplvcap runs its own binary instead,
// so checking ffmpeg for it would fail hosts that never use ffmpeg at all.
const FFMPEG_SOURCES = new Set(["v4l2", "mediamtx"]);

// Fail at startup, loudly, when the configured ffmpeg does not exist or is not
// executable.
//
// Without this, a dead path is invisible: spawn() fails with ENOENT, the
// restart budget burns 5 attempts in 60s, the pipeline degrades to a
// placeholder frame, and the dashboard shows "STARTING..." forever because
// `enabled` is true while `streaming` never becomes true. That exact failure
// cost real debugging time on 2026-07-26, when an ffmpeg toolchain change
// removed the binary the config still pointed at.
export async function assertFfmpegUsable(cfg: Config): Promise<void> {
  if (!FFMPEG_SOURCES.has(cfg.cameraSource)) return;
  try {
    await access(cfg.cameraFfmpegBin, constants.X_OK);
  } catch {
    throw new Error(
      `cameraFfmpegBin="${cfg.cameraFfmpegBin}" is missing or not executable, ` +
      `but cameraSource="${cfg.cameraSource}" needs ffmpeg. ` +
      `Set cameraFfmpegBin to an absolute path to a working ffmpeg. ` +
      `Note a toolchain change (e.g. installing a different ffmpeg package) ` +
      `can remove the old binary while leaving this config pointing at it.`,
    );
  }
}
```

Export it from `src/dashboard/camera/index.ts`.

- [ ] **Step 4: Call it at startup**

In `src/dashboard/server.ts`'s `main()`, call it **before** the existing mediamtx-only encoder check, so a missing binary is reported ahead of a missing encoder (you cannot probe encoders from a binary that isn't there):

```ts
  await assertFfmpegUsable(cfg);
  if (cfg.cameraSource === "mediamtx") {
    assertEncoderAvailable(cfg, await probeEncoders(cfg.cameraFfmpegBin));
  }
```

- [ ] **Step 5: Tests + typecheck**

Run: `npm test` then `npx tsc -p tsconfig.json --noEmit`
Expected: PASS; exactly 6 `TS7016` errors, nothing of another shape.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/camera/encoder-check.ts src/dashboard/camera/index.ts src/dashboard/server.ts test/camera-encoder-check.test.ts
git commit -m "feat(camera): preflight the ffmpeg binary for every source that spawns it"
```

---

## Final verification

- [ ] `npm test` — full suite green.
- [ ] `npm run build` — no TypeScript errors.
- [ ] Default config unchanged: `loadConfig(undefined, {}).cameraSource === "mtplvcap"` — the feature ships inert.
- [ ] Work the spec's 10-item on-rig checklist, starting with item 1 (`h264_vulkan` playing over WebRTC), which is the highest-risk unknown.
