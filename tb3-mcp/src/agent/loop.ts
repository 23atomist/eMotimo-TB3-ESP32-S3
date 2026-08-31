import { AircraftBrief, ChooseInput, Decision } from "./llm.js";
import { Action, decideAction, failSafeAction } from "./decide.js";

export interface RigMcpClient {
  scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; onlyEligible: boolean; limit: number }): Promise<AircraftBrief[]>;
  getTracked(): Promise<{ hex: string | null }>;
  getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }>;
  track(hex: string): Promise<void>;
  stop(): Promise<void>;
  // Point the rig up between passes so a genuinely idle autonomous rig does
  // not sit wherever the last pass ended -- often the horizon, and the
  // neighbours' houses. Idempotent and guarded server-side (sun-lock,
  // tracking-active, dwell): safe to call on every idle tick.
  parkIdle(): Promise<void>;
}

export interface LoopState { lastSwitchMs: number; }

export interface LoopDeps {
  client: RigMcpClient;
  choose: (input: ChooseInput) => Promise<Decision>;
  cfg: { maxRangeKm: number; minDwellMs: number };
  now: () => number;
}

export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  // The policy gate still runs BEFORE the model sees anything -- it now runs in
  // the daemon (only_eligible), so the dashboard and the agent share one
  // implementation instead of two that can drift.
  const scanned = await deps.client.scanAircraft({
    maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, onlyEligible: true, limit: 20,
  });
  const trackable = [...scanned].sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9));
  const tracked = await deps.client.getTracked();
  const status = await deps.client.getStatus();

  const trackableHexes = new Set(trackable.map((a) => a.hex.toLowerCase()));
  const currentHex = tracked.hex ? tracked.hex.toLowerCase() : null;
  const currentHealthy = currentHex !== null && trackableHexes.has(currentHex);

  let action: Action;
  try {
    const decision = await deps.choose({
      trackable,
      current: { hex: currentHex, label: status.label, state: status.state, pointingErrorDeg: status.pointingErrorDeg },
    });
    action = decideAction({
      decision, trackableHexes, currentHex, currentHealthy,
      msSinceLastSwitch: deps.now() - state.lastSwitchMs, minDwellMs: deps.cfg.minDwellMs,
      candidateCanPreempt:
        trackable.find((a) => a.hex.toLowerCase() === (decision.hex ?? "").toLowerCase())?.canPreempt ?? false,
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  // Nothing being tracked and nothing to track: park up rather than leave the
  // rig wherever the last pass ended. Covers both "just stopped" and "was
  // already idle, still nothing eligible" -- the latter is exactly the
  // multi-minute idle-gap symptom this task exists to fix.
  if (action.kind === "stop" || (action.kind === "keep" && currentHex === null && trackable.length === 0)) {
    await deps.client.parkIdle();
  }

  return { action, state: { lastSwitchMs } };
}
