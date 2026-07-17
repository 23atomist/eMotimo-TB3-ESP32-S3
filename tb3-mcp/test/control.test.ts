import { describe, it, expect } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import {
  wrapDeg180, boresightEnu, targetAimAt, controlRate, limitGuard, rateToDeflection,
  decelMs, limitHorizonMs,
} from "../src/track/control.js";
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

// The old fixed lookahead: 3 ticks x 100ms, same for both axes.
const H300 = { panMs: 300, tiltMs: 300 };

describe("limitGuard", () => {
  it("applies its horizon per axis, not one scalar to both", () => {
    // Symmetric setup: pan sits 1deg under panMax, tilt sits 1deg over tiltMin,
    // both closing at 20 deg/s. So each axis breaches exactly when its OWN
    // horizon exceeds 50ms, and nothing but the horizon differs between these
    // two calls. Swapping the horizons must swap which axis blocks -- a single
    // scalar horizon could not produce both of these results.
    const long = 700, short = 10;
    const a = limitGuard({ panDps: 20, tiltDps: -20 }, 179, -89, LIMITS, { panMs: long, tiltMs: short });
    expect(a.panBlocked).toBe(true);
    expect(a.out.panDps).toBe(0);
    expect(a.tiltBlocked).toBe(false);
    expect(a.out.tiltDps).toBe(-20);

    const b = limitGuard({ panDps: 20, tiltDps: -20 }, 179, -89, LIMITS, { panMs: short, tiltMs: long });
    expect(b.panBlocked).toBe(false);
    expect(b.out.panDps).toBe(20);
    expect(b.tiltBlocked).toBe(true);
    expect(b.out.tiltDps).toBe(0);
  });

  it("passes a rate that stays in range", () => {
    const g = limitGuard({ panDps: 5, tiltDps: 0 }, 0, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(5);
    expect(g.panBlocked).toBe(false);
  });

  it("zeroes an axis whose predicted position would breach its limit", () => {
    // At pan 179 moving +20 deg/s, in 300ms we reach ~185 > panMax 180.
    const g = limitGuard({ panDps: 20, tiltDps: 0 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(0);
    expect(g.panBlocked).toBe(true);
  });

  it("blocks per-axis: pan held, tilt still tracking", () => {
    const g = limitGuard({ panDps: 20, tiltDps: 3 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(0);
    expect(g.out.tiltDps).toBe(3);
    expect(g.tiltBlocked).toBe(false);
  });

  it("allows moving away from a limit it is already at", () => {
    const g = limitGuard({ panDps: -20, tiltDps: 0 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(-20);
    expect(g.panBlocked).toBe(false);
  });

  it("guards the tilt floor (below-horizon)", () => {
    const g = limitGuard({ panDps: 0, tiltDps: -20 }, 0, -89, LIMITS, H300);
    expect(g.out.tiltDps).toBe(0);
    expect(g.tiltBlocked).toBe(true);
  });

  // The bug this whole horizon rework exists for. The rig has no endstops, so
  // a soft limit is the only thing between the servo and the hardware.
  it("REGRESSION: a fixed 300ms horizon is too short to stop the real rig before a limit", () => {
    // Real-hardware budget at the 19 deg/s plateau, from pan 174 (6 deg of
    // room to panMax 180):
    //   telemetry up to 200ms stale (the rig pushes at 5Hz, src/tb3_web.cpp)  +3.8
    //   100ms until the next tick re-evaluates                                +1.9
    //   ~450ms decel ramp, averaging ~9.5 deg/s                               +4.3
    // => the rig ends near 184, about 4 deg PAST the soft limit, and there are
    // no endstops behind it.
    //
    // The old fixed 3-tick horizon predicts only 174 + 19*0.3 = 179.7, calls
    // that safe and commands the rate anyway. The honest horizon predicts
    // 174 + 19*0.75 = 188.25 and stops the axis. Sim never caught this: the
    // mock pushes telemetry at 20Hz and stops dead, so both terms it misses
    // are exactly the terms that hurt on hardware.
    const rigPan = 174, rate = 19;
    const honest = { panMs: limitHorizonMs(rate, 200, 100, 19), tiltMs: 0 };
    expect(honest.panMs).toBe(750);

    expect(limitGuard({ panDps: rate, tiltDps: 0 }, rigPan, 0, LIMITS, H300).panBlocked).toBe(false);
    expect(limitGuard({ panDps: rate, tiltDps: 0 }, rigPan, 0, LIMITS, honest).panBlocked).toBe(true);
  });

  it("the dynamic horizon costs almost nothing at low rate", () => {
    // The reason this is computed instead of a bigger constant: at 1 deg/s the
    // rig stops within one 50ms firmware cycle, so a horizon sized for the
    // saturated worst case (750ms) would surrender travel it never needed.
    expect(limitHorizonMs(1, 200, 100, 19)).toBe(350);
    // ...and it never blocks a slow creep that is genuinely safe.
    expect(limitGuard({ panDps: 1, tiltDps: 0 }, 179, 0, LIMITS,
      { panMs: limitHorizonMs(1, 200, 100, 19), tiltMs: 0 }).panBlocked).toBe(false);
  });
});

describe("decelMs (firmware ramp-down model)", () => {
  it("matches the firmware's accumulator ramp from the measured plateau", () => {
    // updateMotorVelocities2 sheds at most (65535/20) of accumulator per 50ms
    // cycle; full scale (~28092) is the 19 deg/s plateau => ~2.216 deg/s per
    // cycle => ceil(19/2.216) = 9 cycles = 450ms. This is the number the limit
    // horizon and the reacquire gate both rest on.
    expect(decelMs(19, 19)).toBe(450);
  });

  it("scales with the commanded rate and bottoms out at one cycle", () => {
    expect(decelMs(10, 19)).toBe(250);
    expect(decelMs(5, 19)).toBe(150);
    expect(decelMs(0.5, 19)).toBe(50);   // still one whole firmware cycle
    expect(decelMs(0, 19)).toBe(0);
  });

  it("is sign-agnostic and finite-safe", () => {
    expect(decelMs(-19, 19)).toBe(decelMs(19, 19));
    expect(decelMs(NaN, 19)).toBe(0);
    expect(decelMs(19, 0)).toBe(0);
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
