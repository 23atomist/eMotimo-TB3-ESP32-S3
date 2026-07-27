import { SpawnSupervisor, type Spawner } from "./supervisor.js";
import type { CameraStatus } from "./mjpeg-streamer.js";

// How often, while armed and degraded, to reset the restart budget and try
// again. See the constructor comment for why this exists at all.
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;

export interface MediaMtxPublisherOpts {
  fallbackMs: number;
  enabled?: boolean;
  // Overridable for tests; production callers should leave this at the
  // default.
  recoveryIntervalMs?: number;
}

// Arm-driven publisher: while armed, ffmpeg publishes to MediaMTX whether or
// not anyone is watching. That is the deliberate difference from CameraStreamer
// -- recording an unattended aircraft pass requires ingest that viewers do not
// gate. Stop is still a hard device release.
export class MediaMtxPublisher {
  private armed: boolean;
  private readers = 0;
  private readonly sup: SpawnSupervisor;
  private readonly recoveryTimer: NodeJS.Timeout;

  constructor(makeSpawner: () => Spawner, opts: MediaMtxPublisherOpts) {
    this.armed = opts.enabled ?? false;
    this.sup = new SpawnSupervisor(makeSpawner, {
      fallbackMs: opts.fallbackMs,
      shouldRun: () => this.armed,
    });
    this.sup.sync();

    // SpawnSupervisor's restart budget is bounded ON PURPOSE (5 attempts in
    // 60s by default) so an unreachable target doesn't spin ffmpeg forever
    // -- but once it's exhausted, NOTHING else ever asks again: the
    // reader-count poll (see dashboard/server.ts) only calls
    // setReaderCount(), never sync()/retry(). Unlike CameraStreamer, whose
    // budget resets for free on last-viewer-detach (mjpeg-streamer.ts's
    // stopPipeline), this publisher is viewer-independent, so a
    // `systemctl restart mediamtx`, a MediaMTX crash-loop, or this rig's
    // documented suspend/resume instability all leave ingest permanently
    // "gave up" with the tile stuck reading enabled+not-streaming forever
    // -- the exact "Camera: STARTING..." forever symptom this whole
    // publisher path exists to eliminate, just moved one layer down. This
    // timer is the self-heal: every recoveryIntervalMs, if still armed and
    // still degraded, reset the budget and try again -- no operator has to
    // notice and press Stop/Start on a roof-mounted rig.
    const recoveryIntervalMs = opts.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.recoveryTimer = setInterval(() => {
      if (this.armed && this.sup.isDegraded()) this.sup.retry();
    }, recoveryIntervalMs);
    this.recoveryTimer.unref();
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
      // Only present (and true) once the restart budget has actually been
      // exhausted -- omitted otherwise so status() still compares equal to
      // the plain {enabled, streaming, viewers} shape everywhere else.
      ...(this.sup.isDegraded() ? { degraded: true } : {}),
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
    clearInterval(this.recoveryTimer);
    this.sup.stop();
  }
}
