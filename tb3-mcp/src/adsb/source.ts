import { Config } from "../config.js";
import { Scheduler, realScheduler } from "../track/session.js";
import { AdsbSnapshot } from "./types.js";
import { parseAircraftJson } from "./parse.js";

const FETCH_TIMEOUT_MS = 4000;

export interface AdsbSourceOpts {
  scheduler?: Scheduler;
  now?: () => number;
  fetchFn?: typeof fetch;
  onSnapshot?: (s: AdsbSnapshot) => void;
}

export class AdsbSource {
  private snapshot: AdsbSnapshot;
  private timer: { cancel(): void } | null = null;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly onSnapshot?: (s: AdsbSnapshot) => void;

  constructor(private readonly cfg: Config, opts: AdsbSourceOpts = {}) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onSnapshot = opts.onSnapshot;
    this.snapshot = { aircraft: [], fetchedAtMs: 0, ok: false };
  }

  start(): void {
    if (this.timer) return;
    const ms = Math.max(100, Math.round(1000 / this.cfg.adsbPollHz));
    this.timer = this.scheduler.every(ms, () => { void this.poll(); });
  }
  stop(): void { this.timer?.cancel(); this.timer = null; }

  getSnapshot(): AdsbSnapshot { return this.snapshot; }

  /** Test seam: run exactly one poll and await it. */
  pollOnceForTest(): Promise<void> { return this.poll(); }

  private async poll(): Promise<void> {
    try {
      const r = await this.fetchFn(this.cfg.adsbUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      this.snapshot = { aircraft: parseAircraftJson(body), fetchedAtMs: this.now(), ok: true };
    } catch (e) {
      this.snapshot = {
        aircraft: [], fetchedAtMs: this.now(), ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    this.onSnapshot?.(this.snapshot);
  }
}
