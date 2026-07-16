import { describe, it, expect } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { wrapDeg180, boresightEnu, targetAimAt, controlRate, limitGuard, rateToDeflection } from "../src/track/control.js";
import { emptyEstimator, withFix } from "../src/track/estimator.js";

// Identity R means the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. That makes every expectation below hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
const LIMITS = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };

describe("wrapDeg180", () => {
  it("leaves in-range angles alone", () => {
    expect(wrapDeg180(0)).toBe(0);
    expect(wrapDeg180(179)).toBe(179);
    expect(wrapDeg180(-179)).toBe(-179);
  });
  it("wraps the short way across the seam", () => {
    expect(wrapDeg180(358)).toBeCloseTo(-2, 9);
    expect(wrapDeg180(-358)).toBeCloseTo(2, 9);
    expect(wrapDeg180(540)).toBeCloseTo(180, 9);
  });
});

describe("boresightEnu", () => {
  it("under identity R, pan 0/tilt 0 points due North", () => {
    const u = boresightEnu(I, 0, 0);
    expect(u[0]).toBeCloseTo(0, 9);
    expect(u[1]).toBeCloseTo(1, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
  it("under identity R, pan 90 points due East", () => {
    const u = boresightEnu(I, 90, 0);
    expect(u[0]).toBeCloseTo(1, 9);
    expect(u[1]).toBeCloseTo(0, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
});

describe("targetAimAt", () => {
  it("returns null with no fix", () => {
    expect(targetAimAt(emptyEstimator(), I, 1000)).toBeNull();
  });

  it("aims North at a stationary target due north, with zero rate", () => {
    // 10km north, level with the rig.
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 10 / 111.32, lon: 10, height: 0 }, 1000, [0, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.panDeg).toBeCloseTo(0, 3);
    expect(aim.ratePanDps).toBeCloseTo(0, 6);
    expect(aim.rateTiltDps).toBeCloseTo(0, 6);
    expect(aim.rangeM).toBeGreaterThan(9000);
  });

  it("feedforward matches the analytic rate for a crossing target", () => {
    // 1000m due north, flying East at 100 m/s, level. At the crossing point the
    // line of sight is 1000m and fully perpendicular to velocity, so the
    // angular rate is v/r = 100/1000 = 0.1 rad/s = 5.7296 deg/s, increasing
    // azimuth (turning from North toward East).
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 1 / 111.32, lon: 10, height: 0 }, 1000, [100, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.ratePanDps).toBeCloseTo((100 / 1000) * (180 / Math.PI), 1);
  });

  it("returns null when the target is at essentially the rig location", () => {
    // Target at the same location as the rig; ENU position is ~zero, below MIN_RANGE_M.
    const s = withFix(emptyEstimator(), RIG, RIG, 1000, [0, 0, 0]);
    expect(targetAimAt(s, I, 1000)).toBeNull();
  });
});

describe("controlRate", () => {
  const aim = { panDeg: 10, tiltDeg: 5, ratePanDps: 2, rateTiltDps: -1, enuUnit: [0, 1, 0] as const, rangeM: 1000 };

  it("with zero error the command is pure feedforward", () => {
    const out = controlRate(aim, 10, 5, 1.0, 20);
    expect(out.panDps).toBeCloseTo(2, 9);
    expect(out.tiltDps).toBeCloseTo(-1, 9);
  });

  it("with a static target the command is pure proportional", () => {
    const still = { ...aim, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(still, 8, 5, 1.5, 20);
    expect(out.panDps).toBeCloseTo(1.5 * 2, 9);  // Kp * 2 deg of error
    expect(out.tiltDps).toBeCloseTo(0, 9);
  });

  it("takes the short way around the pan seam", () => {
    // Target at -179, rig at 179 => error is +2, NOT -358.
    const seam = { ...aim, panDeg: -179, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(seam, 179, 5, 1.0, 20);
    expect(out.panDps).toBeCloseTo(2, 9);
  });

  it("clamps to maxJogDps", () => {
    const far = { ...aim, panDeg: 170, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(far, 0, 5, 1.0, 20);
    expect(out.panDps).toBe(20);
  });

  it("clamps negatively too", () => {
    const far = { ...aim, panDeg: -170, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(far, 0, 5, 1.0, 20);
    expect(out.panDps).toBe(-20);
  });
});

describe("limitGuard", () => {
  it("passes a rate that stays in range", () => {
    const g = limitGuard({ panDps: 5, tiltDps: 0 }, 0, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(5);
    expect(g.panBlocked).toBe(false);
  });

  it("zeroes an axis whose predicted position would breach its limit", () => {
    // At pan 179 moving +20 deg/s, in 300ms we reach ~185 > panMax 180.
    const g = limitGuard({ panDps: 20, tiltDps: 0 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(0);
    expect(g.panBlocked).toBe(true);
  });

  it("blocks per-axis: pan held, tilt still tracking", () => {
    const g = limitGuard({ panDps: 20, tiltDps: 3 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(0);
    expect(g.out.tiltDps).toBe(3);
    expect(g.tiltBlocked).toBe(false);
  });

  it("allows moving away from a limit it is already at", () => {
    const g = limitGuard({ panDps: -20, tiltDps: 0 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(-20);
    expect(g.panBlocked).toBe(false);
  });

  it("guards the tilt floor (below-horizon)", () => {
    const g = limitGuard({ panDps: 0, tiltDps: -20 }, 0, -89, LIMITS, 300);
    expect(g.out.tiltDps).toBe(0);
    expect(g.tiltBlocked).toBe(true);
  });
});

describe("rateToDeflection (inverts the firmware's cubic jog curve)", () => {
  const MAX = 19;

  it("zero rate is zero deflection", () => {
    expect(rateToDeflection(0, MAX)).toBe(0);
  });

  it("full rate is full deflection", () => {
    expect(rateToDeflection(MAX, MAX)).toBe(100);
    expect(rateToDeflection(-MAX, MAX)).toBe(-100);
  });

  it("saturates rather than exceeding full deflection", () => {
    expect(rateToDeflection(MAX * 10, MAX)).toBe(100);
    expect(rateToDeflection(-MAX * 10, MAX)).toBe(-100);
  });

  it("round-trips through the firmware's own curve", () => {
    // The firmware: rate = MAX * ((|x|-5)/95)^3. Feed a rate in, get a
    // deflection, push it back through the firmware curve, expect the rate.
    const firmwareRate = (x: number) => {
      if (Math.abs(x) < 6) return 0;
      const db = Math.abs(x) - 5;
      return Math.sign(x) * MAX * Math.pow(db / 95, 3);
    };
    for (const r of [1, 2.5, 5, 10, 15, 19]) {
      const x = rateToDeflection(r, MAX);
      expect(firmwareRate(x)).toBeCloseTo(r, 0);   // integer x quantises it
    }
  });

  it("is emphatically NOT linear — half rate needs far more than half deflection", () => {
    // Linear would say 50. The cubic needs ~80: (75/95)^3 = 0.49.
    const x = rateToDeflection(MAX / 2, MAX);
    expect(x).toBeGreaterThan(70);
    expect(x).toBeLessThan(90);
  });

  it("matches the hardware-measured points", () => {
    // Measured: x=50 -> 0.116 of full rate; x=75 -> 0.423 of full rate.
    expect(rateToDeflection(MAX * 0.116, MAX)).toBeCloseTo(50, -0.5);
    expect(rateToDeflection(MAX * 0.423, MAX)).toBeCloseTo(75, -0.5);
  });
});
