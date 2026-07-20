import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Config } from "../config.js";

// Abstracts the gphoto2->ffmpeg subprocess pipeline so CameraStreamer's
// viewer-refcount/restart lifecycle is unit-testable with a fake, and the
// real subprocess wiring (realSpawner, below) stays untested-but-isolated.
export interface Spawner {
  start(onFrame: (jpeg: Buffer) => void, onExit: (code: number | null) => void): { kill(): void };
}

export interface CameraStreamerOpts {
  // Reused for two roles: (1) the delay CameraStreamer waits before
  // restarting a dead pipeline (this file), and (2) the interval realSpawner
  // polls at once it has dropped to the single-shot preview fallback. One
  // knob (cfg.cameraFallbackMs) instead of two avoids a second magic number
  // for what is, in both cases, "how eagerly do we retry a degraded camera".
  fallbackMs: number;
}

const BOUNDARY = "frame";
const MAX_RESTARTS = 5;
// If the pipeline has stayed up this long since the first restart in a burst,
// forgive the burst and give it a fresh restart budget -- a camera that dies
// once an hour shouldn't be penalized by a flap that happened this morning.
const RESTART_WINDOW_MS = 60_000;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// The smallest possible valid JPEG (1x1 black pixel) -- shown to a viewer
// before the first real frame has arrived, and again if the pipeline gives up
// after MAX_RESTARTS, so "camera not sending frames" always looks like an
// image (a frozen/blank tile) rather than a broken <img> icon.
const PLACEHOLDER_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";
const PLACEHOLDER_JPEG = Buffer.from(PLACEHOLDER_JPEG_BASE64, "base64");

function frameChunk(jpeg: Buffer): Buffer {
  const header = Buffer.from(
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    "utf8",
  );
  return Buffer.concat([header, jpeg, Buffer.from("\r\n", "utf8")]);
}

// Holds a Set of attached multipart/x-mixed-replace response writers plus the
// latest JPEG. Starts the (shared, single) spawner on the first attach, tears
// it down at zero viewers, and fans every pushed frame out to every attached
// writer. A dead pipeline with viewers still watching gets a bounded,
// backed-off restart; one that has exhausted its restart budget degrades to
// pushing the placeholder frame instead of leaving viewers frozen on stale video.
export class CameraStreamer {
  private readonly writers = new Set<ServerResponse>();
  private latestFrame: Buffer | null = null;
  private spawnerHandle: { kill(): void } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private restartWindowStart = 0;
  private stopped = false;

  constructor(private readonly makeSpawner: () => Spawner, private readonly opts: CameraStreamerOpts) {}

  viewerCount(): number {
    return this.writers.size;
  }

  attach(res: ServerResponse): void {
    if (this.stopped) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("camera streamer stopped");
      return;
    }

    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Pragma": "no-cache",
    });

    this.writers.add(res);
    this.writeChunk(res, frameChunk(this.latestFrame ?? PLACEHOLDER_JPEG));

    const detach = (): void => {
      if (!this.writers.delete(res)) return;
      if (this.writers.size === 0) this.stopPipeline();
    };
    res.on("close", detach);
    res.on("error", detach);

    if (this.writers.size === 1) this.startPipeline();
  }

  // Total shutdown (e.g. daemon exit), independent of viewer count: kills the
  // pipeline, closes every attached response, and refuses further attaches.
  stop(): void {
    this.stopped = true;
    this.clearRestartTimer();
    this.killSpawner();
    for (const res of this.writers) {
      try { res.end(); } catch { /* already gone */ }
    }
    this.writers.clear();
  }

  private startPipeline(): void {
    if (this.stopped || this.spawnerHandle) return;
    const spawner = this.makeSpawner();
    this.spawnerHandle = spawner.start(
      (jpeg) => this.pushFrame(jpeg),
      (code) => this.handleExit(code),
    );
  }

  // Called when the viewer count drops to zero: a camera nobody is watching
  // shouldn't keep a gphoto2/ffmpeg pipeline (and the D5000's USB link) busy.
  private stopPipeline(): void {
    this.clearRestartTimer();
    this.killSpawner();
    this.restartCount = 0; // fresh budget for the next viewer
  }

  private killSpawner(): void {
    if (!this.spawnerHandle) return;
    try { this.spawnerHandle.kill(); } catch { /* already dead */ }
    this.spawnerHandle = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  private handleExit(code: number | null): void {
    this.spawnerHandle = null;
    if (this.stopped) return;
    if (this.writers.size === 0) return; // nobody watching -- restart lazily on next attach instead

    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
    this.restartCount += 1;

    if (this.restartCount > MAX_RESTARTS) {
      console.error(`[tb3-camera] pipeline exited (code=${code}) ${this.restartCount} times within ${RESTART_WINDOW_MS}ms; giving up`);
      this.latestFrame = null;
      this.broadcastPlaceholder();
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startPipeline();
    }, this.opts.fallbackMs);
  }

  private pushFrame(jpeg: Buffer): void {
    this.latestFrame = jpeg;
    const chunk = frameChunk(jpeg);
    for (const res of this.writers) this.writeChunk(res, chunk);
  }

  private broadcastPlaceholder(): void {
    const chunk = frameChunk(PLACEHOLDER_JPEG);
    for (const res of this.writers) this.writeChunk(res, chunk);
  }

  private writeChunk(res: ServerResponse, chunk: Buffer): void {
    try { res.write(chunk); }
    catch { /* the 'close'/'error' listener registered in attach() handles cleanup */ }
  }
}

// ---------------------------------------------------------------------------
// realSpawner: NOT unit-tested (real subprocess pipeline; verified on-host).
//
// Primary path: `gphoto2 --capture-movie --stdout | ffmpeg -i - -f mjpeg
// -q:v <q> -r <fps> -`. ffmpeg's stdout under `-f mjpeg` is just JPEG frames
// concatenated back-to-back with no extra framing, so JpegFrameParser below
// splits on raw SOI/EOI byte markers.
//
// Fallback path: some gphoto2/libgphoto2 + camera-firmware combinations
// don't support `--capture-movie` (wrong mode-dial position, PTP quirks,
// etc.) -- if the primary path produces no frame within NO_FRAME_TIMEOUT_MS,
// or dies before ever producing one, this drops to a `--capture-preview`
// loop that captures one JPEG per gphoto2 invocation, polled at fallbackMs.
//
// Which path the D5000 actually supports is an ON-HOST decision (Task 8's
// brief calls this out explicitly) -- this factory tries the fast path first
// and only falls back on evidence it doesn't work, so no build-time
// camera-model branch is needed here.
// ---------------------------------------------------------------------------

// ffmpeg -q:v: 2 (best) .. 31 (worst). 5 keeps frames small enough for a
// LAN/Wi-Fi live-preview stream without stalling on the D5000's slow USB
// transfer at higher quality settings.
const FFMPEG_QUALITY = 5;

// If --capture-movie hasn't produced a single decoded frame in this long,
// treat it as unsupported in the camera's current state and fall back.
const NO_FRAME_TIMEOUT_MS = 8000;

// Consecutive failed preview-loop captures (spawn error, non-zero exit, or a
// stdout blob that isn't a well-formed JPEG) before giving up and calling
// onExit -- letting CameraStreamer's bounded restart retry the whole pipeline
// (including another attempt at the movie path) from scratch.
const PREVIEW_FAIL_LIMIT = 3;

function gphoto2PortArgs(cfg: Config): string[] {
  return cfg.cameraDevicePort ? ["--port", cfg.cameraDevicePort] : [];
}

function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf.indexOf(SOI) === 0 && buf.lastIndexOf(EOI) === buf.length - 2;
}

// Splits a raw MJPEG byte stream into complete per-frame JPEG buffers.
export class JpegFrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const soi = this.buf.indexOf(SOI);
      if (soi === -1) {
        // No SOI anywhere in the buffered tail -- discard it, EXCEPT a
        // trailing lone 0xFF byte, which may be the first half of the next
        // frame's FFD8 marker split across two ffmpeg stdout chunks. Losing
        // it here would silently drop the frame it belongs to once the
        // chunk boundary lands between the two marker bytes.
        this.buf = (this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xff)
          ? this.buf.subarray(this.buf.length - 1)
          : Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.buf = this.buf.subarray(soi);
      const eoi = this.buf.indexOf(EOI, 2);
      if (eoi === -1) break; // incomplete frame -- wait for more data
      const end = eoi + EOI.length;
      frames.push(Buffer.from(this.buf.subarray(0, end)));
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }
}

export function realSpawner(cfg: Config): Spawner {
  return {
    start(onFrame, onExit) {
      let stopped = false;
      let gotFrame = false;
      let leftMoviePhase = false;
      let noFrameTimer: NodeJS.Timeout | null = null;
      let previewTimer: NodeJS.Timeout | null = null;
      let previewFailCount = 0;
      let gphoto2Proc: ChildProcessWithoutNullStreams | null = null;
      let ffmpegProc: ChildProcessWithoutNullStreams | null = null;
      let previewProc: ChildProcessWithoutNullStreams | null = null;

      const clearNoFrameTimer = (): void => { if (noFrameTimer) { clearTimeout(noFrameTimer); noFrameTimer = null; } };
      const clearPreviewTimer = (): void => { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } };

      const killMovie = (): void => {
        clearNoFrameTimer();
        try { ffmpegProc?.kill(); } catch { /* already dead */ }
        try { gphoto2Proc?.kill(); } catch { /* already dead */ }
        ffmpegProc = null; gphoto2Proc = null;
      };
      const killPreview = (): void => {
        clearPreviewTimer();
        try { previewProc?.kill(); } catch { /* already dead */ }
        previewProc = null;
      };

      function startPreviewFallback(): void {
        if (stopped) return;
        const proc = spawn("gphoto2", ["--capture-preview", "--stdout", ...gphoto2PortArgs(cfg)]);
        previewProc = proc;
        const chunks: Buffer[] = [];
        let handled = false;
        proc.stdout.on("data", (c: Buffer) => chunks.push(c));

        const finish = (out: Buffer | null, code: number | null): void => {
          if (handled || stopped) return;
          handled = true;
          previewProc = null;

          if (out && looksLikeJpeg(out)) {
            previewFailCount = 0;
            onFrame(out);
            previewTimer = setTimeout(startPreviewFallback, cfg.cameraFallbackMs);
            return;
          }
          previewFailCount += 1;
          if (previewFailCount >= PREVIEW_FAIL_LIMIT) { onExit(code); return; }
          previewTimer = setTimeout(startPreviewFallback, cfg.cameraFallbackMs);
        };

        proc.on("close", (code) => finish(Buffer.concat(chunks), code));
        proc.on("error", () => finish(null, null));
      }

      function startMovie(): void {
        gotFrame = false;
        leftMoviePhase = false;
        const parser = new JpegFrameParser();

        gphoto2Proc = spawn("gphoto2", ["--capture-movie", "--stdout", ...gphoto2PortArgs(cfg)]);
        ffmpegProc = spawn("ffmpeg", ["-i", "-", "-f", "mjpeg", "-q:v", String(FFMPEG_QUALITY), "-r", String(cfg.cameraFps), "-"]);
        gphoto2Proc.stdout.pipe(ffmpegProc.stdin);

        ffmpegProc.stdout.on("data", (chunk: Buffer) => {
          for (const frame of parser.push(chunk)) {
            if (!gotFrame) { gotFrame = true; clearNoFrameTimer(); }
            onFrame(frame);
          }
        });

        const onMovieExit = (code: number | null): void => {
          if (stopped || leftMoviePhase) return;
          leftMoviePhase = true;
          killMovie();
          if (gotFrame) {
            // Was streaming fine and then died (USB hiccup, cable pull,
            // camera power-off) -- escalate to the caller's bounded restart
            // instead of silently degrading to preview mode mid-stream.
            onExit(code);
          } else {
            startPreviewFallback();
          }
        };
        gphoto2Proc.on("exit", onMovieExit);
        ffmpegProc.on("exit", onMovieExit);
        gphoto2Proc.on("error", () => onMovieExit(null));
        ffmpegProc.on("error", () => onMovieExit(null));

        noFrameTimer = setTimeout(() => {
          if (stopped || gotFrame || leftMoviePhase) return;
          leftMoviePhase = true;
          killMovie();
          startPreviewFallback();
        }, NO_FRAME_TIMEOUT_MS);
      }

      startMovie();

      return {
        kill(): void {
          stopped = true;
          killMovie();
          killPreview();
        },
      };
    },
  };
}
