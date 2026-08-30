import { describe, it, expect } from "vitest";
import { validateRule, newRule, moveRule, countMatches } from "../dashboard/public/policy.js";

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

describe("countMatches", () => {
  it("counts aircraft per rule using the tier the daemon reported", () => {
    const rules = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const aircraft = [{ rule: "A" }, { rule: "A" }, { rule: "B" }, { rule: null }];
    expect(countMatches(rules, aircraft)).toEqual([2, 1]);
  });
  it("returns zeroes when nothing matches", () => {
    expect(countMatches([{ id: "a", name: "A" }], [{ rule: null }])).toEqual([0]);
  });
});
