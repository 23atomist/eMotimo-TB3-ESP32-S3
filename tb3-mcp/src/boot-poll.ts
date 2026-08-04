// Boot-watch poll loop: periodically asks the device how long it's been up,
// feeds that to BootWatcher.observe(), and triggers onReboot() when a reboot
// is detected. Shaped after AdsbSource (src/adsb/source.ts) -- an injectable
// Scheduler, a private async tick with a try/catch/finally that can never
// escape into the scheduler, and a pollOnceForTest() seam -- because it is
// the same kind of long-lived, injected-dependency tick loop, and because
// this loop's own correctness is safety-critical: if it silently dies, the
// rig is exactly as exposed as it was on 2026-08-02, with nothing visibly
// wrong. That is also why this class carries its own in-flight guard, which
// AdsbSource's poll does not need (this one's per-tick work -- a status
// fetch, and on a reboot a full onReboot() gravity/posture read -- can run
// long enough to overlap a 5s tick in the way an ADS-B JSON fetch rarely does).
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { LimitsStore } from "./limits-store.js";
import { BootWatcher } from "./boot-watch.js";
import { Scheduler, realScheduler } from "./track/session.js";
import { onReboot, RezeroPosture } from "./rezero-tools.js";
import { Vec3 } from "./geo/vec3.js";

type OnReboot = typeof onReboot;
type RebootOutcome = Awaited<ReturnType<OnReboot>>;

const STATUS_POLL_TIMEOUT_MS = 3000;

// Timeout/host-fallback mirrors dashboard/rig.ts's RigDirectClient.status():
// try each configured host in turn, swallow per-host failures, and give up
// silently (resolve undefined) rather than throw -- the poller must never let
// a network fault escape as a rejection (see BootWatchPoller.pollOnce). Not
// built on RigDirectClient itself because RigDirect (dashboard/parse.ts)
// doesn't carry uptime_ms -- the one field this poll actually needs -- and
// widening that shared, well-tested type for a single caller isn't worth it.
export async function fetchDeviceUptimeMs(cfg: Config): Promise<number | undefined> {
  const hosts = [cfg.deviceHost, ...(cfg.deviceIpFallback ? [cfg.deviceIpFallback] : [])];
  for (const h of hosts) {
    try {
      const r = await fetch(`http://${h}/api/status`, { signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS) });
      if (!r.ok) continue;
      const body = (await r.json()) as Record<string, unknown>;
      if (typeof body.uptime_ms === "number" && Number.isFinite(body.uptime_ms)) return body.uptime_ms;
    } catch { /* try next host */ }
  }
  return undefined;
}

export interface BootWatchPollerOpts {
  scheduler?: Scheduler;
  now?: () => number;
  intervalMs?: number;
  // Test/DI seams. Defaults are the real implementations; tests override
  // fetchUptimeMs and onRebootFn to drive every branch without a real device
  // or a real IMU/gravity solve.
  fetchUptimeMs?: () => Promise<number | undefined>;
  onRebootFn?: OnReboot;
  log?: (msg: string) => void;
  logError?: (msg: string, e: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5000;

export class BootWatchPoller {
  private timer: { cancel(): void } | null = null;
  private inFlight = false;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly fetchUptimeMs: () => Promise<number | undefined>;
  private readonly onRebootFn: OnReboot;
  private readonly log: (msg: string) => void;
  private readonly logError: (msg: string, e: unknown) => void;

  constructor(
    private readonly boot: BootWatcher,
    private readonly calib: CalibrationStore,
    private readonly limits: LimitsStore,
    private readonly cfg: Config,
    private readonly gravity: () => Promise<Vec3 | undefined>,
    private readonly posture: () => Promise<RezeroPosture>,
    opts: BootWatchPollerOpts = {},
  ) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetchUptimeMs = opts.fetchUptimeMs ?? (() => fetchDeviceUptimeMs(cfg));
    this.onRebootFn = opts.onRebootFn ?? onReboot;
    this.log = opts.log ?? ((m) => console.log(m));
    this.logError = opts.logError ?? ((m, e) => console.error(m, e));
  }

  // I-A: realScheduler.every is setInterval, which fires its first tick only
  // at t+intervalMs (5s by default) -- and a two-host fetchDeviceUptimeMs
  // retry can push detection into a SECOND tick on top of that. In exactly
  // the case this poller exists for (a daemon restart, i.e. no in-memory
  // BootWatcher state yet), calibration.json still reads needsRezero:false
  // for that whole 5-11s window, so every rezeroGuard-gated tool runs on a
  // stale origin right after the daemon comes up. Fixed by running one tick
  // here, awaited, BEFORE scheduling the recurring interval -- server.ts in
  // turn awaits start() before app.listen(), so the guard is armed before
  // the server accepts its first request.
  //
  // This immediate tick goes through the exact same pollOnce()
  // try/catch/finally as a scheduled one, so an unreachable device (or a
  // throwing onReboot) on THIS call cannot escape start() as a rejection --
  // it must not prevent the recurring interval below from being scheduled.
  async start(): Promise<void> {
    if (this.timer) return;
    await this.pollOnce();
    this.timer = this.scheduler.every(this.intervalMs, () => { void this.pollOnce(); });
  }
  stop(): void { this.timer?.cancel(); this.timer = null; }

  /** Test seam: run exactly one tick and await it. */
  pollOnceForTest(): Promise<void> { return this.pollOnce(); }

  private async pollOnce(): Promise<void> {
    // Overlap guard: a slow read (or a slow onReboot solve) still in flight
    // when the next tick fires must be skipped, not stacked -- see this
    // file's module doc.
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const uptimeMs = await this.fetchUptimeMs();
      if (uptimeMs === undefined) return;   // device unreachable this tick -- nothing to observe

      // Runs on EVERY successful read, not just when a reboot looks likely --
      // this is what maintains lastUptimeMs/lastSeenAtMs for the
      // wasDownAcross (unobserved-reboot) check in boot-watch.ts.
      const rebooted = this.boot.observe(uptimeMs, this.now());
      if (!rebooted) return;

      const outcome: RebootOutcome = await this.onRebootFn({
        calib: this.calib, limits: this.limits, boot: this.boot, geoPanSign: this.cfg.geoPanSign,
        gravity: this.gravity, posture: this.posture, bootId: this.boot.bootId(),
      });
      this.logOutcome(outcome);
    } catch (e) {
      // Must never escape into the scheduler -- a rejected status fetch or a
      // throwing onReboot must not kill the poll loop (the exact "reboot went
      // unnoticed" bug this feature exists to fix).
      this.logError("[tb3-mcp] boot-watch status poll failed:", e);
    } finally {
      this.inFlight = false;
    }
  }

  private logOutcome(outcome: RebootOutcome): void {
    const bootId = this.boot.bootId();
    if (outcome.applied) {
      this.log(
        `[tb3-mcp] reboot detected (boot ${bootId}) -- tilt re-zeroed automatically: ` +
        `Δtilt ${outcome.deltaTiltDeg?.toFixed(2)}° (residual ${outcome.residualDeg?.toFixed(2)}°). ` +
        "Pan limits cleared and needsRezero is set -- rezero_from_landmark or rezero_from_aircraft " +
        "is required before automated pan/tilt motion resumes.",
      );
    } else {
      this.log(
        `[tb3-mcp] reboot detected (boot ${bootId}) -- automatic tilt re-zero NOT applied: ` +
        `${outcome.reason}. needsRezero is set -- rezero_from_landmark or rezero_from_aircraft is ` +
        "required before automated pan/tilt motion resumes.",
      );
    }
  }
}
