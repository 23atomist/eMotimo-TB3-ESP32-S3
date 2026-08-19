import { describe, it, expect } from "vitest";
import { fitCalibration, DEFAULT_SIGHTING_SIGMA_DEG, type FitSighting } from "../src/geo/calibration-fit.js";
import type { Vec3 } from "../src/geo/vec3.js";

const d2r = (d: number) => (d * Math.PI) / 180;
const enu = (azDeg: number, elDeg: number): Vec3 => [
  Math.cos(d2r(elDeg)) * Math.sin(d2r(azDeg)),
  Math.cos(d2r(elDeg)) * Math.cos(d2r(azDeg)),
  Math.sin(d2r(elDeg)),
];

// The operator's REAL sightings, 2026-07-30. Good data: tilt spread 20.3deg
// against elevation spread 19.3deg, and a consistent ~-4.4deg tilt-vs-
// elevation offset in both, which is exactly what one fixed camera boresight
// looks like.
const REAL: FitSighting[] = [
  { panDeg: -69.61, tiltDeg: 4.99,  enuUnit: enu(44.61, 9.87), sigmaDeg: DEFAULT_SIGHTING_SIGMA_DEG },
  { panDeg: -23.83, tiltDeg: 25.28, enuUnit: enu(1.11, 29.15), sigmaDeg: DEFAULT_SIGHTING_SIGMA_DEG },
];
// The rig's real gravity-derived base: 3.87deg off level, leaning north.
const REAL_DBASE: Vec3 = [-0.0094, 0.0668, -0.9977];
const LEVEL: Vec3 = [0, 0, -1];

describe("gravity fit vs base lean (field bug 2026-07-30)", () => {
  it("reports base lean so the operator can act on the dominant error term", () => {
    expect(fitCalibration(LEVEL, REAL, -1).baseLeanDeg).toBeLessThan(0.01);
    expect(fitCalibration(REAL_DBASE, REAL, -1).baseLeanDeg).toBeCloseTo(3.87, 1);
    expect(fitCalibration([0, 0.0349, -0.9994], REAL, -1).baseLeanDeg).toBeCloseTo(2, 1);
  });

  it("does NOT throw on the real off-level base — it fits and stays finite", () => {
    // Previously: throw "no real c_head (|c0|>1) — degenerate sightings",
    // which blamed the sightings and sent the operator off to re-sight.
    const f = fitCalibration(REAL_DBASE, REAL, -1);
    expect(Number.isFinite(f.rmsDeg)).toBe(true);
    expect(f.usedCount).toBe(2);
  });

  // The core lesson of 2026-08-16, on real data: TWO sightings cannot identify
  // the camera boresight even with 20.3deg of tilt spread, so the fit must
  // decline it rather than invent one. The rig's genuine ~4.4deg boresight
  // then shows up honestly as residual instead of being absorbed into a
  // confident, wrong cHead.
  it("declines the camera offset from two sightings and leaves the boresight in the residual", () => {
    const f = fitCalibration(REAL_DBASE, REAL, -1);
    expect(f.stage).toBe("heading-only");
    expect(f.fallbackReason).toBe("under-determined");
    expect(f.cHead).toEqual([0, 1, 0]);
    expect(f.tiltSpreadDeg).toBeCloseTo(20.3, 0);
    expect(f.rmsDeg).toBeGreaterThan(3);   // the unmodelled boresight
    expect(f.rmsDeg).toBeLessThan(15);     // but a PLAUSIBLE one, not bad data
  });

  it("the returned boresight is always a unit vector", () => {
    for (const dBase of [LEVEL, REAL_DBASE]) {
      const { cHead } = fitCalibration(dBase, REAL, -1);
      expect(Math.hypot(cHead[0], cHead[1], cHead[2])).toBeCloseTo(1, 9);
    }
  });

  it("the wrong pan handedness is still caught, by a large residual", () => {
    // geoPanSign=+1 on a rig whose pan axis is inverted: the data cannot be
    // reconciled, and that must remain loudly visible rather than solving.
    // This is the same mismatch that silently produces ~48deg residuals when
    // a CalibrationStore is built without its geoPanSign.
    const f = fitCalibration(LEVEL, REAL, 1);
    expect(f.rmsDeg).toBeGreaterThan(30);
  });
});
