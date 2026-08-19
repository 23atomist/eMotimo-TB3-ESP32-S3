import {
  Vec3, Mat3, deg2rad, rad2deg, dot, cross, normalize, matVec, matMul, rotZ, inv3,
} from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { rotAlign } from "./imu-orientation.js";

/** Fallback 1σ angular error for a sighting recorded before sigmaDeg existed. */
export const DEFAULT_SIGHTING_SIGMA_DEG = 1.0;

const GN_ITERATIONS = 40;
const GN_STEP_RAD = 1e-6;          // central-difference step for the Jacobian
const GN_CONVERGED_RAD = 1e-10;    // stop when the parameter step is this small
// A fixed nudge on the free-parameter diagonal. At the normal-matrix scales
// this problem actually produces (~1e4-1e5 for a handful of degree-scale
// sightings) 1e-12 is numerically inert — it does NOT keep JᵀWJ invertible.
// The real protection against a singular normal matrix is inv3's own
// determinant guard plus the try/catch around it in gaussNewton(), which
// stops iterating and keeps the best parameters found so far. This term is
// kept only as a textbook Levenberg-style placeholder in case a future
// change shrinks the matrix scale enough for it to matter.
const GN_DAMPING = 1e-12;
const MIN_SIGHTINGS_FOR_FULL = 2;  // 3 params need ≥4 residual components
// Below this there is no majority to judge a candidate against, so outlier
// rejection is skipped entirely. COUPLED to MEASURE_UNGATED_MIN_SIGHTINGS
// below: this is the least-redundant n at which rejection runs at all, and
// that constant exists precisely because a measuring fit at THIS n has no
// redundancy left to resist the outlier. If you change this, re-derive
// MEASURE_UNGATED_MIN_SIGHTINGS with it (and re-run the n=4 sweep described
// there) — raising one without the other silently reopens the over-fitting
// it prevents.
const MIN_SIGHTINGS_FOR_OUTLIERS = 4;
const MAX_REJECT_FRACTION = 0.3;
// Belt-and-braces, not currently load-bearing: for every n>=3,
// floor(MAX_REJECT_FRACTION*n) <= n - MIN_ACCEPTED_AFTER_REJECT (they tie
// exactly at n=3 and n=4; the fraction term is strictly smaller — i.e. is
// the one that binds in maxReject's min() below — for every n>=5). So at
// MAX_REJECT_FRACTION=0.3 this constant never independently changes an
// outcome; it exists so that if MAX_REJECT_FRACTION is ever raised (e.g. to
// tolerate a noisier field process), rejection still cannot eat the
// majority of the sightings. Do not expect a test to isolate this constant
// from the fraction under the current value — none can; see the outlier
// tests' comments.
const MIN_ACCEPTED_AFTER_REJECT = 3;
const OUTLIER_RMS_MULTIPLE = 3;
const OUTLIER_FLOOR_DEG = 2;
// How many sightings the MEASURING fit inside the outlier loop needs before
// its camera parameters may be left completely ungated (see the loop's own
// comment for what the measuring fit is and why it is gated differently from
// the reported one). Below this, the measuring fit gets no more off-axis
// latitude than the REPORTED fit does.
//
// This is a redundancy threshold, not a magnitude one, because the two
// populations it separates OVERLAP in magnitude and cannot be told apart by
// any single off-axis number. Measured over 279 n=4 cells (3 cHead
// placements x truth offsets 2/4/8 deg x pan corruption 5-20 deg): a
// 3-parameter measuring fit on 4 sightings lands at least 15.7 deg off-axis
// in EVERY cell and a median of 26 deg — even where the truth offset is 2
// deg, i.e. it is not measuring the camera, it is chasing the outlier with
// it. The same sweep at n>=5 tops out at 18.0 deg, and at truth offsets of
// 10-14 deg (which maxCHeadOffAxisDeg=15 explicitly permits) it reaches 22.2
// deg legitimately. So every scalar bound is wrong somewhere: 18 fixes n=4
// but then misses 175/1116 real outliers at truth offsets 10-14 deg (heading
// error up to 17.5 deg), and anything generous enough for those (>=22) lets
// n=4 keep over-fitting. n itself separates them exactly.
//
// 5 is the first n with redundancy to spare: n=4 is MIN_SIGHTINGS_FOR_OUTLIERS
// itself, where one sighting is a quarter of the data and 3 free parameters
// have 8 residual components to satisfy. Note the reject cap keeps the live
// set at >=5 for every starting n>=5 (n=5,6 allow 1 rejection; n=7..9 allow 2;
// see maxReject), so in practice this only ever engages at n=4 today — it is
// written against the live count anyway so it stays correct if
// MAX_REJECT_FRACTION is ever raised.
//
// This threshold is a property of the PARAMETER COUNT, not of any geometry:
// it says "one sighting must not be able to move a 3-parameter fit far
// enough to hide itself". If the model ever gains a fourth free parameter,
// this must move with it — the arithmetic behind 5 is 3 free parameters
// against 8 residual components at n=4, and a fourth parameter shifts that
// balance. It is also COUPLED to MIN_SIGHTINGS_FOR_OUTLIERS above; see that
// constant's comment.
const MEASURE_UNGATED_MIN_SIGHTINGS = 5;
// Hard ceiling on the off-axis latitude the measuring fit may be given when
// the live sighting count is BELOW MEASURE_UNGATED_MIN_SIGHTINGS. Without
// it, the sub-threshold branch would inherit the caller's own
// maxCHeadOffAxisDeg, so an operator loosening the REPORTED bound for a
// genuinely odd camera mounting (a plausible future feature) would silently
// reopen the n=4 over-fitting: verified, at n=4 with a forward camera and a
// 15° pan fumble, the default and 20° both reject correctly with 0.000°
// heading error while 30° and Infinity reject nothing and report a heading
// 2.655° wrong. 15 is the value the measured over-fit population sits just
// above (an ungated 3-parameter fit on 4 sightings lands at least 15.7°
// off-axis in every one of 279 cells), and it is also this module's own
// DEFAULT maxCHeadOffAxisDeg, so the common case is unchanged. A caller who
// TIGHTENS the bound still gets their tighter value — Math.min keeps
// whichever is smaller, and tighter only freezes the measuring fit sooner,
// which is the safe direction.
const MEASURE_SUB_THRESHOLD_MAX_OFF_AXIS_DEG = 15;
// Third conditioning guard, independent of the statistical (cSigma) and
// physical (off-axis) ones. Covariance from (JᵀWJ)⁻¹ is LOCAL CURVATURE at
// the converged point — it reports how sharply pinned the parameters are
// GIVEN that the model fits, but it cannot see whether the model actually
// fits: a wrong-basin convergence or genuinely inconsistent sightings can
// still produce tight curvature (small cSigma) alongside a residual RMS far
// beyond what the sightings' own declared sigmaDeg would predict. 4x is
// still permissive — comparable to a 99.9th-percentile chi-square bound for
// a couple of degrees of freedom — so ordinary noisy-but-correct data (this
// module's own test: 10 sightings at 1° declared noise converge with
// rmsDeg ~0.9, well inside a 4° threshold) is never blocked; the other two
// guards already handle under-determined geometry, so this one only needs
// to catch gross self-inconsistency.
const RESIDUAL_RMS_SIGMA_MULTIPLE = 4;
// The largest camera offset treated as physically plausible; also the default
// for maxCHeadOffAxisDeg. Exported because a heading-only fit holds cHead at
// forward, so ANY real boresight offset lands in that fit's residual — and a
// caller gating on rmsDeg must allow for it or it rejects good data (the real
// 2026-07-30 sightings fit heading-only at 4.5° rms purely from the rig's own
// ~4.4° boresight).
export const MAX_CHEAD_OFF_AXIS_DEG = 15;
const RESIDUAL_RMS_FLOOR_DEG = 1.5; // floor so a tiny declared sigma can't trip on ordinary float noise

/**
 * The residual-RMS bound the fit's own consistency guard applies, exposed so
 * that callers which gate on a returned `rmsDeg` (solve_calibration) use the
 * SAME rule instead of a second copy that drifts away from this one.
 *
 * A fit whose rmsDeg exceeds this is inconsistent with what its own sightings
 * claim about their accuracy: the geometry is not noisy, one of the inputs is
 * wrong.
 */
export function residualRmsBoundDeg(
  sigmasDeg: readonly number[], multiple: number = RESIDUAL_RMS_SIGMA_MULTIPLE,
): number {
  const usable = sigmasDeg.map((v) => (v > 0 && Number.isFinite(v) ? v : DEFAULT_SIGHTING_SIGMA_DEG));
  if (usable.length === 0) return RESIDUAL_RMS_FLOOR_DEG;
  return Math.max(multiple * median(usable), RESIDUAL_RMS_FLOOR_DEG);
}

export interface FitSighting {
  readonly panDeg: number;
  readonly tiltDeg: number;
  readonly enuUnit: Vec3;   // truth direction, rig → target
  readonly sigmaDeg: number; // 1σ expected angular error of THIS sighting
}

export interface FitOptions {
  readonly maxCHeadSigmaDeg?: number;
  readonly maxCHeadOffAxisDeg?: number;
  // Multiple of the sightings' own median sigmaDeg a converged full fit's
  // rmsDeg may reach before the third (residual-consistency) guard refuses
  // it. Exposed for symmetry with the other two guards and so tests (and
  // operators on a site with unusually noisy but still correct sightings)
  // can isolate or relax it independently. Defaults to
  // RESIDUAL_RMS_SIGMA_MULTIPLE; the absolute floor (RESIDUAL_RMS_FLOOR_DEG)
  // is not exposed — like the outlier-rejection floor, it exists only to
  // stop a tiny declared sigma from tripping on ordinary float noise.
  readonly maxResidualRmsSigmaMultiple?: number;
}

// Why the camera-offset parameters stayed frozen at forward, one per guard
// (see the guard comments in fitOnce). Distinct from stage: "heading-only"
// tells a consumer THAT cHead was not solved; this tells them WHY, which
// matters because the right operator instruction differs by cause —
// "under-determined" means add sightings with more spread (tilt for the
// camera offset, pan for heading), "implausible-offset" and
// "inconsistent-residuals" both mean the DATA itself is the problem (a
// mis-mounted assumption or a bad sighting), and telling an operator with
// bad data to "add more sightings" sends them in the wrong direction.
export type FallbackReason = "under-determined" | "implausible-offset" | "inconsistent-residuals";

export interface CalibrationFit {
  readonly R: Mat3;
  readonly cHead: Vec3;
  readonly stage: "heading-only" | "full";
  readonly headingSigmaDeg: number;
  readonly cHeadSigmaDeg: number | null;
  readonly fallbackReason: FallbackReason | null; // null iff stage === "full"
  readonly residualsDeg: number[];  // per INPUT sighting, input order
  readonly rejected: boolean[];     // per INPUT sighting, input order
  readonly rmsDeg: number;          // over accepted sightings only
  readonly usedCount: number;
  readonly baseLeanDeg: number;
  readonly tiltSpreadDeg: number;
}

/** Camera boresight from its two angular parameters. Unit by construction. */
function cHeadOf(caRad: number, ceRad: number): Vec3 {
  return [Math.sin(caRad) * Math.cos(ceRad), Math.cos(caRad) * Math.cos(ceRad), Math.sin(ceRad)];
}

/** An orthonormal pair spanning the plane perpendicular to unit vector u. */
function tangentBasis(u: Vec3): [Vec3, Vec3] {
  const seed: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(u, seed));
  const e2 = cross(u, e1); // already unit: u ⟂ e1, both unit
  return [e1, e2];
}

/**
 * Predicted boresight direction for parameters p = [heading, cHeadAz, cHeadEl]
 * (all radians) at a given posture.
 */
function predict(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): Vec3 {
  const M = mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg);
  return normalize(matVec(matMul(rotZ(p[0]), matMul(R0, M)), cHeadOf(p[1], p[2])));
}

/**
 * Weighted tangent-plane residual pair for one sighting, in units of sigma.
 * For small errors each component is the angular error (radians) along one
 * tangent direction, so the pair's magnitude is the angular miss.
 */
function residualPair(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): [number, number] {
  const pred = predict(R0, geoPanSign, p, s);
  const [e1, e2] = tangentBasis(s.enuUnit);
  const w = 1 / deg2rad(s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG);
  return [dot(pred, e1) * w, dot(pred, e2) * w];
}

function angularErrorDeg(R0: Mat3, geoPanSign: number, p: readonly number[], s: FitSighting): number {
  const pred = predict(R0, geoPanSign, p, s);
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(pred, s.enuUnit)))));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Gauss-Newton over the free parameters only. `free` selects which of the three
 * parameters may move; the rest stay at their seed value. Returns the solved
 * parameters and the 3×3 normal matrix (JᵀWJ), padded with 1 on frozen
 * diagonals so it stays invertible.
 */
function gaussNewton(
  R0: Mat3, geoPanSign: number, seed: readonly number[], sightings: FitSighting[], free: readonly boolean[],
): { p: number[]; normal: Mat3 } {
  const p = [...seed];
  let normal: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < GN_ITERATIONS; iter++) {
    // Accumulate JᵀJ and Jᵀr over all sightings (weights already folded into r).
    const jtj = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const jtr = [0, 0, 0];
    for (const s of sightings) {
      const r = residualPair(R0, geoPanSign, p, s);
      const cols: number[][] = [[0, 0], [0, 0], [0, 0]];
      for (let k = 0; k < 3; k++) {
        if (!free[k]) continue;
        const up = [...p], dn = [...p];
        up[k] += GN_STEP_RAD; dn[k] -= GN_STEP_RAD;
        const ru = residualPair(R0, geoPanSign, up, s);
        const rd = residualPair(R0, geoPanSign, dn, s);
        cols[k] = [(ru[0] - rd[0]) / (2 * GN_STEP_RAD), (ru[1] - rd[1]) / (2 * GN_STEP_RAD)];
      }
      for (let a = 0; a < 3; a++) {
        if (!free[a]) continue;
        jtr[a] += cols[a][0] * r[0] + cols[a][1] * r[1];
        for (let b = 0; b < 3; b++) {
          if (!free[b]) continue;
          jtj[a][b] += cols[a][0] * cols[b][0] + cols[a][1] * cols[b][1];
        }
      }
    }
    for (let k = 0; k < 3; k++) {
      if (free[k]) jtj[k][k] += GN_DAMPING;
      else jtj[k][k] = 1; // frozen: identity row/col, so inv3 stays well-defined
    }
    normal = [
      [jtj[0][0], jtj[0][1], jtj[0][2]],
      [jtj[1][0], jtj[1][1], jtj[1][2]],
      [jtj[2][0], jtj[2][1], jtj[2][2]],
    ];
    let step: Vec3;
    try {
      step = matVec(inv3(normal), [jtr[0], jtr[1], jtr[2]]);
    } catch {
      break; // singular despite damping — keep the best parameters so far
    }
    let moved = 0;
    for (let k = 0; k < 3; k++) {
      if (!free[k]) continue;
      p[k] -= step[k];
      moved = Math.max(moved, Math.abs(step[k]));
    }
    if (moved < GN_CONVERGED_RAD) break;
  }
  return { p, normal };
}

/** Weighted circular mean of the per-sighting heading disagreement — the seed. */
function seedHeading(R0: Mat3, geoPanSign: number, sightings: FitSighting[]): number {
  let sinSum = 0, cosSum = 0;
  for (const s of sightings) {
    const m = matVec(matMul(R0, mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg)), [0, 1, 0] as Vec3);
    const azModel = Math.atan2(m[0], m[1]);
    const azTruth = Math.atan2(s.enuUnit[0], s.enuUnit[1]);
    const w = 1 / Math.max(deg2rad(s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG) ** 2, 1e-12);
    sinSum += w * Math.sin(azModel - azTruth);
    cosSum += w * Math.cos(azModel - azTruth);
  }
  return Math.atan2(sinSum, cosSum);
}

function fitOnce(
  R0: Mat3, geoPanSign: number, sightings: FitSighting[], opts: Required<FitOptions>,
): {
  p: number[];
  stage: "heading-only" | "full";
  headingSigmaDeg: number;
  cHeadSigmaDeg: number | null;
  fallbackReason: FallbackReason | null;
} {
  const seed = [seedHeading(R0, geoPanSign, sightings), 0, 0];

  const headingOnly = gaussNewton(R0, geoPanSign, seed, sightings, [true, false, false]);
  const hSigma = (normal: Mat3): number => {
    try { return rad2deg(Math.sqrt(Math.max(0, inv3(normal)[0][0]))); } catch { return Infinity; }
  };
  const headingOnlyResult = (reason: FallbackReason) => ({
    p: headingOnly.p, stage: "heading-only" as const, headingSigmaDeg: hSigma(headingOnly.normal),
    cHeadSigmaDeg: null, fallbackReason: reason,
  });

  // Too few sightings to even attempt the 3-parameter fit — the same class
  // of problem as the statistical guard below (not enough information to
  // pin cHead), just caught before a full fit is possible at all.
  if (sightings.length < MIN_SIGHTINGS_FOR_FULL) {
    return headingOnlyResult("under-determined");
  }

  const full = gaussNewton(R0, geoPanSign, headingOnly.p, sightings, [true, true, true]);
  let cov: Mat3 | null = null;
  try { cov = inv3(full.normal); } catch { cov = null; }
  const cSigma = cov === null
    ? Infinity
    : rad2deg(Math.sqrt(Math.max(0, Math.max(cov[1][1], cov[2][2]))));
  const offAxisDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, cHeadOf(full.p[1], full.p[2])[1]))));

  // Residual-consistency guard: is the full fit even consistent with what
  // its own sightings claim about their accuracy? cSigma above is
  // curvature-only and cannot tell — see the RESIDUAL_RMS_* comment at the
  // top of the file. Checked first of the three; see the block comment
  // below for why.
  const fullErrsDeg = sightings.map((s) => angularErrorDeg(R0, geoPanSign, full.p, s));
  const fullRmsDeg = Math.sqrt(fullErrsDeg.reduce((a, b) => a + b * b, 0) / fullErrsDeg.length);
  const medianSigmaDeg = median(sightings.map((s) => (s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG)));
  const residualThresholdDeg = Math.max(opts.maxResidualRmsSigmaMultiple * medianSigmaDeg, RESIDUAL_RMS_FLOOR_DEG);

  // Three independent guards. Any one failing means the camera parameters
  // are not trustworthy, so they stay frozen at forward; `fallbackReason`
  // reports whichever one fires first, so the ORDER below is the priority
  // order of the operator instructions these reasons carry.
  //
  // The residual-consistency check goes FIRST, and that ordering is what
  // makes a HEADING-ONLY result residual-checked at all: every heading-only
  // return below this point is now preceded by "does the best available fit
  // explain this data?". Before, the check sat last, so a result frozen by
  // the statistical or physical guard returned without ever asking — and a
  // heading-only fit could be badly wrong while reporting a confident
  // sigma. Measured across 9300 cells, 1447 of them returned heading-only
  // with `under-determined` while their own residual RMS exceeded this
  // threshold; the worst was a heading 16.197° wrong reported alongside a
  // headingSigmaDeg of 0.238°. That matters more than it looks: the
  // deployed rig's calibrations are ALWAYS heading-only (cHead stays locked
  // until tilt spread is good), so the unchecked branch was the only branch
  // that runs in the field, and "under-determined" carries the operator
  // instruction "add sightings with more spread" — the opposite of what to
  // do when one sighting is simply bad.
  //
  // It is deliberately the FULL fit's residuals that are tested, never the
  // heading-only fit's own, even though a heading-only result is what gets
  // reported. A heading-only fit cannot represent a real camera offset, so
  // its residuals are inflated by any genuine cHead — measured, a truth
  // cHead 12° off forward with the outlier already rejected leaves the
  // heading-only RMS at 12.0° while the recovered heading is 0.2° from
  // truth. Testing those residuals would report "inconsistent-residuals"
  // (delete a sighting) for data whose actual cure is more tilt spread.
  // Testing the FULL fit's residuals discriminates exactly right: if three
  // parameters CAN explain the sightings, nothing is wrong with the data
  // and the fallback is genuinely about not being able to TRUST cHead
  // (under-determined / implausible-offset); if even three parameters
  // cannot, the sightings disagree with each other. Under-determination
  // makes the full fit's residuals SMALLER (it interpolates), never larger,
  // so putting this check first cannot steal a legitimately
  // under-determined case.
  if (fullRmsDeg > residualThresholdDeg) {
    return headingOnlyResult("inconsistent-residuals");
  }
  // NaN, not merely non-finite. cSigma is +Infinity when the covariance is
  // singular (cov === null above), and +Infinity > any FINITE threshold, so
  // an ordinary caller still gets the singular case refused here. Testing
  // !Number.isFinite() instead would fire even when the caller passed
  // maxCHeadSigmaDeg: Infinity to switch this guard OFF — which is exactly
  // what the outlier loop's measuring fit does, so a singular covariance
  // would silently re-freeze the measuring fit to heading-only and
  // reintroduce the blinding that relaxation exists to prevent. NaN has no
  // ordering at all (NaN > x is false for every x), so it still needs its
  // own test; it means the number is meaningless rather than large.
  // (fitCalibration validates the options themselves, so a NaN THRESHOLD
  // cannot reach here — see resolveOption.)
  if (Number.isNaN(cSigma) || cSigma > opts.maxCHeadSigmaDeg) {
    return headingOnlyResult("under-determined");
  }
  if (offAxisDeg > opts.maxCHeadOffAxisDeg) {
    // A single gross outlier among otherwise-good sightings can present
    // this way too — one bad sighting is sometimes enough to drag the
    // compromise cHead past the off-axis bound on its own, not just a
    // genuinely mis-mounted camera or under-spread geometry. Still in the
    // "the DATA is the problem" family (see FallbackReason's comment), so
    // an operator-facing message built on this reason should not assume
    // it always means "camera is mounted at an odd angle" — it can also
    // mean "delete the sighting you fumbled".
    return headingOnlyResult("implausible-offset");
  }
  return {
    p: full.p,
    stage: "full",
    headingSigmaDeg: cov === null ? Infinity : rad2deg(Math.sqrt(Math.max(0, cov[0][0]))),
    cHeadSigmaDeg: cSigma,
    fallbackReason: null,
  };
}

/**
 * Validate one caller-supplied threshold at the boundary. Every FitOptions
 * field is a non-negative upper bound; +Infinity is a legitimate value and
 * means "this guard is switched off" (the outlier loop's measuring fit
 * relies on exactly that). NaN and negatives are not thresholds at all:
 * every guard compares with `x > threshold`, which is false for every x
 * when the threshold is NaN, so a NaN would silently disable the guard
 * rather than loosen it — the guards are written to test NaN on the
 * MEASURED value for that reason, and validating here means they never
 * have to second-guess the THRESHOLD too. A negative bound would refuse
 * every fit unconditionally, which is never what a caller means.
 */
function resolveOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  // NaN needs its own test: `NaN < 0` is false, so the comparison below
  // would let it through.
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new Error(
      `fitCalibration: ${name} must be a non-negative number (Infinity allowed), got ${String(value)}`,
    );
  }
  return value;
}

export function fitCalibration(
  dBase: Vec3, sightings: FitSighting[], geoPanSign: number, opts: FitOptions = {},
): CalibrationFit {
  if (sightings.length === 0) throw new Error("fitCalibration: need at least one sighting");
  const resolved: Required<FitOptions> = {
    maxCHeadSigmaDeg: resolveOption("maxCHeadSigmaDeg", opts.maxCHeadSigmaDeg, 3),
    maxCHeadOffAxisDeg: resolveOption("maxCHeadOffAxisDeg", opts.maxCHeadOffAxisDeg, MAX_CHEAD_OFF_AXIS_DEG),
    maxResidualRmsSigmaMultiple: resolveOption(
      "maxResidualRmsSigmaMultiple", opts.maxResidualRmsSigmaMultiple, RESIDUAL_RMS_SIGMA_MULTIPLE,
    ),
  };
  const dn = normalize(dBase);
  const R0 = rotAlign([-dn[0], -dn[1], -dn[2]], [0, 0, 1]);
  const baseLeanDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, -dn[2]))));

  // Pass 1 over everything, then optionally reject outliers and refit.
  const accepted = sightings.map(() => true);
  let result = fitOnce(R0, geoPanSign, sightings, resolved);

  if (sightings.length >= MIN_SIGHTINGS_FOR_OUTLIERS) {
    const maxReject = Math.min(
      Math.floor(sightings.length * MAX_REJECT_FRACTION),
      sightings.length - MIN_ACCEPTED_AFTER_REJECT,
    );
    if (maxReject > 0) {
      // Outlier detection must MEASURE residuals against the best fit the
      // CURRENTLY-ACCEPTED data actually supports — never against `result`
      // (what is going to be REPORTED) and never against a stale fit left
      // over from a previous rejection. Three things must all hold, or
      // detection blinds itself or fools itself:
      //
      // (1) The statistical and residual guards are relaxed unconditionally
      // on the measuring fit. Whichever guard freezes a measuring fit to
      // heading-only, every GOOD sighting inherits the true cHead offset as
      // baseline residual, which inflates the leave-one-out threshold below
      // enough to hide a real outlier.
      //
      // (2) The PHYSICAL (off-axis) guard is relaxed too — but only where
      // there is enough data for "relaxed" to still mean measuring. It has
      // the same blinding power as (1): an outlier alone can drag the
      // measuring fit's cHead past the off-axis bound, freezing it. But it
      // is also the only thing stopping a measuring fit from ABSORBING the
      // outlier into an implausible cHead when there is no redundancy to
      // stop it, which is exactly what happens at n=4. So the latitude is
      // conditioned on the live sighting count rather than being a flat
      // Infinity — see MEASURE_UNGATED_MIN_SIGHTINGS for the measurements
      // behind that, and for why no single off-axis NUMBER can do this job.
      //
      // (3) Re-measure from a FRESH fit after every rejection, not once up
      // front. While a real outlier is still present, it drags the
      // measuring fit toward it, which inflates EVERY other sighting's
      // residual too (including good ones) — a leftover outlier can make an
      // innocent sighting look bad enough to be rejected as collateral.
      // Refitting on the shrunken accepted set before judging the next
      // candidate removes that drag, so both the RESIDUALS and the
      // leave-one-out THRESHOLD cascade together (an earlier version of
      // this code cascaded only the threshold, computing residuals once up
      // front, and dropped a good sighting as collateral because of it).
      let dropped = 0;
      while (dropped < maxReject) {
        const liveIndices = sightings.map((_, i) => i).filter((i) => accepted[i]);
        const measureOpts: Required<FitOptions> = {
          maxCHeadSigmaDeg: Infinity,
          maxCHeadOffAxisDeg: liveIndices.length >= MEASURE_UNGATED_MIN_SIGHTINGS
            ? Infinity
            : Math.min(resolved.maxCHeadOffAxisDeg, MEASURE_SUB_THRESHOLD_MAX_OFF_AXIS_DEG),
          maxResidualRmsSigmaMultiple: Infinity,
        };
        const measuring = fitOnce(R0, geoPanSign, liveIndices.map((i) => sightings[i]), measureOpts);
        const errs = liveIndices.map((i) => angularErrorDeg(R0, geoPanSign, measuring.p, sightings[i]));
        // Worst-first; ties broken by index for determinism. The threshold
        // is a leave-one-out RMS — computed over the OTHER still-accepted
        // sightings' (freshly measured) residuals, never the candidate's
        // own — because a single gross outlier folded into its own pooled
        // RMS inflates the very threshold meant to catch it. This still
        // CASCADES across the while-loop's iterations: once the worst
        // offender is rejected, both the residuals AND the threshold for
        // the next candidate are recomputed from scratch on the remaining
        // set, so a second, milder outlier that would have been masked
        // alongside the first is now judged cleanly.
        const order = errs.map((e, k) => ({ e, i: liveIndices[k] })).sort((a, b) => b.e - a.e || a.i - b.i);
        const worst = order[0];
        const rest = errs.filter((_, k) => liveIndices[k] !== worst.i);
        const restRms = Math.sqrt(rest.reduce((a, b) => a + b * b, 0) / rest.length);
        const threshold = Math.max(OUTLIER_RMS_MULTIPLE * restRms, OUTLIER_FLOOR_DEG);
        if (worst.e <= threshold) break;
        accepted[worst.i] = false;
        dropped++;
      }
      if (dropped > 0) {
        result = fitOnce(R0, geoPanSign, sightings.filter((_, i) => accepted[i]), resolved);
      }
    }
  }

  const residualsDeg = sightings.map((s) => angularErrorDeg(R0, geoPanSign, result.p, s));
  const used = sightings.filter((_, i) => accepted[i]);
  const usedErrs = residualsDeg.filter((_, i) => accepted[i]);
  const tilts = used.map((s) => s.tiltDeg);
  return {
    R: matMul(rotZ(result.p[0]), R0),
    cHead: cHeadOf(result.p[1], result.p[2]),
    stage: result.stage,
    headingSigmaDeg: result.headingSigmaDeg,
    cHeadSigmaDeg: result.cHeadSigmaDeg,
    fallbackReason: result.fallbackReason,
    residualsDeg,
    rejected: accepted.map((a) => !a),
    rmsDeg: Math.sqrt(usedErrs.reduce((a, b) => a + b * b, 0) / usedErrs.length),
    usedCount: used.length,
    baseLeanDeg,
    tiltSpreadDeg: Math.max(...tilts) - Math.min(...tilts),
  };
}
