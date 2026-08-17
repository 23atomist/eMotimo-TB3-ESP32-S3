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
const GN_DAMPING = 1e-12;          // keeps JᵀWJ invertible in degenerate geometry
const MIN_SIGHTINGS_FOR_FULL = 2;  // 3 params need ≥4 residual components
const MIN_SIGHTINGS_FOR_OUTLIERS = 4;
const MAX_REJECT_FRACTION = 0.3;
const MIN_ACCEPTED_AFTER_REJECT = 3;
const OUTLIER_RMS_MULTIPLE = 3;
const OUTLIER_FLOOR_DEG = 2;

export interface FitSighting {
  readonly panDeg: number;
  readonly tiltDeg: number;
  readonly enuUnit: Vec3;   // truth direction, rig → target
  readonly sigmaDeg: number; // 1σ expected angular error of THIS sighting
}

export interface FitOptions {
  readonly maxCHeadSigmaDeg?: number;
  readonly maxCHeadOffAxisDeg?: number;
}

export interface CalibrationFit {
  readonly R: Mat3;
  readonly cHead: Vec3;
  readonly stage: "heading-only" | "full";
  readonly headingSigmaDeg: number;
  readonly cHeadSigmaDeg: number | null;
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
    sinSum += w * Math.sin(azTruth - azModel);
    cosSum += w * Math.cos(azTruth - azModel);
  }
  return Math.atan2(sinSum, cosSum);
}

function fitOnce(
  R0: Mat3, geoPanSign: number, sightings: FitSighting[], opts: Required<FitOptions>,
): { p: number[]; stage: "heading-only" | "full"; headingSigmaDeg: number; cHeadSigmaDeg: number | null } {
  const seed = [seedHeading(R0, geoPanSign, sightings), 0, 0];

  const headingOnly = gaussNewton(R0, geoPanSign, seed, sightings, [true, false, false]);
  const hSigma = (normal: Mat3): number => {
    try { return rad2deg(Math.sqrt(Math.max(0, inv3(normal)[0][0]))); } catch { return Infinity; }
  };

  if (sightings.length < MIN_SIGHTINGS_FOR_FULL) {
    return { p: headingOnly.p, stage: "heading-only", headingSigmaDeg: hSigma(headingOnly.normal), cHeadSigmaDeg: null };
  }

  const full = gaussNewton(R0, geoPanSign, headingOnly.p, sightings, [true, true, true]);
  let cov: Mat3 | null = null;
  try { cov = inv3(full.normal); } catch { cov = null; }
  const cSigma = cov === null
    ? Infinity
    : rad2deg(Math.sqrt(Math.max(0, Math.max(cov[1][1], cov[2][2]))));
  const offAxisDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, cHeadOf(full.p[1], full.p[2])[1]))));

  // Two independent guards. Either one failing means the camera parameters are
  // not trustworthy, so they stay frozen at forward.
  if (!Number.isFinite(cSigma) || cSigma > opts.maxCHeadSigmaDeg || offAxisDeg > opts.maxCHeadOffAxisDeg) {
    return { p: headingOnly.p, stage: "heading-only", headingSigmaDeg: hSigma(headingOnly.normal), cHeadSigmaDeg: null };
  }
  return {
    p: full.p,
    stage: "full",
    headingSigmaDeg: cov === null ? Infinity : rad2deg(Math.sqrt(Math.max(0, cov[0][0]))),
    cHeadSigmaDeg: cSigma,
  };
}

export function fitCalibration(
  dBase: Vec3, sightings: FitSighting[], geoPanSign: number, opts: FitOptions = {},
): CalibrationFit {
  if (sightings.length === 0) throw new Error("fitCalibration: need at least one sighting");
  const resolved: Required<FitOptions> = {
    maxCHeadSigmaDeg: opts.maxCHeadSigmaDeg ?? 3,
    maxCHeadOffAxisDeg: opts.maxCHeadOffAxisDeg ?? 15,
  };
  const dn = normalize(dBase);
  const R0 = rotAlign([-dn[0], -dn[1], -dn[2]], [0, 0, 1]);
  const baseLeanDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, -dn[2]))));

  // Pass 1 over everything, then optionally reject outliers and refit.
  let accepted = sightings.map(() => true);
  let result = fitOnce(R0, geoPanSign, sightings, resolved);

  if (sightings.length >= MIN_SIGHTINGS_FOR_OUTLIERS) {
    const errs = sightings.map((s) => angularErrorDeg(R0, geoPanSign, result.p, s));
    const maxReject = Math.min(
      Math.floor(sightings.length * MAX_REJECT_FRACTION),
      sightings.length - MIN_ACCEPTED_AFTER_REJECT,
    );
    if (maxReject > 0) {
      // Worst-first, capped. Ties broken by index for determinism. The
      // threshold for each candidate is a leave-one-out RMS — computed over
      // the OTHER still-accepted sightings, never the candidate itself —
      // because a single gross outlier folded into its own RMS inflates the
      // very threshold meant to catch it (a 15°-off sighting among 6 raises
      // a pooled RMS enough to hide under 3x its own value; excluded, the
      // remaining 5 give a threshold the outlier actually clears).
      const order = errs.map((e, i) => ({ e, i })).sort((a, b) => b.e - a.e || a.i - b.i);
      let dropped = 0;
      for (const { e, i } of order) {
        if (dropped >= maxReject) break;
        const rest = errs.filter((_, j) => j !== i && accepted[j]);
        const restRms = Math.sqrt(rest.reduce((a, b) => a + b * b, 0) / rest.length);
        const threshold = Math.max(OUTLIER_RMS_MULTIPLE * restRms, OUTLIER_FLOOR_DEG);
        if (e <= threshold) break;
        accepted[i] = false;
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
    residualsDeg,
    rejected: accepted.map((a) => !a),
    rmsDeg: Math.sqrt(usedErrs.reduce((a, b) => a + b * b, 0) / usedErrs.length),
    usedCount: used.length,
    baseLeanDeg,
    tiltSpreadDeg: Math.max(...tilts) - Math.min(...tilts),
  };
}
