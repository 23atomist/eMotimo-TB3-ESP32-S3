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
