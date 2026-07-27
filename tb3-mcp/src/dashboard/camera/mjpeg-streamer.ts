import type { ServerResponse } from "node:http";
import type { Spawner } from "./supervisor.js";

export interface CameraStatus {
  enabled: boolean;
  streaming: boolean;
  viewers: number;
  // Only meaningful on the MediaMTX publisher path (see publisher.ts): true
  // when the ingest pipeline has exhausted its restart budget and is
  // waiting on the next periodic recovery attempt rather than actively
  // retrying. Omitted (never set) by CameraStreamer, whose restart budget
  // resets on last-viewer-detach instead. Optional so the many existing
  // fixtures/tests that construct a bare {enabled, streaming, viewers}
  // still compile and compare equal.
  degraded?: boolean;
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
