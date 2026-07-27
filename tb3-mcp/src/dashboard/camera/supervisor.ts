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
  // True from the moment the restart budget is exhausted (handleExit's
  // give-up branch) until the NEXT spawn attempt actually begins (start()
  // clears it). A caller (see MediaMtxPublisher) uses this to tell "still
  // retrying on its own backoff schedule" apart from "gave up; nothing will
  // bring it back without an external nudge" -- the two read identically as
  // running()===false otherwise.
  private degraded = false;
  // Bumped on every teardown so a late frame/exit callback from an outgoing
  // spawner cannot resurrect a stale frame or null out a fresh handle.
  private generation = 0;

  constructor(
    private readonly makeSpawner: () => Spawner,
    private readonly opts: SupervisorOpts,
  ) {}

  running(): boolean { return this.handle !== null; }
  frameSeen(): boolean { return this.seenFrame; }
  isDegraded(): boolean { return this.degraded; }

  // Reconcile the pipeline against shouldRun(). Safe to call repeatedly.
  sync(): void {
    if (this.stopped) return;
    if (this.opts.shouldRun()) this.start();
    else this.teardown();
  }

  // Reset the restart budget and try again, regardless of how long ago the
  // budget was exhausted. This is the self-heal path a give-up state has no
  // other way out of: handleExit's give-up branch below never reschedules
  // anything on its own, on purpose (an unreachable MediaMTX/target must not
  // spin ffmpeg forever) -- so something outside the backoff loop has to
  // periodically ask again. See MediaMtxPublisher's recovery timer.
  retry(): void {
    if (this.stopped) return;
    this.restartCount = 0;
    this.sync();
  }

  // Tear the current pipeline down without ending the supervisor's life.
  teardown(): void {
    this.clearRestartTimer();
    this.kill();
    this.restartCount = 0;
    this.seenFrame = false;
    this.degraded = false; // a deliberate teardown (e.g. disable()) is OFF, not "gave up"
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
    this.degraded = false; // a fresh attempt is underway, whatever prompted it
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
      this.degraded = true;
      this.opts.onDegraded?.();
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.opts.fallbackMs);
  }
}
