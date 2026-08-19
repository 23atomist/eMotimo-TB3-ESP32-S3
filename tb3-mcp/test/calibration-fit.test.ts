import { describe, it, expect } from "vitest";
import { fitCalibration, FitSighting, DEFAULT_SIGHTING_SIGMA_DEG } from "../src/geo/calibration-fit.js";
import { boresightToEnu, rotAlign } from "../src/geo/imu-orientation.js";
import { Vec3, Mat3, normalize, rotZ, matMul, deg2rad, rad2deg, angleBetweenDeg } from "../src/geo/vec3.js";
import { enuDirection } from "../src/geo/wgs84.js";
import { solveImuMounting } from "../src/geo/imu-orientation.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    expect(fit.fallbackReason).toBeNull();
    // A well-conditioned 6-sighting fit (0.5° per-sighting noise) should
    // report a small, confident heading uncertainty — TWO-sided: a
    // one-sided upper bound alone does not catch a constant-0 mutant (the
    // Critical this module exists to prevent was a CONFIDENT sigma on a
    // wildly wrong fit, i.e. too small, not too large).
    expect(fit.headingSigmaDeg).toBeGreaterThan(1);
    expect(fit.headingSigmaDeg).toBeLessThan(2.5);
  });

  it("headingSigmaDeg matches an independently Monte-Carlo-derived heading uncertainty", () => {
    // The band and worse-conditioned-comparison checks above both catch a
    // constant mutant, but neither reliably catches a mutant that reads the
    // WRONG covariance diagonal element (e.g. cov[1][1] instead of
    // cov[0][0]) — a prior version of this test instead asserted
    // `headingSigmaDeg !== cHeadSigmaDeg`, which only worked because
    // cov[1][1] >= cov[2][2] happened to hold for this fixture; a future
    // fixture where that flips would let such a mutant survive silently.
    // This replaces that incidental check with a STRUCTURAL one: derive the
    // heading uncertainty independently, via Monte Carlo over many
    // perturbed realizations of the same sightings, and compare against
    // fit.headingSigmaDeg from a single clean fit. This does not read or
    // duplicate any covariance internals — the recovered heading VALUE from
    // each perturbed refit is entirely determined by where Gauss-Newton's
    // optimizer converges, never by which diagonal fit.headingSigmaDeg
    // happens to report, so it is blind to which covariance element the
    // implementation reads.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    const fit = fitCalibration(D_BASE, s, GP);

    // Deterministic PRNG (mulberry32) + Box-Muller, seeded fixed — this
    // test is a bit-for-bit-reproducible replay, not a source of flakiness.
    function mulberry32(seed: number): () => number {
      return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function gaussian(rng: () => number): number {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    // Any orthonormal basis of the plane perpendicular to a unit vector, for
    // generating an isotropic small perturbation — need not match the
    // production tangentBasis(), just needs to span the tangent plane.
    function tangentBasis(u: Vec3): [Vec3, Vec3] {
      const seed: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const e1 = normalize([
        u[1] * seed[2] - u[2] * seed[1],
        u[2] * seed[0] - u[0] * seed[2],
        u[0] * seed[1] - u[1] * seed[0],
      ] as Vec3);
      const e2: Vec3 = [
        u[1] * e1[2] - u[2] * e1[1],
        u[2] * e1[0] - u[0] * e1[2],
        u[0] * e1[1] - u[1] * e1[0],
      ];
      return [e1, e2];
    }

    const N = 2000;
    const rng = mulberry32(42);
    const recoveredHeadings: number[] = [];
    for (let trial = 0; trial < N; trial++) {
      const perturbed: FitSighting[] = s.map((sight) => {
        const [e1, e2] = tangentBasis(sight.enuUnit);
        const sigRad = deg2rad(sight.sigmaDeg);
        const d1 = gaussian(rng) * sigRad, d2 = gaussian(rng) * sigRad;
        const v: Vec3 = [
          sight.enuUnit[0] + d1 * e1[0] + d2 * e2[0],
          sight.enuUnit[1] + d1 * e1[1] + d2 * e2[1],
          sight.enuUnit[2] + d1 * e1[2] + d2 * e2[2],
        ];
        return { ...sight, enuUnit: normalize(v) };
      });
      const trialFit = fitCalibration(D_BASE, perturbed, GP);
      recoveredHeadings.push(recoveredHeadingDeg(trialFit.R, R0));
    }
    const mean = recoveredHeadings.reduce((a, b) => a + b, 0) / N;
    const variance = recoveredHeadings.reduce((a, b) => a + (b - mean) ** 2, 0) / (N - 1);
    const empiricalStdDeg = Math.sqrt(variance);

    // Measured at N=2000 with this fixture and seed: analytic 1.7787°,
    // empirical 1.7372° (2.4% apart). The wrong-covariance-element mutant
    // reports 1.5957° — 8.1% from the SAME empirical value, i.e. ~3.4x this
    // test's tolerance away — while the analytic/empirical gap here is
    // consistent with Monte Carlo sampling noise at this N (~2.2% standard
    // error), not a systematic mismatch.
    expect(Math.abs(fit.headingSigmaDeg - empiricalStdDeg)).toBeLessThan(0.08);
  });

  it("reports a measurably larger headingSigmaDeg for a worse-conditioned fit", () => {
    // Same geometry, same truth; only the declared per-sighting noise
    // changes. headingSigmaDeg must track that — a constant mutant would
    // not move at all. (A wrong-covariance-element mutant is NOT reliably
    // caught by this comparison alone — see the exact-inequality check in
    // the previous test for why, and for what does catch it.)
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const better = fitCalibration(D_BASE, postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5)), GP);
    const worse = fitCalibration(D_BASE, postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.8)), GP);

    expect(better.stage).toBe("full");
    expect(worse.stage).toBe("full");
    expect(worse.headingSigmaDeg).toBeGreaterThan(better.headingSigmaDeg + 0.5);
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
    // This is the statistical guard (poor tilt spread leaves cHead's
    // covariance too loose), so a consumer told WHY should hear "add
    // sightings with more spread" — not "delete a bad one".
    expect(fit.fallbackReason).toBe("under-determined");
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
    // The physical guard, not the statistical one — the data is internally
    // consistent (perfectly, given tight declared sigma), just implausible.
    expect(fit.fallbackReason).toBe("implausible-offset");
  });

  it("treats maxCHeadSigmaDeg: Infinity as genuinely off, even when the covariance itself is unusable", () => {
    // The statistical guard used to read
    //   !Number.isFinite(cSigma) || cSigma > opts.maxCHeadSigmaDeg
    // whose FIRST disjunct fires on a singular/unusable covariance no
    // matter what the threshold is — so passing Infinity did not actually
    // switch the guard off. That matters because the outlier loop's
    // measuring fit relies on exactly that relaxation: a measuring fit
    // re-frozen to heading-only gives every good sighting the true cHead
    // offset as baseline residual and hides real outliers behind an
    // inflated leave-one-out threshold. It now reads Number.isNaN(cSigma)
    // instead: +Infinity still exceeds any FINITE threshold (so an ordinary
    // caller is unaffected — see the two gated assertions below), but NaN,
    // which has no ordering at all, still needs its own test.
    //
    // Three identical postures with an absurd 1e-9° declared sigma is a
    // deliberately ill-conditioned probe: rank-deficient geometry with
    // enormous weights, which drives the normal matrix past what inv3 can
    // usefully invert and leaves cSigma at +Infinity.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [
      synth(truthR, truthC, 30, 20, 1e-9),
      synth(truthR, truthC, 30, 20, 1e-9),
      synth(truthR, truthC, 30, 20, 1e-9),
    ];

    const allOff = fitCalibration(D_BASE, s, GP, {
      maxCHeadSigmaDeg: Infinity,
      maxCHeadOffAxisDeg: Infinity,
      maxResidualRmsSigmaMultiple: Infinity,
    });
    // The guard SAW an unusable sigma and still did not fire, because the
    // caller told it not to. Before the fix this returned "heading-only" /
    // "under-determined".
    expect(allOff.stage).toBe("full");
    expect(allOff.fallbackReason).toBeNull();
    expect(allOff.cHeadSigmaDeg).toBe(Infinity);

    // A FINITE threshold is unaffected: +Infinity exceeds it, so both the
    // default configuration and an explicit large-but-finite one still
    // REFUSE this geometry and leave cHead frozen forward. That refusal is
    // what this test is about; the specific reason is asserted below but is
    // not the point here (see the two dedicated discrimination tests in the
    // "residual sanity gate" block for the reason semantics).
    for (const gated of [
      fitCalibration(D_BASE, s, GP),
      fitCalibration(D_BASE, s, GP, { maxCHeadSigmaDeg: 1e6 }),
    ]) {
      expect(gated.stage).toBe("heading-only");
      expect(gated.cHead).toEqual([0, 1, 0]);
      // "inconsistent-residuals", not "under-determined": on this
      // deliberately pathological fixture the full fit genuinely cannot
      // explain its own sightings (measured rmsDeg 1.84° against the 1.5°
      // absolute floor, because 1e-9° declared sigma wrecks the normal
      // matrix), and the residual-consistency guard is checked before the
      // statistical one. Earlier revisions reported "under-determined"
      // here only because that guard ran last; the sightings themselves
      // are unchanged.
      expect(gated.fallbackReason).toBe("inconsistent-residuals");
    }
  });

  it("rejects non-finite or negative option thresholds at the boundary", () => {
    // FitOptions was unvalidated. Every guard compares `measured > threshold`,
    // which is FALSE for every measured value when the threshold is NaN — so
    // a NaN option silently switched a guard OFF rather than loosening it
    // (verified against the previous revision: `{ maxCHeadSigmaDeg: NaN }` on
    // this fixture returned stage "full" with a fabricated cHeadSigmaDeg
    // instead of refusing). A negative bound would refuse everything
    // unconditionally. +Infinity stays legal — it is the documented way to
    // switch a guard off, and the outlier loop's measuring fit depends on it.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [
      synth(truthR, truthC, 40, 5), synth(truthR, truthC, 10, 20), synth(truthR, truthC, -20, 38),
    ];

    for (const bad of [
      { maxCHeadSigmaDeg: NaN },
      { maxCHeadOffAxisDeg: NaN },
      { maxResidualRmsSigmaMultiple: NaN },
      { maxCHeadSigmaDeg: -1 },
      { maxCHeadOffAxisDeg: -Infinity },
    ]) {
      expect(() => fitCalibration(D_BASE, s, GP, bad)).toThrow(/must be a non-negative number/);
    }

    // Legal values still work, including the two edges.
    expect(() => fitCalibration(D_BASE, s, GP, { maxCHeadSigmaDeg: Infinity })).not.toThrow();
    expect(() => fitCalibration(D_BASE, s, GP, { maxCHeadOffAxisDeg: 0 })).not.toThrow();
    expect(() => fitCalibration(D_BASE, s, GP, {})).not.toThrow();
  });

  it("reports 'under-determined' when there are too few sightings to attempt a full fit at all", () => {
    // n=1 never even reaches the 3 guards below MIN_SIGHTINGS_FOR_FULL — but
    // it is the same underlying cause (not enough information to pin cHead),
    // so it reports the same reason as the statistical guard above.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const s = [synth(truthR, cHeadOf(4, -3), 24, 10)];

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.cHeadSigmaDeg).toBeNull();
    expect(fit.fallbackReason).toBe("under-determined");
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
    expect(onlyResidualGuardLive.fallbackReason).toBe("inconsistent-residuals");

    // And with every guard at its real default, the fit is refused too —
    // and reports the SAME specific reason. This is the one a downstream
    // "add more sightings" operator message must NOT be shown for: the
    // problem here is a bad sighting, not insufficient tilt spread.
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
    expect(fit.fallbackReason).toBe("inconsistent-residuals");
  });

  it("reports 'inconsistent-residuals', not 'under-determined', for a HEADING-ONLY fit whose data disagrees with itself", () => {
    // The residual-consistency check used to run LAST, so it was only ever
    // reached on the full-fit path: a result frozen by the statistical or
    // physical guard returned without its residuals ever being examined.
    // That is the branch that matters in the field — this rig's deployed
    // calibrations are always heading-only, because cHead stays locked
    // until tilt spread is good, and its real sightings sit at 7-16°
    // elevation (the near-horizon postures used here).
    //
    // Measured on this exact fixture before the fix: heading 14.201° wrong,
    // reported alongside headingSigmaDeg 0.254° — a confident sigma on a
    // badly wrong answer, the precise failure class this module exists to
    // eliminate, surviving in the branch nobody checked. And it reported
    // "under-determined", whose documented operator instruction is "add
    // sightings with more spread": exactly the wrong move when the real
    // cause is one fumbled sighting that should be deleted.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(12 * 0.8, -12 * 0.6); // ~12° off forward
    const nearHorizon: [number, number][] = [[35, 3], [15, 6], [-15, 9], [-35, 4]];
    const s = nearHorizon.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 20 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.fallbackReason).toBe("inconsistent-residuals");
    // The symptom that made this worth finding: still a confident sigma on
    // a badly wrong heading. The fix does not repair the heading (nothing
    // can, from this data) — it makes the module say WHY, correctly.
    expect(fit.rmsDeg).toBeGreaterThan(4 * 0.5);
    expect(fit.headingSigmaDeg).toBeLessThan(1);
    expect(Math.abs(recoveredHeadingDeg(fit.R, R0) - 37)).toBeGreaterThan(10);
  });

  it("still reports 'under-determined' when a heading-only fit's large residuals are the CAMERA OFFSET, not a bad sighting", () => {
    // The false-positive guard for the test above, and the reason the check
    // tests the FULL fit's residuals rather than the heading-only fit's own.
    // A heading-only fit cannot represent a real camera offset, so a
    // perfectly clean set of sightings from a genuinely 12°-offset camera
    // leaves the heading-only RMS at 12.00° — six times the threshold —
    // while the recovered heading is 0.230° from truth. Judging THOSE
    // residuals would tell the operator to delete a sighting when every
    // sighting is fine and the actual cure is more tilt spread. The full
    // fit explains this data exactly, so the residual guard correctly stays
    // silent and the statistical guard reports the real cause.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(0, -12);
    const nearHorizon: [number, number][] = [[35, 3], [15, 6], [-15, 9], [-35, 4]];
    const s = nearHorizon.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.rejected).toEqual([false, false, false, false]);
    // Residuals far above the threshold...
    expect(fit.rmsDeg).toBeGreaterThan(10);
    // ...yet the heading is right and the cause is geometry, not data.
    expect(recoveredHeadingDeg(fit.R, R0)).toBeCloseTo(37, 0);
    expect(fit.fallbackReason).toBe("under-determined");
  });

  it("does not fire on clean heading-only data at the sightings' own declared noise", () => {
    // The clean-data false-trip check for the heading-only path. Realistic
    // per-sighting jitter at exactly the declared 0.5° sigma, camera truly
    // forward, near-horizon postures that leave cHead under-determined.
    // Nothing is wrong with this data, so it must NOT be called
    // inconsistent. (The 84-cell clean no-outlier scan reports 0
    // inconsistency trips across cHead 0/2/4/8° × sigma 0.2/0.5/1.0 ×
    // n=4..10; this pins one representative case in the suite.)
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const nearHorizon: [number, number][] = [[35, 3], [15, 6], [-15, 9], [-35, 4], [55, 7]];
    // Deterministic decorrelated jitter, ~0.5° — the declared sigma.
    const s: FitSighting[] = nearHorizon.map(([p, t], i) => {
      const base = synth(truthR, cHeadOf(0, 0), p, t, 0.5);
      const ang = deg2rad(i * 137.5);
      const mag = deg2rad(0.5);
      const v: Vec3 = [
        base.enuUnit[0] + mag * Math.cos(ang),
        base.enuUnit[1] + mag * Math.sin(ang),
        base.enuUnit[2] + mag * Math.cos(ang * 1.7),
      ];
      return { ...base, enuUnit: normalize(v) };
    });

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected.filter(Boolean)).toHaveLength(0);
    expect(fit.fallbackReason).not.toBe("inconsistent-residuals");
    expect(fit.rmsDeg).toBeLessThan(4 * 0.5);
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

  it("still detects a moderate outlier even though pass 1's own fit is gated to heading-only", () => {
    // A 10° pan corruption sits in a hole the residual guard opened: on pass
    // 1 (before this outlier is known about) the full 3-parameter fit is
    // inconsistent enough to trip the residual guard, so `result` (what
    // gets REPORTED) is frozen to heading-only — but outlier DETECTION must
    // not measure against that frozen fit, or every good sighting inherits
    // the true ~5° cHead offset as baseline residual, which masks a 10°
    // outlier under a leave-one-out threshold inflated by that baseline.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3); // ~5° off forward
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 10 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected[2]).toBe(true);
    expect(fit.rejected.filter(Boolean)).toHaveLength(1);
    expect(fit.usedCount).toBe(5);
    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("still detects an outlier when the PHYSICAL guard (not the residual one) blinds a measuring fit that only relaxes the residual guard", () => {
    // Relaxing only the residual guard on the measuring fit is not enough:
    // an outlier can drag the ungated-in-residual-but-still-gated-in-offAxis
    // measuring fit's cHead past the 15° off-axis bound on its own, which
    // freezes THAT fit to heading-only too and reproduces the exact same
    // blinding (every good sighting inherits the true ~5.6° cHead offset as
    // baseline residual). n=5, truth cHead a mix of azimuth+elevation ~8°
    // off forward, one sighting's pan corrupted by 14° — chosen because it
    // is a genuine miss when only the residual guard is relaxed (verified:
    // with that partial fix, nothing gets rejected and cHead ends up ~7.9°
    // off truth) but is caught when all three guards are relaxed on the
    // measuring fit.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const offDeg = 8;
    const truthC = cHeadOf(offDeg * 0.7, -offDeg * 0.7);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 14 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected).toEqual([false, false, true, false, false]);
    expect(fit.usedCount).toBe(4);
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("does not drop a GOOD sighting as collateral while an outlier is still present", () => {
    // Computing `errs` once, up front, against a single measuring fit is
    // not enough either: while the outlier is still accepted, it drags that
    // fit toward it, inflating every OTHER sighting's residual too —
    // including good ones — so a good sighting can look bad enough to be
    // rejected right alongside the real outlier. Detection must re-measure
    // (refit on the shrunken accepted set) after each rejection, not just
    // recompute the threshold. n=8, truth cHead 4° azimuth off forward,
    // sighting[2] pan corrupted by 12° — with only the threshold cascading
    // (not the residuals), sighting[4] is a false positive rejected
    // alongside sighting[2], survivors fall out of the conditioning gate,
    // and the recovered cHead collapses to [0,1,0] (a 4° error) instead of
    // being recovered exactly with the single genuine outlier removed.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, 0);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30], [60, 8], [-40, 25],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 12 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected.filter(Boolean)).toHaveLength(1);
    expect(fit.rejected[2]).toBe(true);
    expect(fit.rejected[4]).toBe(false); // the good sighting that must NOT be collateral
    expect(fit.usedCount).toBe(7);
    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("runs outlier rejection starting at exactly 4 sightings, its minimum", () => {
    // n=4 is also where the 30%-reject-fraction cap (floor(4*0.3)=1) and the
    // "never fewer than 3 accepted" floor (4-3=1) numerically tie. That is
    // not a coincidence of this n: floor(0.3n) <= n-3 for every n>=3 (proof
    // in MIN_ACCEPTED_AFTER_REJECT's declaration comment), so the floor
    // never independently binds at the current MAX_REJECT_FRACTION — there
    // is no test, here or elsewhere, that isolates it from the fraction.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(1, -0.5);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    // 15°, the same magnitude the n=6 test above uses. An earlier round
    // raised this to 30° because 15° had stopped being detected at n=4 —
    // that was the visible symptom of the over-fitting bug now fixed by
    // MEASURE_UNGATED_MIN_SIGHTINGS (an ungated 3-parameter measuring fit
    // on 4 sightings absorbs the outlier into cHead instead of measuring
    // against it), not a real property of n=4. With the fix, detection
    // here works from ~8° up; 15° is restored so this test and the n=6 one
    // exercise the same corruption and any future divergence between them
    // is a signal rather than a tuning artefact.
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected).toEqual([false, false, true, false]);
    expect(fit.usedCount).toBe(3);
  });

  it("does not let a 4-sighting measuring fit absorb the outlier into a fabricated camera offset", () => {
    // n=4 is MIN_SIGHTINGS_FOR_OUTLIERS — the module's own boundary, and
    // the point of least redundancy at which outlier rejection runs at all.
    // A measuring fit with all three guards flatly relaxed has 3 free
    // parameters and only 4 sightings, so rather than exposing the outlier
    // it swings cHead over to absorb it: measured on this exact fixture,
    // the ungated measuring fit converged to a 26.7° off-axis cHead, which
    // pulled the outlier's own residual from 9.72° down to 6.31° against a
    // leave-one-out threshold of 6.82° — so it was KEPT, and the heading
    // that actually aims the rig came out 2.655° wrong while the module
    // reported stage "heading-only" / "implausible-offset" and looked like
    // it had behaved conservatively. The camera here is truly forward, so
    // there is no camera offset to find and any cHead excursion is pure
    // over-fitting.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(0, 0); // exactly forward
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected).toEqual([false, false, true, false]);
    expect(fit.usedCount).toBe(3);
    // The load-bearing assertion: the REPORTED heading is unbiased. Without
    // the fix this is 34.345° (a 2.655° aiming error) with every other
    // observable field looking innocuous.
    expect(recoveredHeadingDeg(fit.R, R0)).toBeCloseTo(37, 3);
  });

  it("keeps the measuring fit ungated where there IS redundancy, so a large but permitted camera offset still sees its outliers", () => {
    // The other half of MEASURE_UNGATED_MIN_SIGHTINGS, and the reason the
    // fix is conditioned on redundancy rather than being a flat, smaller
    // off-axis number for the measuring fit. maxCHeadOffAxisDeg defaults to
    // 15°, so a genuinely 13°-offset camera is something this module is
    // required to solve. With n=5 there is redundancy, and an outlier drags
    // the measuring fit to roughly truth + 10°, i.e. past 20° — entirely
    // legitimate, because the fit is still measuring a real 13° camera, not
    // inventing one. Any flat measuring bound low enough to stop the n=4
    // over-fitting above (18° was the value a sweep on 2/4/8° truth offsets
    // suggested) freezes THIS measuring fit to heading-only instead, misses
    // the outlier completely, and reports a heading 16.3° wrong. Measured
    // over the same 5-20° corruption sweep at truth offsets 10-14°, a flat
    // 18° bound misses 175 of 1116 outliers; the redundancy rule misses 0.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(13, 0);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 11 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected).toEqual([false, false, true, false, false]);
    expect(fit.usedCount).toBe(4);
    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
    expect(recoveredHeadingDeg(fit.R, R0)).toBeCloseTo(37, 2);
  });

  it("keeps the sub-threshold measuring cap even when the caller loosens the reported off-axis bound", () => {
    // Below MEASURE_UNGATED_MIN_SIGHTINGS the measuring fit used to inherit
    // the CALLER's maxCHeadOffAxisDeg, so the obvious future feature "let
    // the operator loosen the bound for an oddly-mounted camera" silently
    // reopened the n=4 over-fitting. Verified against the previous revision
    // on this exact fixture: defaults and 20° rejected correctly with a
    // 0.000° heading error, while 30° and Infinity rejected nothing and
    // reported a heading 2.655° wrong — NEW-4 reproduced through the public
    // API. MEASURE_SUB_THRESHOLD_MAX_OFF_AXIS_DEG now caps it.
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12]];
    const s = postures.map(([p, t]) => synth(truthR, cHeadOf(0, 0), p, t, 0.5));
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    for (const maxCHeadOffAxisDeg of [20, 30, 90, Infinity]) {
      const fit = fitCalibration(D_BASE, s, GP, { maxCHeadOffAxisDeg });
      expect(fit.rejected).toEqual([false, false, true, false]);
      expect(recoveredHeadingDeg(fit.R, R0)).toBeCloseTo(37, 3);
    }
    // A caller TIGHTENING the bound is the safe direction and is preserved
    // as given (Math.min keeps the smaller), so detection still works.
    const tight = fitCalibration(D_BASE, s, GP, { maxCHeadOffAxisDeg: 5 });
    expect(tight.rejected).toEqual([false, false, true, false]);
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
    // fraction is unambiguously the binding constraint here — as it always
    // is under the current MAX_REJECT_FRACTION (see
    // MIN_ACCEPTED_AFTER_REJECT's declaration comment; no separate test
    // isolates the "≥3 accepted" floor as binding, because it cannot be).
    // What this test DOES rule out is masking: each of the worst 4
    // individually clears its own leave-one-out threshold — see the source
    // comment on the cascade.
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
    // The statistical guard: two sightings with a short tilt baseline leave
    // cHead's covariance too loose, not a data-quality problem.
    expect(fit.fallbackReason).toBe("under-determined");
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

// The two datasets that broke the rig in the field, run through the fit that
// replaced the solver which broke on them. Both must come back heading-only:
// the whole failure was answering a question the data could not answer.
describe("real field datasets (regression)", () => {
  const sig = DEFAULT_SIGHTING_SIGMA_DEG;

  it("2026-08-16 checked-in fixture: heading-only, and the residual exposes the bad data", () => {
    const field = JSON.parse(readFileSync(
      fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
    const samples = field.sweep.map((s: any) => ({
      panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
    }));
    const { dBase } = solveImuMounting(samples, GP);
    const sightings: FitSighting[] = field.sightings.map((s: any) => ({
      panDeg: s.panDeg, tiltDeg: s.tiltDeg,
      enuUnit: enuDirection(field.rig, { lat: s.lat, lon: s.lon, height: s.height }).unit,
      sigmaDeg: sig,
    }));
    const fit = fitCalibration(dBase, sightings, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
    // These sightings are mutually inconsistent (two targets 0.37° apart in
    // true elevation recorded 3.7° apart in tilt, both ~32° below things
    // ABOVE the horizon). The old solver hid that in a 47°-off cHead fitted
    // to 0.19°; the fit must instead leave it visible as a large residual.
    expect(fit.rmsDeg).toBeGreaterThan(20);
  });

  it("2026-08-19 field pair: heading-only, because 1.5° of tilt spread cannot see a boresight", () => {
    // The two aircraft that produced the 57°-off cHead and put the rig ~17°
    // into the ground. Wide in azimuth (27.6° apart), flat in tilt.
    const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 341 };
    const dBase: Vec3 = [-0.0031035359111758394, 0.00002645907853690451, -0.999995183670784];
    const sightings: FitSighting[] = [
      { lat: 33.518915, lon: -112.160265, height: 4945.38, panDeg: 16.15051615051615, tiltDeg: 15.14026514026514 },
      { lat: 33.47809709361976, lon: -112.09503015461256, height: 4071.3626675200003, panDeg: -12.739512739512739, tiltDeg: 16.616266616266614 },
    ].map((s) => ({
      panDeg: s.panDeg, tiltDeg: s.tiltDeg,
      enuUnit: enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height }).unit,
      sigmaDeg: sig,
    }));
    const fit = fitCalibration(dBase, sightings, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.fallbackReason).toBe("under-determined");
    expect(fit.cHead).toEqual([0, 1, 0]);
    expect(fit.tiltSpreadDeg).toBeCloseTo(1.5, 0);
    // Consistent data — it just cannot identify the camera offset. The
    // residual stays at the level a real, small boresight would explain,
    // which is what makes it safe to fly on.
    expect(fit.rmsDeg).toBeLessThan(2);
  });
});
