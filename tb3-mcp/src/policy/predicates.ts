/**
 * Military-aircraft predicates for target policy.
 *
 * Pulled out of src/agent/ so the daemon's rule evaluator can use them without
 * importing from the agent module (backwards layering). See Task 2 for the
 * data-driven rule engine these predicates feed.
 */

export interface PolicyTarget {
  category: string | null;      // ADS-B emitter category, A1..A5
  type: string | null;          // ICAO type code from the feed's `t` field
  operator: string | null;      // the feed's `ownOp`
  climb_fpm: number | null;
  track_deg: number | null;
  altitude_m: number | null;
  range_km: number;
  elevation_deg: number | null;
  ground_speed_kt: number | null;
  est_track_sec: number | null;
}

// ICAO type codes. Kept as data, not regex, so extending them is a one-line
// edit and cannot accidentally widen the match.
export const LARGE_MILITARY_TYPES = new Set([
  "C17", "C5", "C5M", "C130", "C30J", "L100",
  "KC135", "KC35R", "K35R", "KC46", "KC10",
  "B52", "B1", "B2", "E3TF", "E3CF", "E6", "E8",
  "P8", "P8A", "RC135", "C40", "C32", "VC25", "A400",
]);

export const OTHER_MILITARY_TYPES = new Set([
  "F16", "F15", "F18", "FA18", "F22", "F35", "A10", "AV8B",
  "T38", "T6", "T45", "T7",
  "AH64", "UH60", "CH47", "V22", "MH60", "HH60",
  "MQ9", "RQ4", "E2", "C12", "C21", "U2",
]);

// Word-boundary matched: a naive substring test would flag an operator like
// "ARMYTAGE HOLDINGS LLC" as military. test/policy-predicates.test.ts pins this.
const MILITARY_OPERATOR =
  /\b(AIR FORCE|USAF|NAVY|USN|ARMY|MARINE CORPS|MARINES|USMC|COAST GUARD|USCG|NATIONAL GUARD|DEPT OF DEFENSE|DEPARTMENT OF DEFENSE|DOD)\b/i;

const typeOf = (a: PolicyTarget): string => (a.type ?? "").trim().toUpperCase();

export function isLargeMilitary(a: PolicyTarget): boolean {
  // Deliberately type-only: an aircraft known military solely from its
  // operator string has no size information, and guessing it into the one
  // tier that can interrupt a pass in progress is the wrong way to be wrong.
  return LARGE_MILITARY_TYPES.has(typeOf(a));
}

export function isMilitary(a: PolicyTarget): boolean {
  const t = typeOf(a);
  if (LARGE_MILITARY_TYPES.has(t) || OTHER_MILITARY_TYPES.has(t)) return true;
  return a.operator !== null && MILITARY_OPERATOR.test(a.operator);
}
