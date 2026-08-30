import { inArc } from "../track/sector.js";
import { isMilitary, isLargeMilitary, type PolicyTarget } from "./predicates.js";

export type NumericField =
  | "climb_fpm" | "altitude_m" | "track_deg" | "range_km"
  | "elevation_deg" | "ground_speed_kt" | "est_track_sec";
export type SetField = "category" | "type";
export type PredicateName = "is_military" | "is_large_military";

export type Condition =
  | { field: NumericField; op: "gte" | "lte"; value: number }
  | { field: NumericField; op: "within" | "not_within"; value: number; value2: number }
  | { field: SetField; op: "in"; values: string[] }
  | { predicate: PredicateName };

export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  canPreempt: boolean;
  conditions: Condition[];
}

export interface Ruleset { version: 1; rules: PolicyRule[] }

export interface RuleMatch {
  tier: number;          // 1-based position among ENABLED rules
  ruleId: string;
  ruleName: string;
  canPreempt: boolean;
}

export const NUMERIC_FIELDS: NumericField[] = [
  "climb_fpm", "altitude_m", "track_deg", "range_km",
  "elevation_deg", "ground_speed_kt", "est_track_sec",
];
export const SET_FIELDS: SetField[] = ["category", "type"];
export const PREDICATES: PredicateName[] = ["is_military", "is_large_military"];

// Only headings wrap. range_km within 100..20 is an operator mistake, not a
// band spanning zero, and silently treating it as one would admit everything.
const ANGLE_FIELDS = new Set<NumericField>(["track_deg"]);

function numericOf(t: PolicyTarget, f: NumericField): number | null {
  const v = t[f];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function setValueOf(t: PolicyTarget, f: SetField): string | null {
  const v = t[f];
  return typeof v === "string" && v.trim() !== "" ? v.trim().toUpperCase() : null;
}

// Every branch is written so an ABSENT value fails -- including not_within,
// where "the field is not in the band" is tempting but wrong: climb_fpm is
// missing on roughly a quarter of the feed, and an unknown must never be
// admitted. Enforced here once so no future rule can reintroduce it.
function passes(t: PolicyTarget, c: Condition): boolean {
  if ("predicate" in c) {
    return c.predicate === "is_large_military" ? isLargeMilitary(t) : isMilitary(t);
  }
  if (c.op === "in") {
    const v = setValueOf(t, c.field);
    if (v === null) return false;
    return c.values.some((x) => x.trim().toUpperCase() === v);
  }
  const v = numericOf(t, c.field);
  if (v === null) return false;
  if (c.op === "gte") return v >= c.value;
  if (c.op === "lte") return v <= c.value;
  if (c.op === "within" || c.op === "not_within") {
    const within = ANGLE_FIELDS.has(c.field)
      ? inArc(v, { enabled: true, startDeg: c.value, endDeg: c.value2 })
      : v >= c.value && v <= c.value2;
    return c.op === "within" ? within : !within;
  }
  return false;
}

/**
 * First enabled rule whose conditions ALL pass. Tier is the 1-based position
 * among enabled rules, so toggling one off promotes the rest rather than
 * leaving a hole in the numbering.
 */
export function evaluate(t: PolicyTarget, rs: Ruleset): RuleMatch | null {
  let tier = 0;
  for (const r of rs.rules) {
    if (!r.enabled) continue;
    tier += 1;
    if (r.conditions.every((c) => passes(t, c))) {
      return { tier, ruleId: r.id, ruleName: r.name, canPreempt: r.canPreempt };
    }
  }
  return null;
}

/**
 * Reproduces the pre-2026-08-30 hard-coded classifyTier exactly, so a rig with
 * no policy.json behaves as it always has. test/policy-rules.test.ts pins the
 * equivalence; do not "tidy" these numbers.
 */
export const DEFAULT_RULESET: Ruleset = {
  version: 1,
  rules: [
    { id: "large-military", name: "Large military", enabled: true, canPreempt: true,
      conditions: [{ predicate: "is_large_military" }] },
    { id: "military", name: "Any military", enabled: true, canPreempt: false,
      conditions: [{ predicate: "is_military" }] },
    { id: "westbound-departure", name: "Westbound departure", enabled: true, canPreempt: false,
      conditions: [
        { field: "climb_fpm", op: "gte", value: 500 },
        { field: "altitude_m", op: "lte", value: 4500 },
        { field: "track_deg", op: "within", value: 190, value2: 350 },
      ] },
    { id: "big-and-distant", name: "Big & distant", enabled: true, canPreempt: false,
      conditions: [
        { field: "category", op: "in", values: ["A4", "A5"] },
        { field: "range_km", op: "within", value: 60, value2: 100 },
      ] },
  ],
};
