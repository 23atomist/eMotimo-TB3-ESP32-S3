import { describe, it, expect } from "vitest";
import {
  emptyEstimator, withFix, velocityOf, estimateAt, lastFixMs, velocityFromSpeedHeading,
} from "../src/track/estimator.js";

const RIG = { lat: 45, lon: 10, height: 0 };

describe("velocityFromSpeedHeading", () => {
  it("heading 0 is due North", () => {
    const v = velocityFromSpeedHeading(100, 0, 0);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[1]).toBeCloseTo(100, 9);
    expect(v[2]).toBeCloseTo(0, 9);
  });

  it("heading 90 is due East, and climb is Up", () => {
    const v = velocityFromSpeedHeading(100, 90, 5);
    expect(v[0]).toBeCloseTo(100, 9);
    expect(v[1]).toBeCloseTo(0, 9);
    expect(v[2]).toBeCloseTo(5, 9);
  });
});

describe("estimator", () => {
  it("returns null before any fix", () => {
    expect(estimateAt(emptyEstimator(), 1000)).toBeNull();
    expect(lastFixMs(emptyEstimator())).toBeNull();
  });

  it("a stated velocity extrapolates linearly in ENU", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [10, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p2 = estimateAt(s, 3000)!;   // +2s at 10 m/s East
    expect(p2[0] - p0[0]).toBeCloseTo(20, 6);
    expect(p2[1] - p0[1]).toBeCloseTo(0, 6);
    expect(p2[2] - p0[2]).toBeCloseTo(0, 6);
  });

  it("holds position when velocity is zero and none can be derived", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    expect(velocityOf(s)).toEqual([0, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p9 = estimateAt(s, 9999)!;
    expect(p9).toEqual(p0);
  });

  it("derives velocity from two successive fixes when none is stated", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    // Second fix 1000m up, 2 seconds later => +500 m/s Up.
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, null);
    const v = velocityOf(s);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(0, 6);
    expect(v[2]).toBeCloseTo(500, 6);
  });

  it("a stated velocity takes precedence over one derivable from fixes", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, [1, 2, 3]);
    expect(velocityOf(s)).toEqual([1, 2, 3]);
  });

  it("withFix does not mutate the state it is given", () => {
    const a = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [1, 0, 0]);
    const before = estimateAt(a, 5000)!;
    withFix(a, RIG, { lat: 46, lon: 11, height: 9000 }, 4000, [9, 9, 9]);
    expect(estimateAt(a, 5000)).toEqual(before);
    expect(lastFixMs(a)).toBe(1000);
  });
});
