import { Mat3, Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { boresightEnu } from "./control.js";
import { enuToPanTiltOffset } from "../geo/imu-orientation.js";

export interface SunCheck {
  readonly separationDeg: number;
  readonly predictedSeparationDeg: number;
  readonly tripped: boolean;
}

// Predict the boresight after horizonMs at the given per-axis rates (user frame),
// then take the smaller of current and predicted separation. Tripped iff either
// the current OR the predicted boresight is inside the cone.
//
// cHead/geoPanSign default to the no-offset/legacy-handed identity, so every
// existing caller (and test) keeps getting exactly the old boresight mapping.
// Production callers (SunSupervisor) pass the SAME offset model used for
// pointing -- the guard must agree with the aim about where the camera is
// actually looking, or the rig could be pointed at the sun while the guard
// thinks it's safe.
export function checkSun(
  R: Mat3, panDeg: number, tiltDeg: number,
  ratePanDps: number, rateTiltDps: number, horizonMs: number,
  sunEnu: Vec3, coneDeg: number,
  cHead: Vec3 = [0, 1, 0], geoPanSign: number = 1,
): SunCheck {
  const sep = angleBetweenDeg(boresightEnu(R, panDeg, tiltDeg, cHead, geoPanSign), sunEnu);
  const h = Math.max(0, horizonMs) / 1000;
  const predPan = panDeg + ratePanDps * h;
  const predTilt = tiltDeg + rateTiltDps * h;
  const predSep = angleBetweenDeg(boresightEnu(R, predPan, predTilt, cHead, geoPanSign), sunEnu);
  return {
    separationDeg: sep,
    predictedSeparationDeg: predSep,
    tripped: sep < coneDeg || predSep < coneDeg,
  };
}

export interface Waypoint {
  readonly panDeg: number;
  readonly tiltDeg: number;
}

export interface ParkPlan {
  readonly kind: "direct" | "pan-detour" | "no-safe-path";
  // Flown IN SEQUENCE, each a single-axis move from the previous, so the flown
  // path is exactly the path sampled below. Empty for no-safe-path.
  readonly waypoints: readonly Waypoint[];
}

export interface ParkLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

const PARK_SAMPLE_DEG = 1.0;        // baseline resolution when sampling a sweep
const MIN_SAMPLES_PER_CONE = 10;    // guarantee >=10 samples across a cone width
const DETOUR_MARGIN_DEG = 5.0;      // extra clearance past the cone edge for a pan detour

// Minimum boresight→sun separation while sweeping ONE axis from a→b at fixed
// other-axis, inclusive of endpoints. Sampling APPROXIMATES the continuous
// minimum to within half the sample spacing; sampleDeg is scaled to the cone by
// the caller so the approximation cannot step over a full cone transit.
function minSepAlong(
  R: Mat3, sunEnu: Vec3, axis: "pan" | "tilt", fixed: number, a: number, b: number, sampleDeg: number,
  cHead: Vec3, geoPanSign: number,
): number {
  const steps = Math.max(1, Math.ceil(Math.abs(b - a) / sampleDeg));
  let min = Infinity;
  for (let i = 0; i <= steps; i++) {
    const v = a + ((b - a) * i) / steps;
    const enu = axis === "tilt"
      ? boresightEnu(R, fixed, v, cHead, geoPanSign)
      : boresightEnu(R, v, fixed, cHead, geoPanSign);
    min = Math.min(min, angleBetweenDeg(enu, sunEnu));
  }
  return min;
}

// A single-axis leg (from `a` to `b` at the fixed other-axis) is "clear" if it
// never brings the boresight closer to the sun than min(coneDeg, separation at
// the leg's START). A leg that starts OUTSIDE the cone must stay outside it (the
// normal predictive trip). A leg that starts INSIDE the cone — which is exactly
// why we park when the sun has already drifted onto the boresight — only has to
// escape WITHOUT getting closer; demanding >= coneDeg there is unsatisfiable and
// would leave the rig sitting on the sun (a moving hazard) instead of moving away.
function sweepClear(
  R: Mat3, sunEnu: Vec3, axis: "pan" | "tilt", fixed: number, a: number, b: number,
  coneDeg: number, sampleDeg: number, cHead: Vec3, geoPanSign: number,
): boolean {
  const startEnu = axis === "tilt"
    ? boresightEnu(R, fixed, a, cHead, geoPanSign)
    : boresightEnu(R, a, fixed, cHead, geoPanSign);
  const startSep = angleBetweenDeg(startEnu, sunEnu);
  const threshold = Math.min(coneDeg, startSep);
  return minSepAlong(R, sunEnu, axis, fixed, a, b, sampleDeg, cHead, geoPanSign) >= threshold;
}

// cHead/geoPanSign default to the no-offset/legacy-handed identity, so every
// existing caller (and test) keeps getting exactly the old sun-park geometry.
// Production callers (SunSupervisor) pass the SAME offset model used for
// pointing, so the sun's own posture below is computed in the same frame as
// the aim -- the detour clears the place the guard and the aim agree the sun
// actually is, not a legacy-only approximation of it.
export function planPark(
  R: Mat3, curPanDeg: number, curTiltDeg: number,
  sunEnu: Vec3, coneDeg: number, parkTiltDeg: number,
  limits: ParkLimits,
  cHead: Vec3 = [0, 1, 0], geoPanSign: number = 1,
): ParkPlan {
  const tiltTarget = Math.max(limits.tiltMin, Math.min(limits.tiltMax, parkTiltDeg));
  // Enough samples that a thin cone cannot hide a transit between two samples.
  const sampleDeg = Math.min(PARK_SAMPLE_DEG, coneDeg / MIN_SAMPLES_PER_CONE);

  // 1. Direct: tilt down at the current pan. Clear iff the sweep never gets closer
  // to the sun than where it starts (or than the cone, if it starts outside it).
  if (sweepClear(R, sunEnu, "tilt", curPanDeg, curTiltDeg, tiltTarget, coneDeg, sampleDeg, cHead, geoPanSign)) {
    return { kind: "direct", waypoints: [{ panDeg: curPanDeg, tiltDeg: tiltTarget }] };
  }

  // 2. Pan detour: swing pan clear of the sun's azimuth, THEN tilt down — two
  // waypoints flown in that order (an L), which is exactly what is checked here.
  const sunPT = enuToPanTiltOffset(R, cHead, geoPanSign, sunEnu, limits);
  const clearOffset = coneDeg / Math.max(0.2, Math.cos((sunPT.tiltDeg * Math.PI) / 180)) + DETOUR_MARGIN_DEG;
  for (const cand of [sunPT.panDeg + clearOffset, sunPT.panDeg - clearOffset]) {
    // Resolve the candidate into [panMin, panMax] via ±360 like the pointing code.
    const resolved = [cand, cand - 360, cand + 360].find((p) => p >= limits.panMin && p <= limits.panMax);
    if (resolved === undefined) continue;
    // panClear starts at the ACTUAL current boresight (possibly in-cone), so it
    // gets the escape relaxation. tiltClear starts at the detour pan — a point WE
    // chose — so it must stay STRICTLY outside the cone; relaxing it would let a
    // detour dip back toward the sun on its second leg.
    const panClear = sweepClear(R, sunEnu, "pan", curTiltDeg, curPanDeg, resolved, coneDeg, sampleDeg, cHead, geoPanSign);
    const tiltClear = minSepAlong(R, sunEnu, "tilt", resolved, curTiltDeg, tiltTarget, sampleDeg, cHead, geoPanSign) >= coneDeg;
    if (panClear && tiltClear) {
      return {
        kind: "pan-detour",
        waypoints: [
          { panDeg: resolved, tiltDeg: curTiltDeg }, // pan sweep at the current tilt
          { panDeg: resolved, tiltDeg: tiltTarget }, // then tilt down at the detour pan
        ],
      };
    }
  }

  // 3. Nothing safe — refuse to move.
  return { kind: "no-safe-path", waypoints: [] };
}
