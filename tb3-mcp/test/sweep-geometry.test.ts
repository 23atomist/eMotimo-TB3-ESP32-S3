import { describe, it, expect } from "vitest";
import { sweepPositionsFor, MIN_SWEEP_SPAN_DEG } from "../src/imu-tools.js";

// FIELD 2026-07-31. The sweep was seven hardcoded ABSOLUTE angles
// (pan -102/-65/-140, tilt -25..25). They encode a pan/tilt origin, and the
// moment the rig is re-homed or the limits re-taught they mean nothing:
// the operator moved the IMU, re-homed, and got "7 of 7 postures are outside
// the current travel limits (pan -1.8..177.3, tilt 4.4..52.2)".
//
// The geometry the solve needs is RELATIVE -- spread across both axes -- so
// derive it from whatever travel the rig actually has.
const REAL = { panMin: -1.8, panMax: 177.3, tiltMin: 4.4, tiltMax: 52.2 };

describe("sweepPositionsFor (field bug 2026-07-31)", () => {
  it("fits entirely inside the operator's real envelope", () => {
    const ps = sweepPositionsFor(REAL);
    expect(ps.length).toBeGreaterThanOrEqual(4); // solveImuMounting needs >=4
    for (const p of ps) {
      expect(p.panDeg).toBeGreaterThanOrEqual(REAL.panMin);
      expect(p.panDeg).toBeLessThanOrEqual(REAL.panMax);
      expect(p.tiltDeg).toBeGreaterThanOrEqual(REAL.tiltMin);
      expect(p.tiltDeg).toBeLessThanOrEqual(REAL.tiltMax);
    }
  });

  it("never commands the exact limit edge", () => {
    for (const p of sweepPositionsFor(REAL)) {
      expect(p.panDeg).toBeGreaterThan(REAL.panMin);
      expect(p.panDeg).toBeLessThan(REAL.panMax);
      expect(p.tiltDeg).toBeGreaterThan(REAL.tiltMin);
      expect(p.tiltDeg).toBeLessThan(REAL.tiltMax);
    }
  });

  it("spans BOTH axes -- clustering leaves R_s under-constrained", () => {
    const ps = sweepPositionsFor(REAL);
    const pans = ps.map((p) => p.panDeg), tilts = ps.map((p) => p.tiltDeg);
    expect(Math.max(...pans) - Math.min(...pans)).toBeGreaterThan(MIN_SWEEP_SPAN_DEG);
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeGreaterThan(MIN_SWEEP_SPAN_DEG);
  });

  it("produces postures that are not collinear in pan/tilt", () => {
    const ps = sweepPositionsFor(REAL);
    const distinctPans = new Set(ps.map((p) => p.panDeg.toFixed(2))).size;
    const distinctTilts = new Set(ps.map((p) => p.tiltDeg.toFixed(2))).size;
    expect(distinctPans).toBeGreaterThanOrEqual(3);
    expect(distinctTilts).toBeGreaterThanOrEqual(3);
  });

  it("works for the OLD envelope too, so this is not a one-rig fix", () => {
    const ps = sweepPositionsFor({ panMin: -106.7, panMax: 20.6, tiltMin: -9.7, tiltMax: 42.4 });
    for (const p of ps) {
      expect(p.panDeg).toBeGreaterThan(-106.7);
      expect(p.tiltDeg).toBeGreaterThan(-9.7);
    }
  });

  it("refuses an envelope too small to condition the solve, rather than guessing", () => {
    expect(() => sweepPositionsFor({ panMin: 0, panMax: 3, tiltMin: 0, tiltMax: 40 })).toThrow(/pan/i);
    expect(() => sweepPositionsFor({ panMin: 0, panMax: 90, tiltMin: 10, tiltMax: 13 })).toThrow(/tilt/i);
  });
});
