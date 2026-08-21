import { describe, it, expect } from "vitest";
import { Vec3 } from "../src/geo/vec3.js";
import { TrackFloor, DISABLED_FLOOR, aboveFloor, enuElevationDeg } from "../src/track/floor.js";

const floor = (minElevationDeg: number, enabled = true): TrackFloor => ({ enabled, minElevationDeg });

// ENU unit vector at a given elevation (east component zero, so azimuth is
// due north -- the floor gate must be azimuth-independent).
function atElevation(elDeg: number): Vec3 {
  const r = (elDeg * Math.PI) / 180;
  return [0, Math.cos(r), Math.sin(r)];
}

describe("aboveFloor", () => {
  it("admits everything when disabled", () => {
    expect(aboveFloor(-45, DISABLED_FLOOR)).toBe(true);
    expect(aboveFloor(0, { enabled: false, minElevationDeg: 30 })).toBe(true);
  });

  it("admits elevations at or above the floor", () => {
    expect(aboveFloor(10, floor(10))).toBe(true);
    expect(aboveFloor(10.1, floor(10))).toBe(true);
    expect(aboveFloor(89, floor(10))).toBe(true);
  });

  it("refuses elevations below the floor", () => {
    expect(aboveFloor(9.9, floor(10))).toBe(false);
    expect(aboveFloor(0, floor(10))).toBe(false);
    expect(aboveFloor(-5, floor(10))).toBe(false);
  });

  // The whole point of the feature: a target below the horizon is exactly the
  // one aimed into a neighbour's window, so a floor of 0 must still block it.
  it("blocks below-horizon targets at a zero floor", () => {
    expect(aboveFloor(-0.1, floor(0))).toBe(false);
    expect(aboveFloor(0, floor(0))).toBe(true);
  });

  // A NaN elevation must FAIL CLOSED (refuse), never sail through. `>=` is
  // false for NaN, which is the behaviour we want -- asserted so a future
  // refactor to `!(el < min)` (true for NaN) cannot silently invert it.
  it("fails closed on a NaN elevation", () => {
    expect(aboveFloor(NaN, floor(10))).toBe(false);
    expect(aboveFloor(NaN, floor(-90))).toBe(false);
  });
});

describe("enuElevationDeg", () => {
  it("reads elevation off an ENU unit vector", () => {
    expect(enuElevationDeg([0, 1, 0])).toBeCloseTo(0, 6);
    expect(enuElevationDeg([0, 0, 1])).toBeCloseTo(90, 6);
    expect(enuElevationDeg([0, 0, -1])).toBeCloseTo(-90, 6);
    expect(enuElevationDeg(atElevation(30))).toBeCloseTo(30, 6);
    expect(enuElevationDeg(atElevation(-12.5))).toBeCloseTo(-12.5, 6);
  });

  it("is independent of azimuth", () => {
    for (const az of [0, 45, 90, 180, 270, 359]) {
      const a = (az * Math.PI) / 180;
      const el = (20 * Math.PI) / 180;
      const v: Vec3 = [Math.sin(a) * Math.cos(el), Math.cos(a) * Math.cos(el), Math.sin(el)];
      expect(enuElevationDeg(v)).toBeCloseTo(20, 6);
    }
  });

  // Guards the clamp: a unit vector that drifts a hair outside [-1,1] through
  // floating point must not produce NaN out of asin().
  it("clamps a slightly over-unit vertical component", () => {
    expect(enuElevationDeg([0, 0, 1.0000000002])).toBeCloseTo(90, 6);
    expect(enuElevationDeg([0, 0, -1.0000000002])).toBeCloseTo(-90, 6);
  });
});
