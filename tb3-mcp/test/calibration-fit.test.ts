import { describe, it, expect } from "vitest";
import { fitCalibration, FitSighting, DEFAULT_SIGHTING_SIGMA_DEG } from "../src/geo/calibration-fit.js";
import { boresightToEnu, rotAlign } from "../src/geo/imu-orientation.js";
import { Vec3, Mat3, normalize, rotZ, matMul, deg2rad, rad2deg, angleBetweenDeg } from "../src/geo/vec3.js";
import { enuDirection } from "../src/geo/wgs84.js";

const GP = -1;
// A base leaning ~1.2° north, matching the real rig.
const D_BASE: Vec3 = normalize([0.0214, -0.0010, -0.9998]);

function cHeadOf(sideDeg: number, upDeg: number): Vec3 {
  const a = deg2rad(sideDeg), e = deg2rad(upDeg);
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

// Build a synthetic sighting: given truth (R, cHead) and a posture, the ENU
// direction the camera actually looks at IS the truth direction.
function synth(R: Mat3, c: Vec3, panDeg: number, tiltDeg: number, sigmaDeg = 0.5): FitSighting {
  return { panDeg, tiltDeg, enuUnit: normalize(boresightToEnu(R, c, GP, panDeg, tiltDeg)), sigmaDeg };
}

// The recovered heading, as an angle (not just an R matrix or an rms), so a
// sign error in the seed can be pinned directly instead of hiding behind an
// aggregate residual metric.
function recoveredHeadingDeg(R: Mat3, R0: Mat3): number {
  // R = Rz(h)·R0  =>  Rz(h) = R·R0ᵀ. Recover h from that rotation's action on
  // the mount-frame "north" axis [0,1,0] (see predict()/seedHeading()'s own
  // az(x,y) = atan2(x,y) convention).
  const R0T: Mat3 = [
    [R0[0][0], R0[1][0], R0[2][0]],
    [R0[0][1], R0[1][1], R0[2][1]],
    [R0[0][2], R0[1][2], R0[2][2]],
  ];
  const rz = matMul(R, R0T);
  const v = [rz[0][1], rz[1][1], rz[2][1]]; // Rz(h)·[0,1,0]
  // az(Rz(h)·[0,1,0]) = az([0,1,0]) − h = −h (same az(x,y)=atan2(x,y)
  // convention used throughout this module), so negate to recover h itself.
  return -rad2deg(Math.atan2(v[0], v[1]));
}

describe("fitCalibration", () => {
  it("recovers a known heading and camera offset from well-spread sightings", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
    expect(fit.rmsDeg).toBeLessThan(0.1);
    expect(fit.usedCount).toBe(6);
    // Pin the recovered heading value directly, not just rms: a seed-sign
    // error can still converge to the right BASIN at h=37° (2*37=74°, well
    // inside Gauss-Newton's ~90° capture radius) while being wrong in
    // general. See the heading-sweep describe block below for the case that
    // actually catches it.
    expect(recoveredHeadingDeg(fit.R, R0)).toBeCloseTo(37, 1);
    // A well-conditioned 6-sighting fit (0.5° per-sighting noise) should
    // report a small, confident heading uncertainty — well under the 15°
    // physical off-axis bound and in the same ballpark as the input noise.
    expect(fit.headingSigmaDeg).toBeLessThan(2.5);
  });
});

describe("fitCalibration heading sweep", () => {
  // seedHeading must reproduce the TRUE heading, not its negation. With this
  // repo's rotZ convention, az(Rz(h)·v) = az(v) - h, so recovering h from the
  // model/truth azimuth disagreement requires h = azModel - azTruth, not
  // azTruth - azModel. Gauss-Newton's basin is only ~±90° wide, so a
  // negated seed (which lands at -h_true, i.e. 2*h_true away from the
  // answer) only happens to reconverge when |h_true| is small — every
  // existing test before this one used h=37°, which is why the bug survived.
  // Sweeping past 45° is what actually exercises the seed.
  it.each([90, -90, 135, 180])("recovers heading %d° from well-spread sightings", (hDeg) => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(hDeg)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));

    const fit = fitCalibration(D_BASE, s, GP);

    const recovered = recoveredHeadingDeg(fit.R, R0);
    const diff = Math.abs(((recovered - hDeg + 180) % 360 + 360) % 360 - 180);
    expect(diff).toBeLessThan(1);
    expect(fit.rmsDeg).toBeLessThan(0.1);
  });
});

describe("fitCalibration conditioning gate", () => {
  it("refuses the camera offset when two sightings barely span any tilt", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [synth(truthR, truthC, 24, 10), synth(truthR, truthC, -23, 18)];

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
    expect(fit.cHeadSigmaDeg).toBeNull();
  });

  it("never returns a camera offset beyond the physical bound", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    // A genuinely absurd camera mounting; the physical guard must reject it
    // even though the data supports it perfectly.
    const truthC = cHeadOf(43, 4);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.2));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
  });
});

describe("fitCalibration residual sanity gate", () => {
  // The third guard (RESIDUAL_RMS_SIGMA_MULTIPLE / RESIDUAL_RMS_FLOOR_DEG in
  // the implementation) exists because covariance is local curvature only:
  // it can be small and confident at a converged point that still does not
  // fit its own data. This scenario is built to isolate it — with the OTHER
  // two guards deliberately disabled below, the fit still converges to
  // "full" with tight covariance (cSigma < 3°) and a small off-axis angle
  // (< 15°), yet a genuinely inconsistent sighting keeps the geometric
  // residual far above what the declared 0.85° sigma would predict. Only
  // the residual guard can catch this, so under DEFAULT options (all three
  // guards live) it must fall back to heading-only.
  it("refuses a converged fit whose residual is inconsistent with its own declared accuracy", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [[40, 5], [-20, 38], [25, 50]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.85));
    // One sighting's recorded pan is off by 11° — enough that no single
    // (heading, cHead) can fit all three sightings well, but not so much
    // that Gauss-Newton fails to converge or the curvature loosens.
    s[1] = { ...s[1], panDeg: s[1].panDeg + 11 };

    // With ALL THREE guards disabled, this converges to "full" — read off
    // what its covariance, off-axis angle and rms actually are.
    const allDisabled = fitCalibration(D_BASE, s, GP, {
      maxCHeadSigmaDeg: 1000,
      maxCHeadOffAxisDeg: 1000,
      maxResidualRmsSigmaMultiple: 1000,
    });
    expect(allDisabled.stage).toBe("full");
    expect(allDisabled.cHeadSigmaDeg).not.toBeNull();
    expect(allDisabled.cHeadSigmaDeg as number).toBeLessThan(3); // passes the DEFAULT statistical guard
    expect(angleBetweenDeg(allDisabled.cHead, [0, 1, 0])).toBeLessThan(15); // passes the DEFAULT physical guard
    // ...yet the fit does not actually explain its own sightings.
    expect(allDisabled.rmsDeg).toBeGreaterThan(4);

    // With ONLY the statistical and physical guards disabled — both of which
    // the numbers above just proved would pass anyway at their DEFAULT
    // thresholds — the residual guard, left at its own default, is the sole
    // remaining thing that can refuse this fit.
    const onlyResidualGuardLive = fitCalibration(D_BASE, s, GP, {
      maxCHeadSigmaDeg: 1000,
      maxCHeadOffAxisDeg: 1000,
    });
    expect(onlyResidualGuardLive.stage).toBe("heading-only");
    expect(onlyResidualGuardLive.cHead).toEqual([0, 1, 0]);

    // And with every guard at its real default, the fit is refused too.
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
  });

  it("does not fire on a legitimately noisy but correct fit", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
      [60, 8], [-40, 25], [15, 45], [-65, 20],
    ];
    // Deterministic, decorrelated per-sighting jitter (golden-angle spread)
    // sized to ~1° — realistic noise at the sightings' own declared sigma,
    // not a systematic modeling error.
    const s: FitSighting[] = postures.map(([p, t], i) => {
      const base = synth(truthR, truthC, p, t, 1.0);
      const ang = i * 137.5;
      const mag = 0.017; // radians, ~1°
      const jitter: Vec3 = [
        mag * Math.cos(deg2rad(ang)),
        mag * Math.sin(deg2rad(ang)),
        mag * Math.cos(deg2rad(ang * 1.7)),
      ];
      const jittered: Vec3 = [
        base.enuUnit[0] + jitter[0], base.enuUnit[1] + jitter[1], base.enuUnit[2] + jitter[2],
      ];
      return { ...base, enuUnit: normalize(jittered) };
    });

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("full");
    expect(fit.rmsDeg).toBeLessThan(2);
    expect(fit.cHeadSigmaDeg).not.toBeNull();
  });
});

describe("fitCalibration outlier rejection", () => {
  it("rejects one gross outlier and recovers the true fit", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));
    // Corrupt one sighting's recorded posture by 15° — an operator who
    // centred the wrong aircraft.
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected[2]).toBe(true);
    expect(fit.rejected.filter(Boolean)).toHaveLength(1);
    expect(fit.usedCount).toBe(5);
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("runs outlier rejection starting at exactly 4 sightings, its minimum", () => {
    // n=4 is also where the 30%-reject-fraction cap (floor(4*0.3)=1) and the
    // "never fewer than 3 accepted" floor (4-3=1) numerically coincide — see
    // the "never touches..." test below for why they can't be pulled apart
    // below this n, and the cap test further down for where they diverge.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(1, -0.5);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected).toEqual([false, false, true, false]);
    expect(fit.usedCount).toBe(3);
  });

  it("never touches any sighting below the 4-sighting outlier-rejection minimum, even a gross one", () => {
    // Below n=4, MIN_SIGHTINGS_FOR_OUTLIERS explicitly skips the whole
    // mechanism — but note the reject-fraction/floor arithmetic
    // (min(floor(n*0.3), n-3)) already independently resolves to ≤0 for
    // every n<4 regardless of that explicit check, so this test documents
    // observed behavior at n=3, not an isolated proof that the >=4 check
    // alone is what is responsible.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [
      synth(truthR, truthC, 40, 5),
      synth(truthR, truthC, -20, 38),
      synth(truthR, truthC, 10, 20),
    ];
    // Even with a grossly corrupted sighting present, fewer than 4 total
    // means nothing is ever rejected.
    s[1] = { ...s[1], panDeg: s[1].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.rejected).toEqual([false, false, false]);
  });

  it("caps rejection at 30% even when more sightings are bad enough to reject", () => {
    // 10 clean + 6 corrupted (staggered, geometrically decreasing severity)
    // = 16 total. floor(16*0.3)=4, well short of n-3=13, so the 30%
    // fraction is unambiguously the binding constraint, not the "≥3
    // accepted" floor (see the cap test's sibling below for that case) or
    // masking (each of the worst 4 individually clears its own
    // leave-one-out threshold — see the source comment on the cascade).
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(1, -0.5);
    const goodPostures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50],
      [-5, 30], [60, 8], [-40, 25], [15, 45], [-65, 20],
    ];
    const badPostures: [number, number][] = [[35, 15], [-35, 35], [5, 55], [-15, 5], [45, 42], [-45, 48]];
    const badMagsDeg = [150, 120, 90, 70, 50, 35];
    const s: FitSighting[] = [
      ...goodPostures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5)),
      ...badPostures.map(([p, t], i) => ({
        ...synth(truthR, truthC, p, t, 0.5), panDeg: p + badMagsDeg[i],
      })),
    ];

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected.filter(Boolean)).toHaveLength(4);
    expect(fit.usedCount).toBe(12);
    // The two mildest corrupted sightings (indices 14, 15 — the 50° and 35°
    // errors) survive purely because the cap stopped at 4, not because they
    // were judged acceptable.
    expect(fit.rejected[14]).toBe(false);
    expect(fit.rejected[15]).toBe(false);
    expect(fit.residualsDeg[14]).toBeGreaterThan(15);
    expect(fit.residualsDeg[15]).toBeGreaterThan(15);
    // The 4 worst are exactly the ones rejected.
    expect(fit.rejected.slice(10, 14)).toEqual([true, true, true, true]);
  });
});

describe("fitCalibration against the 2026-08-16 field profile", () => {
  // The exact rig position and the two sightings that produced the 43.4°
  // cHead in ~/.tb3-mcp/calibration.json. This must never solve to a
  // sideways camera again.
  const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 341 };
  const field = [
    { lat: 33.48862875499936, lon: -112.19274762587969, height: 2590.9658112, panDeg: 23.92202392202392, tiltDeg: 10.22176022176022 },
    { lat: 33.410182683296966, lon: -112.12529990150021, height: 1322.22678912, panDeg: -22.58102258102258, tiltDeg: 18.474768474768474 },
  ];
  const s: FitSighting[] = field.map((f) => ({
    panDeg: f.panDeg, tiltDeg: f.tiltDeg,
    enuUnit: enuDirection(rig, { lat: f.lat, lon: f.lon, height: f.height }).unit,
    sigmaDeg: DEFAULT_SIGHTING_SIGMA_DEG,
  }));

  it("falls back to heading-only instead of a 43° camera offset", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
  });

  it("keeps every sighting within a few degrees", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    for (const r of fit.residualsDeg) expect(r).toBeLessThan(3);
  });

  it("reports the short tilt baseline that caused the problem", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.tiltSpreadDeg).toBeGreaterThan(8);
    expect(fit.tiltSpreadDeg).toBeLessThan(9);
  });
});
