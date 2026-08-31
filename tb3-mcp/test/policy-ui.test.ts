import { describe, it, expect } from "vitest";
import { validateRule, newRule, moveRule, countMatches, seedPolicy, policyLocal } from "../dashboard/public/policy.js";

describe("validateRule", () => {
  it("accepts a complete rule", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "climb_fpm", op: "gte", value: 500 }] })).toBeNull();
  });

  it("rejects an empty name, which would render as a blank row", () => {
    expect(validateRule({ id: "a", name: "  ", enabled: true, canPreempt: false, conditions: [] }))
      .toMatch(/name/i);
  });

  it("rejects a condition with a missing value, so a half-typed rule cannot be saved", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "climb_fpm", op: "gte", value: null }] })).toMatch(/value/i);
  });

  it("rejects a within condition missing its upper bound", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "track_deg", op: "within", value: 190, value2: null }] })).toMatch(/value/i);
  });

  it("rejects an `in` condition with no values selected", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "category", op: "in", values: [] }] })).toMatch(/at least one/i);
  });

  it("accepts a rule with no conditions -- an explicit catch-all", () => {
    expect(validateRule({ id: "a", name: "Everything", enabled: true, canPreempt: false, conditions: [] }))
      .toBeNull();
  });
});

describe("newRule", () => {
  it("mints a unique id each time so reordering stays non-destructive", () => {
    expect(newRule().id).not.toBe(newRule().id);
  });
  it("defaults canPreempt to false -- interrupting a pass is opt-in", () => {
    expect(newRule().canPreempt).toBe(false);
  });
  // Controller ruling on task-7-brief.md: conditions:[] matches EVERYTHING
  // (evaluate()'s .every() over an empty array is vacuously true -- pinned by
  // policy-rules.test.ts and policy-store.test.ts, and must not change).
  // Combined with the brief's original enabled:true, pressing "+ Add rule"
  // then Save would silently arm an enabled catch-all before the operator
  // has typed a single condition. Starting disabled costs one extra click
  // and removes that footgun.
  it("defaults enabled to false -- an empty-condition rule matches everything, so a freshly added rule must not go live until the operator arms it", () => {
    expect(newRule().enabled).toBe(false);
  });
});

describe("moveRule", () => {
  const rs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves a rule up", () => {
    expect(moveRule(rs, 1, -1).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
  it("moves a rule down", () => {
    expect(moveRule(rs, 1, 1).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op at the top edge", () => {
    expect(moveRule(rs, 0, -1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("is a no-op at the bottom edge", () => {
    expect(moveRule(rs, 2, 1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("does not mutate the input array", () => {
    moveRule(rs, 1, -1);
    expect(rs.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

// M-1/M-2: matches on ruleId (never `rule`, the display name -- two rules
// can share one), and reports { total, trackable } rather than a single
// number, since `aircraft` here is always the only_trackable:false
// population (state.adsb.aircraft) -- a rule can read high while every
// matching plane is unreachable/sun-blocked/out of sector/stale, which is
// exactly what this panel exists to surface, not hide behind one count.
describe("countMatches", () => {
  it("counts aircraft per rule using the daemon's ruleId annotation, reporting trackable-of-total", () => {
    const rules = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const aircraft = [
      { ruleId: "a", trackable: true }, { ruleId: "a", trackable: false },
      { ruleId: "b", trackable: true }, { ruleId: null, trackable: true },
    ];
    expect(countMatches(rules, aircraft)).toEqual([
      { total: 2, trackable: 1 },
      { total: 1, trackable: 1 },
    ]);
  });

  // The whole point of M-1: two rules with the same operator-chosen name
  // must never be conflated into one count just because `rule` (the name)
  // collided.
  it("does not conflate two same-named rules -- matches on id, not name", () => {
    const rules = [{ id: "a", name: "Departures" }, { id: "b", name: "Departures" }];
    const aircraft = [
      { ruleId: "a", trackable: true }, { ruleId: "a", trackable: true },
      { ruleId: "b", trackable: false },
    ];
    expect(countMatches(rules, aircraft)).toEqual([
      { total: 2, trackable: 2 },
      { total: 1, trackable: 0 },
    ]);
  });

  it("returns zero/zero when nothing matches", () => {
    expect(countMatches([{ id: "a", name: "A" }], [{ ruleId: null, trackable: true }]))
      .toEqual([{ total: 0, trackable: 0 }]);
  });

  it("trackable never exceeds total (a.trackable is checked strictly === true, null/false both count against it)", () => {
    const rules = [{ id: "a", name: "A" }];
    const aircraft = [{ ruleId: "a", trackable: null }, { ruleId: "a", trackable: false }, { ruleId: "a", trackable: true }];
    expect(countMatches(rules, aircraft)).toEqual([{ total: 3, trackable: 1 }]);
  });
});

// I-1: state.policy is ALWAYS a fully-formed Ruleset -- mergeState (src/
// dashboard/state.ts) collapses a not-yet-polled or failed/timed-out
// getPolicy leg to DEFAULT_RULESET so the panel never shows "no rules". That
// collapse is indistinguishable, on the ruleset alone, from "the operator's
// real saved ruleset happens to equal the defaults". state.policyFresh is
// what tells the two apart, and seedPolicy/seedPolicyOnce must gate on it:
// without this gate, an operator's saved ruleset silently reverts to the
// shipped defaults the instant a single poll (COLLECT_CALL_TIMEOUT_MS, 4s --
// not exotic on this rig's 2.4GHz band) times out on reload/restart, and the
// very next debounced edit POSTs that reverted ruleset right back to disk.
describe("seedPolicy (I-1)", () => {
  const realRuleset = {
    version: 1,
    rules: [{ id: "east", name: "East flow", enabled: true, canPreempt: false, conditions: [] }],
  };

  it("a failed/absent policy leg (fresh:false) does NOT seed policyLocal", () => {
    seedPolicy(realRuleset, false);
    expect(policyLocal.rules).toEqual([]);
  });

  it("a later successful leg (fresh:true) DOES seed policyLocal", () => {
    seedPolicy(realRuleset, true);
    expect(policyLocal.rules.map((r: { id: string }) => r.id)).toEqual(["east"]);
  });

  it("seeding is one-shot: a further fresh call after the first successful seed is a no-op", () => {
    // Still seeded from the previous test's real ruleset -- a different
    // fresh ruleset here must NOT be adopted (would silently discard an
    // in-progress edit on a later SSE tick).
    seedPolicy({ version: 1, rules: [{ id: "other", name: "Other", enabled: true, canPreempt: false, conditions: [] }] }, true);
    expect(policyLocal.rules.map((r: { id: string }) => r.id)).toEqual(["east"]);
  });
});
