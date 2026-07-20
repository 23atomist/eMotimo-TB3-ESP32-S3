import { AircraftBrief, ChooseInput, Decision } from "./llm.js";
import { Action, decideAction, failSafeAction } from "./decide.js";

export interface RigMcpClient {
  scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]>;
  getTracked(): Promise<{ hex: string | null }>;
  getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }>;
  track(hex: string): Promise<void>;
  stop(): Promise<void>;
}

export interface LoopState { lastSwitchMs: number; }

export interface LoopDeps {
  client: RigMcpClient;
  choose: (input: ChooseInput) => Promise<Decision>;
  cfg: { maxRangeKm: number; minDwellMs: number };
  now: () => number;
}

export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  const trackable = await deps.client.scanAircraft({ maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, limit: 20 });
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
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  return { action, state: { lastSwitchMs } };
}
