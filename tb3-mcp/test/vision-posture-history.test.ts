import { describe, it, expect } from "vitest";
import { PostureHistory } from "../src/vision/posture-history.js";

describe("PostureHistory", () => {
  it("interpolates between two samples", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(1500)).toEqual({ panDeg: 15, tiltDeg: -6 });
  });

  it("returns an exact sample at an exact timestamp", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(2000)).toEqual({ panDeg: 20, tiltDeg: -8 });
  });

  it("refuses BEFORE the oldest sample rather than guessing", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    expect(h.postureAt(999)).toBeNull();
  });

  it("refuses AFTER the newest sample rather than extrapolating", () => {
    const h = new PostureHistory();
    h.record(1000, 10, -4);
    h.record(2000, 20, -8);
    // The dangerous case: a frame stamped later than any posture we hold.
    // Returning the newest sample here is what silently pairs a frame with
    // the wrong posture.
    expect(h.postureAt(2001)).toBeNull();
  });

  it("refuses on an empty history", () => {
    expect(new PostureHistory().postureAt(1000)).toBeNull();
  });

  it("evicts oldest first at capacity, and refuses what it evicted", () => {
    const h = new PostureHistory(3);
    h.record(1000, 1, 1); h.record(2000, 2, 2);
    h.record(3000, 3, 3); h.record(4000, 4, 4);
    expect(h.postureAt(1000)).toBeNull();
    expect(h.oldestMs()).toBe(2000);
    expect(h.newestMs()).toBe(4000);
  });

  it("interpolates each axis independently (asymmetric, opposite signs)", () => {
    const h = new PostureHistory();
    h.record(0, -30, 12);
    h.record(1000, 10, -8);
    // pan +40 over the window, tilt -20 -- distinct magnitudes AND opposite
    // signs, so an axis swap or a shared-sign bug cannot pass.
    expect(h.postureAt(250)).toEqual({ panDeg: -20, tiltDeg: 7 });
  });

  it("ignores an out-of-order sample rather than corrupting the buffer", () => {
    const h = new PostureHistory();
    h.record(2000, 20, -8);
    h.record(1000, 10, -4);       // late arrival, older timestamp
    expect(h.newestMs()).toBe(2000);
    expect(h.postureAt(2000)).toEqual({ panDeg: 20, tiltDeg: -8 });
  });
});
