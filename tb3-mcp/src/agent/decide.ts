import { Decision } from "./llm.js";

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
  // Don't drop a healthy current target until it has had its dwell.
  if (inp.currentHex !== null && inp.currentHealthy && inp.msSinceLastSwitch < inp.minDwellMs) {
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
