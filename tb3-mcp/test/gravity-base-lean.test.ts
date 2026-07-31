import { describe, it, expect } from "vitest";
import { solveCalibrationWithGravity, type GravitySighting } from "../src/geo/imu-orientation.js";
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
const REAL: [GravitySighting, GravitySighting] = [
  { panDeg: -69.61, tiltDeg: 4.99,  elevationDeg: 9.87,  enuUnit: enu(44.61, 9.87) },
  { panDeg: -23.83, tiltDeg: 25.28, elevationDeg: 29.15, enuUnit: enu(1.11, 29.15) },
];
// The rig's real gravity-derived base: 3.87deg off level, leaning north.
const REAL_DBASE: Vec3 = [-0.0094, 0.0668, -0.9977];
const LEVEL: Vec3 = [0, 0, -1];

describe("gravity solve vs base lean (field bug 2026-07-30)", () => {
  it("solves cleanly when the base is level", () => {
    const r = solveCalibrationWithGravity(LEVEL, REAL, -1);
    expect(r.headingResidualDeg).toBeLessThan(0.5);
    expect(r.baseLeanDeg).toBeLessThan(0.01);
    expect(r.infeasibleBy).toBe(0);
  });

  it("does NOT throw on the real off-level base — it returns the nearest fit and says so", () => {
    // Previously: throw "no real c_head (|c0|>1) — degenerate sightings",
    // which blamed the sightings and sent the operator off to re-sight.
    const r = solveCalibrationWithGravity(REAL_DBASE, REAL, -1);
    expect(r.infeasibleBy).toBeGreaterThan(0);          // honest about it
    expect(r.baseLeanDeg).toBeCloseTo(3.87, 1);         // names the real cause
    expect(Number.isFinite(r.headingResidualDeg)).toBe(true);
  });

  it("reports base lean so the operator can act on the dominant error term", () => {
    expect(solveCalibrationWithGravity([0, 0.0349, -0.9994], REAL, -1).baseLeanDeg).toBeCloseTo(2, 1);
  });

  it("the returned boresight is always a unit vector, feasible or not", () => {
    for (const dBase of [LEVEL, REAL_DBASE]) {
      const { cHead } = solveCalibrationWithGravity(dBase, REAL, -1);
      expect(Math.hypot(cHead[0], cHead[1], cHead[2])).toBeCloseTo(1, 9);
    }
  });

  it("the wrong pan handedness is still caught, by a large residual", () => {
    // geoPanSign=+1 on a rig whose pan axis is inverted: the data cannot be
    // reconciled, and that must remain loudly visible rather than solving.
    const r = solveCalibrationWithGravity(LEVEL, REAL, 1);
    expect(r.headingResidualDeg).toBeGreaterThan(30);
  });
});
