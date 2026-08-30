import { AircraftBrief, ChooseInput, Decision } from "./llm.js";
import { Action, decideAction, failSafeAction } from "./decide.js";
import { isMilitary, isLargeMilitary, type PolicyTarget } from "../policy/predicates.js";

// TODO(task-5): temporary reimplementation -- the rule evaluator (task 2)
// replaces this with the shipped default ruleset driven off src/policy/.
type Tier = number | null;
function classifyTier(a: PolicyTarget): Tier {
  if (isLargeMilitary(a)) return 1;
  if (isMilitary(a)) return 2;
  if (a.climb_fpm !== null && a.climb_fpm >= 500 && a.altitude_m !== null && a.altitude_m <= 4500 && a.track_deg !== null) {
    const t = ((a.track_deg % 360) + 360) % 360;
    if (t >= 190 && t <= 350) return 3;
  }
  if (a.category !== null && ["A4", "A5"].includes(a.category.toUpperCase()) && a.range_km >= 60 && a.range_km <= 100) return 4;
  return null;
}

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
  const scanned = await deps.client.scanAircraft({ maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, limit: 20 });

  // Policy gate BEFORE the model sees anything. The operator's rules are
  // absolute ("westbound only, never east"), and a small local model will not
  // hold an absolute reliably -- so anything that fits no tier is removed from
  // the candidate list entirely rather than merely discouraged in the prompt.
  // Sorting by tier also means the model reads the best options first.
  const tiers = new Map<string, Tier>();
  for (const a of scanned) tiers.set(a.hex.toLowerCase(), classifyTier(a));
  const trackable = scanned
    .filter((a) => tiers.get(a.hex.toLowerCase()) !== null)
    .sort((a, b) => (tiers.get(a.hex.toLowerCase()) ?? 9) - (tiers.get(b.hex.toLowerCase()) ?? 9));
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
      candidateTier: tiers.get((decision.hex ?? "").toLowerCase()) ?? null,
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  return { action, state: { lastSwitchMs } };
}
