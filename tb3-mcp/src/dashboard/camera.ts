import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { Config } from "../config.js";

// Abstracts the mtplvcap subprocess + MJPEG relay so CameraStreamer's
// viewer-refcount/restart lifecycle is unit-testable with a fake, and the real
// wiring (mtplvcapSpawner, below) stays untested-but-isolated.
export interface Spawner {
  start(onFrame: (jpeg: Buffer) => void, onExit: (code: number | null) => void): { kill(): void };
}

export interface CameraStatus {
  enabled: boolean;
  streaming: boolean;
  viewers: number;
}

export interface CameraStreamerOpts {
  // How long CameraStreamer waits before restarting a dead pipeline.
  fallbackMs: number;
  // Whether the camera is armed at construction. Defaults to false: nothing
  // spawns mtplvcap (or touches the camera's USB) until enable() is called, so
  // a viewer merely connecting never grabs the camera. The dashboard passes
  // cfg.cameraStartEnabled here.
  enabled?: boolean;
}

const BOUNDARY = "frame";
const MAX_RESTARTS = 5;
// If the pipeline has stayed up this long since the first restart in a burst,
// forgive the burst and give it a fresh restart budget.
const RESTART_WINDOW_MS = 60_000;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// The smallest possible valid JPEG (1x1 black pixel) -- shown before the first
// real frame arrives, and again if the pipeline gives up, so "camera off / not
// sending frames" always looks like an image rather than a broken <img> icon.
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
// latest JPEG. Runs the (shared, single) spawner while enabled AND at least one
// viewer is attached, tears it down otherwise, and fans every pushed frame out
// to every attached writer. A dead pipeline with viewers still watching gets a
// bounded, backed-off restart; one that has exhausted its budget degrades to
// pushing the placeholder frame instead of leaving viewers frozen on stale video.
export class CameraStreamer {
  private readonly writers = new Set<ServerResponse>();
  private latestFrame: Buffer | null = null;
  private spawnerHandle: { kill(): void } | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private restartWindowStart = 0;
  private stopped = false;
  private enabled: boolean;
  // Bumped whenever the current pipeline is torn down (kill / stop). A frame or
  // exit callback still carries its spawner's generation, so a late callback
  // from an outgoing spawner -- e.g. a frame buffered before we killed it --
  // is ignored instead of resurrecting a stale frame or nulling a fresh handle.
  private generation = 0;
  // True once the CURRENT pipeline has actually produced a frame (not merely
  // been spawned), so status().streaming means "frames flowing" -- the
  // dashboard renders that as ON vs STARTING.
  private frameSeen = false;

  constructor(
    private readonly makeSpawner: () => Spawner,
    private readonly opts: CameraStreamerOpts,
  ) {
    this.enabled = opts.enabled ?? false;
  }

  viewerCount(): number {
    return this.writers.size;
  }

  status(): CameraStatus {
    return {
      enabled: this.enabled,
      streaming: this.spawnerHandle !== null && this.frameSeen,
      viewers: this.writers.size,
    };
  }

  // Arm the camera (operator clicked Start). Starts the pipeline immediately if
  // anyone is watching; otherwise it starts on the next attach.
  enable(): void {
    if (this.stopped) return;
    this.enabled = true;
    this.restartCount = 0;
    this.clearRestartTimer();
    if (this.writers.size > 0) this.startPipeline(); // no-op if already running
  }

  // Disarm the camera (operator clicked Stop): tear the pipeline down (which
  // stops mtplvcap and releases the camera's USB), drop the last frame, and
  // push the placeholder so any still-attached viewer sees a clean "off" tile.
  disable(): void {
    if (this.stopped) return;
    this.enabled = false;
    this.clearRestartTimer();
    this.killSpawner();
    this.restartCount = 0;
    this.frameSeen = false;
    this.latestFrame = null;
    this.broadcastPlaceholder();
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

    if (this.writers.size === 1) this.startPipeline(); // no-op if disabled
  }

  // Total shutdown (e.g. daemon exit), independent of viewer count.
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
    if (this.stopped || !this.enabled || this.spawnerHandle) return;
    const gen = ++this.generation;
    this.frameSeen = false;
    const spawner = this.makeSpawner();
    this.spawnerHandle = spawner.start(
      (jpeg) => { if (gen === this.generation) this.pushFrame(jpeg); },
      (code) => { if (gen === this.generation) this.handleExit(code); },
    );
  }

  // Called when the viewer count drops to zero: a camera nobody is watching
  // shouldn't keep mtplvcap (and the camera's USB link) busy.
  private stopPipeline(): void {
    this.clearRestartTimer();
    this.killSpawner();
    this.restartCount = 0; // fresh budget for the next viewer
  }

  private killSpawner(): void {
    if (!this.spawnerHandle) return;
    this.generation++; // invalidate in-flight frame/exit callbacks from the outgoing spawner
    try { this.spawnerHandle.kill(); } catch { /* already dead */ }
    this.spawnerHandle = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
  }

  private handleExit(code: number | null): void {
    this.spawnerHandle = null;
    if (this.stopped) return;
    if (!this.enabled) return; // disabled mid-flight -- the killed pipeline's exit is expected
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
    this.frameSeen = true;
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

// Splits a raw MJPEG byte stream into complete per-frame JPEG buffers. Works on
// both ffmpeg-style bare concatenated JPEGs and mtplvcap's multipart/x-mixed-
// replace body (the multipart headers between frames contain no SOI/EOI markers,
// so they're skipped).
export class JpegFrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const soi = this.buf.indexOf(SOI);
      if (soi === -1) {
        // No SOI in the buffered tail -- discard it, EXCEPT a trailing lone
        // 0xFF byte, which may be the first half of the next frame's FFD8
        // marker split across two read chunks.
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

// ---------------------------------------------------------------------------
// mtplvcapSpawner: NOT unit-tested (real subprocess + HTTP relay; on-host).
//
// Spawns mtplvcap, which opens the Nikon over USB, starts Live View, and serves
// an MJPEG stream on 127.0.0.1:<port>/mjpeg. We connect to that stream, split
// it into per-frame JPEGs, and push them. kill() aborts the HTTP read AND
// SIGINTs mtplvcap, which stops Live View and releases the camera's USB so the
// operator can shoot. mtplvcap self-recovers from a wedged MTP session on the
// next start (it resets the session), so an abrupt Stop doesn't brick the next
// Start.
// ---------------------------------------------------------------------------

// mtplvcap needs a moment to open the camera + start Live View + bind its port
// before /mjpeg accepts a connection; retry the connect across this window.
const CONNECT_RETRIES = 20;
const CONNECT_DELAY_MS = 500;
const NIKON_VENDOR_ID = "0x04b0";
// SIGINT lets mtplvcap stop Live View + close the MTP session cleanly. If it
// doesn't exit within this grace window, hard-kill it so the next start isn't
// blocked waiting on a hung process.
const KILL_GRACE_MS = 4000;

// Only ONE mtplvcap may hold the camera's USB/PTP session (and the port) at a
// time -- overlapping instances fight over it and wedge the camera. This is
// module-scoped because the constraint is the single physical camera, not any
// one streamer: a new spawn waits for the previous process to fully exit (see
// begin() below) before starting.
let activeProc: ChildProcess | null = null;

export function mtplvcapSpawner(cfg: Config): Spawner {
  return {
    start(onFrame, onExit) {
      let stopped = false;
      let done = false;
      let attempts = 0;
      let proc: ChildProcess | null = null;
      const controller = new AbortController();
      const parser = new JpegFrameParser();
      const url = `http://127.0.0.1:${cfg.cameraMtplvcapPort}/mjpeg`;

      // SIGINT the child, with a bounded SIGKILL backstop so a hung mtplvcap
      // can't block the next start forever. Detaches our local handle
      // immediately; activeProc is cleared by the child's own exit handler.
      const stopProc = (): void => {
        const p = proc;
        if (!p) return;
        proc = null;
        try { p.kill("SIGINT"); } catch { /* already dead */ }
        const hard = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* dead */ } }, KILL_GRACE_MS);
        p.once("exit", () => clearTimeout(hard));
      };

      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        try { controller.abort(); } catch { /* noop */ }
        stopProc();
        if (!stopped) onExit(code);
      };

      const connect = async (): Promise<void> => {
        if (stopped || done) return;
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`mjpeg HTTP ${res.status}`);
          const reader = res.body.getReader();
          for (;;) {
            const { done: rdone, value } = await reader.read();
            if (rdone) break;
            if (value) for (const frame of parser.push(Buffer.from(value))) onFrame(frame);
          }
          finish(0); // stream ended cleanly -- let the streamer restart if viewers remain
        } catch {
          if (stopped || done) return;
          attempts += 1;
          if (attempts >= CONNECT_RETRIES) { finish(1); return; }
          setTimeout(() => { void connect(); }, CONNECT_DELAY_MS);
        }
      };

      const begin = async (): Promise<void> => {
        // Serialize on the single camera: wait for any prior mtplvcap to exit
        // before spawning a new one, so two never contend for the USB session.
        while (activeProc && !stopped) {
          await once(activeProc, "exit").catch(() => { /* already exited */ });
        }
        if (stopped || done) return;
        const p = spawn(cfg.cameraMtplvcapBin, [
          "-host", "127.0.0.1",
          "-port", String(cfg.cameraMtplvcapPort),
          "-vendor-id", NIKON_VENDOR_ID,
        ], { stdio: "ignore" });
        proc = p;
        activeProc = p;
        p.on("exit", () => { if (activeProc === p) activeProc = null; finish(null); });
        p.on("error", () => finish(null));
        void connect();
      };
      void begin();

      return {
        kill(): void {
          stopped = true;
          try { controller.abort(); } catch { /* noop */ }
          stopProc();
        },
      };
    },
  };
}
