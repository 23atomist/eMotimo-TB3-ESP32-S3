import { describe, it, expect } from "vitest";
import { decideAction, type DecideInput } from "../src/agent/decide.js";

const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  decision: { action: "track", hex: "bbbbbb", reason: "" },
  trackableHexes: new Set(["aaaaaa", "bbbbbb"]),
  currentHex: "aaaaaa",
  currentHealthy: true,
  msSinceLastSwitch: 10_000,
  minDwellMs: 25_000,
  candidateCanPreempt: false,
  ...o,
});

describe("hold until the pass ends", () => {
  it("keeps a healthy target however long it has been tracked", () => {
    // The old behaviour switched once msSinceLastSwitch passed minDwellMs.
    // Hold-until-lost means elapsed time is no longer a reason to switch.
    expect(decideAction(base({ msSinceLastSwitch: 10_000 }))).toEqual({ kind: "keep" });
    expect(decideAction(base({ msSinceLastSwitch: 10_000_000 }))).toEqual({ kind: "keep" });
  });

  it("switches as soon as the current target is no longer healthy", () => {
    expect(decideAction(base({ currentHealthy: false })))
      .toEqual({ kind: "track", hex: "bbbbbb" });
  });

  it("switches freely when nothing is being tracked", () => {
    expect(decideAction(base({ currentHex: null })))
      .toEqual({ kind: "track", hex: "bbbbbb" });
  });
});

describe("rule-based preemption", () => {
  it("lets a candidate whose rule may preempt interrupt a healthy pass", () => {
    expect(decideAction(base({ candidateCanPreempt: true })))
      .toEqual({ kind: "track", hex: "bbbbbb" });
  });

  it("does NOT let a non-preempting rule interrupt a healthy pass", () => {
    expect(decideAction(base({ candidateCanPreempt: false }))).toEqual({ kind: "keep" });
  });

  it("preemption still cannot rescue a hallucinated hex", () => {
    expect(decideAction(base({ candidateCanPreempt: true, decision: { action: "track", hex: "zzzzzz", reason: "" } })))
      .toEqual({ kind: "keep" });
  });

  it("a preempting candidate already being tracked is a no-op, not a re-track", () => {
    expect(decideAction(base({ candidateCanPreempt: true, decision: { action: "track", hex: "aaaaaa", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
});

describe("unchanged behaviour", () => {
  it("stop still stops a live target and is a no-op when idle", () => {
    expect(decideAction(base({ decision: { action: "stop", hex: null, reason: "" } })))
      .toEqual({ kind: "stop" });
    expect(decideAction(base({ currentHex: null, decision: { action: "stop", hex: null, reason: "" } })))
      .toEqual({ kind: "keep" });
  });

  it("keep is honoured", () => {
    expect(decideAction(base({ decision: { action: "keep", hex: null, reason: "" } })))
      .toEqual({ kind: "keep" });
  });

  it("rejects a hex that is not trackable", () => {
    expect(decideAction(base({ currentHex: null, decision: { action: "track", hex: "zzzzzz", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
});
