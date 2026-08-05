export interface StampedFrame { jpegBase64: string; exposureMs: number; arrivedMs: number }
export interface FramePipe { onFrame(cb: (jpeg: Buffer) => void): void; kill(): void }
export interface FrameSource { latest(): StampedFrame | null; start(): void; stop(): void }

export interface MjpegPipeDeps {
  spawnPipe: () => FramePipe;
  now: () => number;
  // Read per frame, NOT captured at construction: a latency re-measured after
  // a zoom must take effect without restarting the source.
  latencyMs: () => number;
}

export class MjpegPipeSource implements FrameSource {
  private pipe: FramePipe | null = null;
  private newest: StampedFrame | null = null;
  constructor(private readonly deps: MjpegPipeDeps) {}

  start(): void {
    if (this.pipe) return;
    this.pipe = this.deps.spawnPipe();
    this.pipe.onFrame((jpeg) => {
      const arrivedMs = this.deps.now();
      this.newest = {
        jpegBase64: jpeg.toString("base64"),
        arrivedMs,
        // The frame describes the past. Everything downstream must use this,
        // never now().
        exposureMs: arrivedMs - this.deps.latencyMs(),
      };
    });
  }

  stop(): void { this.pipe?.kill(); this.pipe = null; this.newest = null; }
  latest(): StampedFrame | null { return this.newest; }
}
