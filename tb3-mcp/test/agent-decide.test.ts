import { describe, it, expect } from "vitest";
import { decideAction, failSafeAction, type DecideInput } from "../src/agent/decide.js";

function base(p: Partial<DecideInput>): DecideInput {
  return {
    decision: { action: "keep", reason: "" },
    trackableHexes: new Set(["aaa", "bbb"]),
    currentHex: null, currentHealthy: false,
    msSinceLastSwitch: 999999, minDwellMs: 25000, ...p,
  };
}

describe("decideAction", () => {
  it("tracks a valid new hex when idle", () => {
    expect(decideAction(base({ decision: { action: "track", hex: "aaa", reason: "" } })))
      .toEqual({ kind: "track", hex: "aaa" });
  });
  it("rejects a hallucinated hex → keep", () => {
    expect(decideAction(base({ decision: { action: "track", hex: "zzz", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
  it("keeps when the pick is the current target", () => {
    expect(decideAction(base({ currentHex: "aaa", decision: { action: "track", hex: "aaa", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
  it("blocks switching off a healthy current before min-dwell", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: true, msSinceLastSwitch: 5000,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "keep" });
  });
  it("allows a switch after min-dwell", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: true, msSinceLastSwitch: 30000,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "track", hex: "bbb" });
  });
  it("allows switching away from an UNHEALTHY current immediately", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: false, msSinceLastSwitch: 100,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "track", hex: "bbb" });
  });
  it("stops on an explicit stop when bound; keeps when idle", () => {
    expect(decideAction(base({ currentHex: "aaa", decision: { action: "stop", reason: "" } })))
      .toEqual({ kind: "stop" });
    expect(decideAction(base({ currentHex: null, decision: { action: "stop", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
});

describe("failSafeAction", () => {
  it("keeps when idle or current healthy, stops a lost current", () => {
    expect(failSafeAction(null, false)).toEqual({ kind: "keep" });
    expect(failSafeAction("aaa", true)).toEqual({ kind: "keep" });
    expect(failSafeAction("aaa", false)).toEqual({ kind: "stop" });
  });
});
