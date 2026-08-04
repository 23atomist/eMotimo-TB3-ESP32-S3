import { describe, it, expect } from "vitest";
import { ZERO_OFFSET, MAX_OFFSET_DEG, nudgeOffset, applyOffset } from "../src/track/offset.js";

describe("track/offset.ts — pure aim-offset mechanics", () => {
  it("starts at zero", () => {
    expect(ZERO_OFFSET).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("nudgeOffset accumulates a delta on each axis independently", () => {
    let o = ZERO_OFFSET;
    o = nudgeOffset(o, 1, -0.5);
    // toMatchObject, not toEqual: nudgeOffset also reports panClamped/
    // tiltClamped/maxDeg now (see NudgeResult). The values are what matter here.
    expect(o).toMatchObject({ panDeg: 1, tiltDeg: -0.5 });
    o = nudgeOffset(o, 0.5, 0.5);
    expect(o.panDeg).toBeCloseTo(1.5, 9);
    expect(o.tiltDeg).toBeCloseTo(0, 9);
  });

  it("clamps at MAX_OFFSET_DEG — an absurd nudge does not produce an absurd offset", () => {
    const o = nudgeOffset(ZERO_OFFSET, 500, -500);
    expect(o.panDeg).toBe(MAX_OFFSET_DEG);
    expect(o.tiltDeg).toBe(-MAX_OFFSET_DEG);
  });

  it("clamps incrementally too — repeated small nudges cannot walk past the bound", () => {
    let o = ZERO_OFFSET;
    for (let i = 0; i < 100; i++) o = nudgeOffset(o, 1, 0);
    expect(o.panDeg).toBe(MAX_OFFSET_DEG);
  });

  it("REGRESSION: without the clamp, nudgeOffset would accept an absurd offset (documents why MAX_OFFSET_DEG exists)", () => {
    // Same computation nudgeOffset does internally, MINUS the clamp — this
    // is what "a nudge must never command an unbounded slew" is guarding
    // against; the assertion above (clamps at MAX_OFFSET_DEG) is the guard
    // itself, this just makes the counterfactual explicit.
    const unclamped = { panDeg: ZERO_OFFSET.panDeg + 500, tiltDeg: ZERO_OFFSET.tiltDeg - 500 };
    expect(unclamped.panDeg).toBeGreaterThan(MAX_OFFSET_DEG);
    expect(nudgeOffset(ZERO_OFFSET, 500, -500).panDeg).not.toBe(unclamped.panDeg);
  });

  it("MAX_OFFSET_DEG is the pure helper's own bug/typo guard, no longer coupled to trackReacquireDeg", () => {
    // This used to need to stay comfortably under trackReacquireDeg (10°
    // default): tick()'s old reacquire trigger compared the ACTUAL
    // boresight against the TRUE (unshifted) target, so a converged offset
    // read as pointing error of roughly its own magnitude, and anything
    // past trackReacquireDeg self-triggered a reacquire forever. That
    // coupling is gone -- track/session.ts's tick() now measures against
    // the offset-shifted aim point (see its own comment), so a converged
    // trim of any legal size (up to config's maxAimOffsetDeg, default 20°,
    // schema max 45° -- see test/session-aim-offset.test.ts's "runtime
    // tuning" describe block) never self-triggers a reacquire. All that's
    // left to assert here is that this constant is still a sane, positive
    // per-nudge guard, not that it relates to trackReacquireDeg at all.
    expect(MAX_OFFSET_DEG).toBeGreaterThan(0);
  });

  it("applyOffset with ZERO_OFFSET is the identity (strict extension pin)", () => {
    expect(applyOffset(12.3, -4.5, ZERO_OFFSET)).toEqual({ panDeg: 12.3, tiltDeg: -4.5 });
  });

  it("applyOffset shifts both axes by the offset", () => {
    expect(applyOffset(10, 5, { panDeg: 2.3, tiltDeg: -0.5 })).toEqual({ panDeg: 12.3, tiltDeg: 4.5 });
  });
});
