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
const RESIDUAL_RMS_FLOOR_DEG = 1.5; // floor so a tiny declared sigma can't trip on ordinary float noise

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

  // Third guard: is the full fit even consistent with what its own sightings
  // claim about their accuracy? cSigma above is curvature-only and cannot
  // tell — see the RESIDUAL_RMS_* comment at the top of the file.
  const fullErrsDeg = sightings.map((s) => angularErrorDeg(R0, geoPanSign, full.p, s));
  const fullRmsDeg = Math.sqrt(fullErrsDeg.reduce((a, b) => a + b * b, 0) / fullErrsDeg.length);
  const medianSigmaDeg = median(sightings.map((s) => (s.sigmaDeg > 0 ? s.sigmaDeg : DEFAULT_SIGHTING_SIGMA_DEG)));
  const residualThresholdDeg = Math.max(opts.maxResidualRmsSigmaMultiple * medianSigmaDeg, RESIDUAL_RMS_FLOOR_DEG);

  // Three independent guards, checked in this order. Any one failing means
  // the camera parameters are not trustworthy, so they stay frozen at
  // forward; `fallbackReason` reports whichever one fired first (if more
  // than one would independently refuse the fit, the earliest listed here
  // wins — matches how these were combined as a single `||` before
  // `fallbackReason` existed, just split into an if/else-if chain so each
  // branch can report its own cause instead of a single boolean).
  if (!Number.isFinite(cSigma) || cSigma > opts.maxCHeadSigmaDeg) {
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
  if (fullRmsDeg > residualThresholdDeg) {
    return headingOnlyResult("inconsistent-residuals");
  }
  return {
    p: full.p,
    stage: "full",
    headingSigmaDeg: cov === null ? Infinity : rad2deg(Math.sqrt(Math.max(0, cov[0][0]))),
    cHeadSigmaDeg: cSigma,
    fallbackReason: null,
  };
}

export function fitCalibration(
  dBase: Vec3, sightings: FitSighting[], geoPanSign: number, opts: FitOptions = {},
): CalibrationFit {
  if (sightings.length === 0) throw new Error("fitCalibration: need at least one sighting");
  const resolved: Required<FitOptions> = {
    maxCHeadSigmaDeg: opts.maxCHeadSigmaDeg ?? 3,
    maxCHeadOffAxisDeg: opts.maxCHeadOffAxisDeg ?? 15,
    maxResidualRmsSigmaMultiple: opts.maxResidualRmsSigmaMultiple ?? RESIDUAL_RMS_SIGMA_MULTIPLE,
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
      // over from a previous rejection. Two things must both hold, or
      // detection blinds itself:
      //
      // (1) ALL THREE guards relaxed on the measuring fit, not just the
      // residual one. Whichever guard freezes the measuring fit to
      // heading-only, every GOOD sighting inherits the true cHead offset as
      // baseline residual, which inflates the leave-one-out threshold below
      // enough to hide a real outlier. This is not specific to the residual
      // guard — the physical (off-axis) guard does the exact same thing
      // whenever an outlier alone is enough to drag the measuring fit's
      // cHead past the off-axis bound, which happens on this module's own
      // test geometries.
      //
      // (2) Re-measure from a FRESH fit after every rejection, not once up
      // front. While a real outlier is still present, it drags the
      // measuring fit toward it, which inflates EVERY other sighting's
      // residual too (including good ones) — a leftover outlier can make an
      // innocent sighting look bad enough to be rejected as collateral.
      // Refitting on the shrunken accepted set before judging the next
      // candidate removes that drag, so both the RESIDUALS and the
      // leave-one-out THRESHOLD cascade together (an earlier version of
      // this code cascaded only the threshold, computing residuals once up
      // front, and dropped a good sighting as collateral because of it).
      const measureOpts: Required<FitOptions> = {
        maxCHeadSigmaDeg: Infinity, maxCHeadOffAxisDeg: Infinity, maxResidualRmsSigmaMultiple: Infinity,
      };
      let dropped = 0;
      while (dropped < maxReject) {
        const liveIndices = sightings.map((_, i) => i).filter((i) => accepted[i]);
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
