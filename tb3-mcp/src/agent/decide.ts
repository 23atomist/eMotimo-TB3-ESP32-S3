import { Decision } from "./llm.js";

// TODO(task-5): temporary placeholder -- the rule evaluator (task 2) replaces
// this with a real preemption check driven by the shipped ruleset.
type Tier = number | null;
const canPreempt = (t: Tier): boolean => t === 1;

export type Action =
  | { kind: "track"; hex: string }
  | { kind: "keep" }
  | { kind: "stop" };

export interface DecideInput {
  decision: Decision;
  trackableHexes: Set<string>;
  currentHex: string | null;
  currentHealthy: boolean;
  msSinceLastSwitch: number;
  minDwellMs: number;
  // Policy tier of the aircraft the LLM wants to switch TO.
  // Only tier 1 (large military) may interrupt a healthy pass; everything else
  // waits for the current target to be lost.
  candidateTier: Tier;
}

// Turn an advisory LLM decision into a safe action. The daemon has already
// guaranteed every trackable hex is reachable/sun-safe/slew-able; here we only
// stop the agent thrashing and reject hallucinated hexes.
export function decideAction(inp: DecideInput): Action {
  const d = inp.decision;
  if (d.action === "stop") return inp.currentHex === null ? { kind: "keep" } : { kind: "stop" };
  if (d.action === "keep") return { kind: "keep" };

  // action === "track"
  const hex = d.hex?.toLowerCase();
  if (!hex || !inp.trackableHexes.has(hex)) return { kind: "keep" };   // hallucinated / stale
  if (hex === inp.currentHex) return { kind: "keep" };                 // already on it
  // Hold until the pass ends: a healthy target is never dropped on elapsed
  // time. minDwellMs is deliberately no longer consulted -- the operator asked
  // for commitment, and a timer is exactly what produced the switching they
  // did not want. The single exception is a tier-1 (large military) candidate,
  // which is rare enough that letting it interrupt cannot cause thrash.
  if (inp.currentHex !== null && inp.currentHealthy && !canPreempt(inp.candidateTier)) {
    return { kind: "keep" };
  }
  return { kind: "track", hex };
}

// On an LLM fault (timeout/error/invalid), don't guess: hold a healthy target,
// stop one that is already lost, do nothing when idle.
export function failSafeAction(currentHex: string | null, currentHealthy: boolean): Action {
  if (currentHex === null) return { kind: "keep" };
  return currentHealthy ? { kind: "keep" } : { kind: "stop" };
}
