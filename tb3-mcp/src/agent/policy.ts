/**
 * Deterministic target policy for autonomous mode.
 *
 * The LLM is advisory and runs on a small local model; it drifts on multi-clause
 * rules like "westbound only, never east". Anything the operator stated as
 * absolute lives here in code, and the model is left only soft judgement WITHIN
 * a tier (which of three departures is the better film).
 *
 * Tiers, best first:
 *   1  large military      -- the ONLY tier allowed to preempt a pass in progress
 *   2  any other military
 *   3  westbound departure
 *   4  large/heavy traffic at distance
 *   null  not eligible
 */

export interface PolicyTarget {
  category: string | null;      // ADS-B emitter category, A1..A5
  type: string | null;          // ICAO type code from the feed's `t` field
  operator: string | null;      // the feed's `ownOp`
  climb_fpm: number | null;
  track_deg: number | null;
  altitude_m: number | null;
  range_km: number;
}

export type Tier = 1 | 2 | 3 | 4 | null;

// A departure is climbing hard and still low. Both bounds matter: cruise
// traffic stepping up a level also shows a positive rate, and an aircraft at
// FL300 is not "taking off" however fast it is climbing.
export const DEPARTURE_MIN_CLIMB_FPM = 500;
export const DEPARTURE_MAX_ALT_M = 4500;

// Westerly arc, degrees true. Deliberately generous: a departure turning out
// of PHX sweeps through a wide band before settling on course.
export const WEST_MIN_DEG = 190;
export const WEST_MAX_DEG = 350;

// The "big ones far away" fallback band. 60-100 km ~ 37-62 miles.
export const FALLBACK_MIN_KM = 60;
export const FALLBACK_MAX_KM = 100;
export const LARGE_CATEGORIES = new Set(["A4", "A5"]);

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
// "ARMYTAGE HOLDINGS LLC" as military. test/agent-policy.test.ts pins this.
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

export function isWestboundDeparture(a: PolicyTarget): boolean {
  // Every clause is written so a null fails the test rather than passing it:
  // climb rate is absent on roughly a quarter of the feed, and an unknown
  // must never be admitted as a departure.
  if (a.climb_fpm === null || a.climb_fpm < DEPARTURE_MIN_CLIMB_FPM) return false;
  if (a.altitude_m === null || a.altitude_m > DEPARTURE_MAX_ALT_M) return false;
  if (a.track_deg === null) return false;
  const track = ((a.track_deg % 360) + 360) % 360;
  return track >= WEST_MIN_DEG && track <= WEST_MAX_DEG;
}

function isBigAndDistant(a: PolicyTarget): boolean {
  if (a.category === null || !LARGE_CATEGORIES.has(a.category.toUpperCase())) return false;
  return a.range_km >= FALLBACK_MIN_KM && a.range_km <= FALLBACK_MAX_KM;
}

export function classifyTier(a: PolicyTarget): Tier {
  if (isLargeMilitary(a)) return 1;
  if (isMilitary(a)) return 2;
  if (isWestboundDeparture(a)) return 3;
  // Reached by an EASTBOUND departure too, and that is intended: it is barred
  // from the departure tier, but a big one far out is still worth filming.
  if (isBigAndDistant(a)) return 4;
  return null;
}

/** Only tier 1 may interrupt a healthy pass already in progress. */
export function canPreempt(tier: Tier): boolean {
  return tier === 1;
}
