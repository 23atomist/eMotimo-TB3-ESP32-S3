//
// Detects that the device's step origin has been lost.
//
// The firmware does not persist step position: current_steps starts at zero
// wherever the head physically sits at boot. Every power cycle and every OTA
// flash therefore invalidates the taught limits and the calibration, and until
// this existed nothing noticed -- on 2026-08-02 the guard drove tilt into its
// mechanical stop while enforcing the previous origin's numbers.
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface BootState { bootId: number; lastUptimeMs: number; lastSeenAtMs: number }

// Wall-clock slack before "elapsed exceeds uptime" counts as an unobserved
// reboot. Absorbs poll jitter and small clock steps; well under any real
// power cycle, which shows up as minutes of discrepancy.
const UNOBSERVED_SLACK_MS = 30_000;

export function detectBoot(
  prev: BootState | undefined, uptimeMs: number, nowMs: number,
): { state: BootState; rebooted: boolean } {
  if (!prev) return { state: { bootId: 1, lastUptimeMs: uptimeMs, lastSeenAtMs: nowMs }, rebooted: false };

  // Case 1: we watched it happen -- uptime went backwards.
  const wentBackwards = uptimeMs < prev.lastUptimeMs;
  // Case 2: we were down across it. The device has been up for less time than
  // has elapsed since we last looked, so it restarted in the gap. Without this
  // check, restarting the daemon after a power cycle silently adopts the stale
  // calibration as current -- the exact failure this module exists to prevent.
  const elapsed = nowMs - prev.lastSeenAtMs;
  const wasDownAcross = elapsed - uptimeMs > UNOBSERVED_SLACK_MS;

  const rebooted = wentBackwards || wasDownAcross;
  return {
    state: { bootId: prev.bootId + (rebooted ? 1 : 0), lastUptimeMs: uptimeMs, lastSeenAtMs: nowMs },
    rebooted,
  };
}

export class BootWatcher {
  private state: BootState | undefined;
  constructor(private readonly filePath: string) {}

  load(): void {
    if (!existsSync(this.filePath)) return;
    try { this.state = JSON.parse(readFileSync(this.filePath, "utf8")) as BootState; }
    catch { this.state = undefined; }   // a corrupt file must not wedge startup
  }

  observe(uptimeMs: number, nowMs: number): boolean {
    const { state, rebooted } = detectBoot(this.state, uptimeMs, nowMs);
    this.state = state;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.filePath);
    return rebooted;
  }

  bootId(): number { return this.state?.bootId ?? 0; }
}
