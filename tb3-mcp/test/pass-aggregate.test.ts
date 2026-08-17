import { describe, it, expect } from "vitest";
import { PassAggregator, PassSample } from "../src/capture/pass-aggregate.js";

const s = (over: Partial<PassSample> = {}): PassSample => ({
  state: "tracking",
  targetAzimuthDeg: 10, targetElevationDeg: 20, targetRangeM: 10000,
  pointingErrorDeg: 1, panLimited: false, tiltLimited: false,
  altitudeM: 3000,
  ...over,
});

describe("PassAggregator", () => {
  it("tracks the closest range and the highest elevation", () => {
    const a = new PassAggregator();
    a.sample(s({ targetRangeM: 12000, targetElevationDeg: 10 }), 500);
    a.sample(s({ targetRangeM: 5000, targetElevationDeg: 31 }), 500);
    a.sample(s({ targetRangeM: 8000, targetElevationDeg: 22 }), 500);
    const r = a.result();
    expect(r.minRangeM).toBe(5000);
    expect(r.maxElevationDeg).toBe(31);
  });

  it("accumulates azimuth arc across the north wrap", () => {
    const a = new PassAggregator();
    a.sample(s({ targetAzimuthDeg: 350 }), 500);
    a.sample(s({ targetAzimuthDeg: 355 }), 500);
    a.sample(s({ targetAzimuthDeg: 5 }), 500);   // wrapped past north
    a.sample(s({ targetAzimuthDeg: 20 }), 500);
    const r = a.result();
    expect(r.azStartDeg).toBe(350);
    expect(r.azEndDeg).toBe(20);
    expect(r.azArcDeg).toBeCloseTo(30, 6);   // 5 + 10 + 15, never 330
  });

  it("computes mean and max pointing error over samples that have one", () => {
    const a = new PassAggregator();
    a.sample(s({ pointingErrorDeg: 1 }), 500);
    a.sample(s({ pointingErrorDeg: 3 }), 500);
    a.sample(s({ pointingErrorDeg: null }), 500);   // ignored, not counted as 0
    const r = a.result();
    expect(r.meanPointingErrorDeg).toBeCloseTo(2, 6);
    expect(r.maxPointingErrorDeg).toBe(3);
  });

  it("counts time spent waiting and time spent against a limit", () => {
    const a = new PassAggregator();
    a.sample(s({ state: "tracking" }), 500);
    a.sample(s({ state: "waiting" }), 500);
    a.sample(s({ state: "waiting" }), 500);
    a.sample(s({ state: "tracking", tiltLimited: true }), 500);
    const r = a.result();
    expect(r.waitingMs).toBe(1000);
    expect(r.limitHitMs).toBe(500);
  });

  it("returns nulls rather than NaN when nothing was sampled", () => {
    const r = new PassAggregator().result();
    expect(r.minRangeM).toBeNull();
    expect(r.maxElevationDeg).toBeNull();
    expect(r.meanPointingErrorDeg).toBeNull();
    expect(r.azArcDeg).toBeNull();
    expect(r.samples).toBe(0);
  });

  it("keeps the highest altitude seen", () => {
    const a = new PassAggregator();
    a.sample(s({ altitudeM: 2000 }), 500);
    a.sample(s({ altitudeM: 4200 }), 500);
    expect(a.result().maxAltitudeM).toBe(4200);
  });
});
