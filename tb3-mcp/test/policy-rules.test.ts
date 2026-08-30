import { describe, it, expect } from "vitest";
import { evaluate, DEFAULT_RULESET, type Ruleset, type PolicyRule } from "../src/policy/rules.js";
import type { PolicyTarget } from "../src/policy/predicates.js";

function target(over: Partial<PolicyTarget> = {}): PolicyTarget {
  return {
    category: null, type: null, operator: null,
    climb_fpm: null, track_deg: null, altitude_m: null,
    range_km: 10, elevation_deg: null, ground_speed_kt: null, est_track_sec: null,
    ...over,
  };
}
function rules(...rs: PolicyRule[]): Ruleset { return { version: 1, rules: rs }; }
function rule(over: Partial<PolicyRule> = {}): PolicyRule {
  return { id: "r1", name: "R1", enabled: true, canPreempt: false, conditions: [], ...over };
}

describe("evaluate — matching", () => {
  it("a rule with no conditions matches everything (an explicit catch-all)", () => {
    const m = evaluate(target(), rules(rule()));
    expect(m?.tier).toBe(1);
    expect(m?.ruleId).toBe("r1");
  });

  it("requires ALL conditions to pass (AND, not OR)", () => {
    const r = rule({ conditions: [
      { field: "climb_fpm", op: "gte", value: 500 },
      { field: "altitude_m", op: "lte", value: 4500 },
    ] });
    expect(evaluate(target({ climb_fpm: 900, altitude_m: 3000 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ climb_fpm: 900, altitude_m: 9000 }), rules(r))).toBeNull();
  });

  it("returns the FIRST matching rule and its 1-based position as the tier", () => {
    const a = rule({ id: "a", name: "A", conditions: [{ field: "range_km", op: "lte", value: 50 }] });
    const b = rule({ id: "b", name: "B", conditions: [] });
    const m = evaluate(target({ range_km: 10 }), rules(a, b));
    expect(m?.ruleId).toBe("a");
    expect(m?.tier).toBe(1);
  });

  it("carries canPreempt through from the matched rule", () => {
    const m = evaluate(target(), rules(rule({ canPreempt: true })));
    expect(m?.canPreempt).toBe(true);
  });

  it("returns null when nothing matches", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "gte", value: 500 }] });
    expect(evaluate(target({ range_km: 10 }), rules(r))).toBeNull();
  });

  it("returns null for an empty ruleset (legal: 'track nothing')", () => {
    expect(evaluate(target(), rules())).toBeNull();
  });
});

describe("evaluate — disabled rules", () => {
  it("skips a disabled rule entirely", () => {
    const off = rule({ id: "off", enabled: false, conditions: [] });
    expect(evaluate(target(), rules(off))).toBeNull();
  });

  it("numbers tiers over ENABLED rules only, so disabling promotes the rest", () => {
    const off = rule({ id: "off", enabled: false, conditions: [] });
    const on = rule({ id: "on", name: "On", conditions: [] });
    const m = evaluate(target(), rules(off, on));
    expect(m?.ruleId).toBe("on");
    expect(m?.tier).toBe(1);        // NOT 2 -- no gaps
  });
});

describe("evaluate — null never passes", () => {
  it("fails a numeric condition when the field is null", () => {
    const r = rule({ conditions: [{ field: "climb_fpm", op: "gte", value: 500 }] });
    expect(evaluate(target({ climb_fpm: null }), rules(r))).toBeNull();
  });

  it("fails a NEGATIVE condition when the field is null, rather than passing by absence", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "not_within", value: 50, value2: 130 }] });
    expect(evaluate(target({ track_deg: null }), rules(r))).toBeNull();
  });

  it("fails an `in` condition when the field is null", () => {
    const r = rule({ conditions: [{ field: "category", op: "in", values: ["A4"] }] });
    expect(evaluate(target({ category: null }), rules(r))).toBeNull();
  });
});

describe("evaluate — operators", () => {
  it("gte and lte are inclusive", () => {
    const gte = rule({ conditions: [{ field: "range_km", op: "gte", value: 10 }] });
    const lte = rule({ conditions: [{ field: "range_km", op: "lte", value: 10 }] });
    expect(evaluate(target({ range_km: 10 }), rules(gte))).not.toBeNull();
    expect(evaluate(target({ range_km: 10 }), rules(lte))).not.toBeNull();
  });

  it("within is inclusive on both bounds", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "within", value: 60, value2: 100 }] });
    expect(evaluate(target({ range_km: 60 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ range_km: 100 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ range_km: 59.9 }), rules(r))).toBeNull();
  });

  it("wraps track_deg across north", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "within", value: 340, value2: 20 }] });
    expect(evaluate(target({ track_deg: 350 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 10 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 180 }), rules(r))).toBeNull();
  });

  it("does NOT wrap a non-angular field", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "within", value: 100, value2: 20 }] });
    expect(evaluate(target({ range_km: 50 }), rules(r))).toBeNull();
  });

  it("not_within is the exact complement of within for a present value", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "not_within", value: 340, value2: 20 }] });
    expect(evaluate(target({ track_deg: 180 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 10 }), rules(r))).toBeNull();
  });

  it("in matches case-insensitively and trimmed", () => {
    const r = rule({ conditions: [{ field: "type", op: "in", values: ["c17"] }] });
    expect(evaluate(target({ type: " C17 " }), rules(r))).not.toBeNull();
  });
});

describe("evaluate — predicates", () => {
  it("is_large_military matches on type", () => {
    const r = rule({ conditions: [{ predicate: "is_large_military" }] });
    expect(evaluate(target({ type: "C17" }), rules(r))).not.toBeNull();
    expect(evaluate(target({ type: "F16" }), rules(r))).toBeNull();
  });

  it("is_military combines with numeric conditions", () => {
    const r = rule({ conditions: [
      { predicate: "is_military" },
      { field: "altitude_m", op: "lte", value: 3000 },
    ] });
    expect(evaluate(target({ type: "F16", altitude_m: 2000 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ type: "F16", altitude_m: 9000 }), rules(r))).toBeNull();
  });
});

// The migration proof: the shipped defaults must reproduce the pre-existing
// classifyTier exactly, so nothing changes until the operator edits a rule.
describe("DEFAULT_RULESET reproduces the original four tiers", () => {
  const tierOf = (t: PolicyTarget) => evaluate(t, DEFAULT_RULESET)?.tier ?? null;

  it("tier 1: large military", () => {
    expect(tierOf(target({ type: "C17" }))).toBe(1);
  });
  it("tier 2: other military by type", () => {
    expect(tierOf(target({ type: "F16" }))).toBe(2);
  });
  it("tier 2: military by operator string", () => {
    expect(tierOf(target({ operator: "UNITED STATES AIR FORCE" }))).toBe(2);
  });
  it("tier 3: westbound departure", () => {
    expect(tierOf(target({ climb_fpm: 1800, altitude_m: 2500, track_deg: 275 }))).toBe(3);
  });
  it("NOT tier 3: eastbound departure", () => {
    expect(tierOf(target({ climb_fpm: 3264, altitude_m: 1768, track_deg: 83 }))).toBeNull();
  });
  it("NOT tier 3: descending arrival", () => {
    expect(tierOf(target({ climb_fpm: -960, altitude_m: 785, track_deg: 275 }))).toBeNull();
  });
  it("NOT tier 3: climbing but too high", () => {
    expect(tierOf(target({ climb_fpm: 1800, altitude_m: 9000, track_deg: 275 }))).toBeNull();
  });
  it("tier 4: large category at distance", () => {
    expect(tierOf(target({ category: "A5", range_km: 80 }))).toBe(4);
  });
  it("NOT tier 4: large category too close", () => {
    expect(tierOf(target({ category: "A5", range_km: 20 }))).toBeNull();
  });
  it("only tier 1 may preempt", () => {
    expect(evaluate(target({ type: "C17" }), DEFAULT_RULESET)?.canPreempt).toBe(true);
    expect(evaluate(target({ type: "F16" }), DEFAULT_RULESET)?.canPreempt).toBe(false);
  });
});
