import { Mat3, Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { boresightEnu } from "./control.js";
import { enuToPanTilt } from "../geo/orientation.js";

export interface SunCheck {
  readonly separationDeg: number;
  readonly predictedSeparationDeg: number;
  readonly tripped: boolean;
}

// Predict the boresight after horizonMs at the given per-axis rates (user frame),
// then take the smaller of current and predicted separation. Tripped iff either
// the current OR the predicted boresight is inside the cone.
export function checkSun(
  R: Mat3, panDeg: number, tiltDeg: number,
  ratePanDps: number, rateTiltDps: number, horizonMs: number,
  sunEnu: Vec3, coneDeg: number,
): SunCheck {
  const sep = angleBetweenDeg(boresightEnu(R, panDeg, tiltDeg), sunEnu);
  const h = Math.max(0, horizonMs) / 1000;
  const predPan = panDeg + ratePanDps * h;
  const predTilt = tiltDeg + rateTiltDps * h;
  const predSep = angleBetweenDeg(boresightEnu(R, predPan, predTilt), sunEnu);
  return {
    separationDeg: sep,
    predictedSeparationDeg: predSep,
    tripped: sep < coneDeg || predSep < coneDeg,
  };
}

export interface ParkPlan {
  readonly kind: "direct" | "pan-detour" | "no-safe-path";
  readonly panDeg: number;
  readonly tiltDeg: number;
}

export interface ParkLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

const PARK_SAMPLE_DEG = 1.0;   // resolution when sampling a sweep for min separation
const DETOUR_MARGIN_DEG = 5.0; // extra clearance past the cone edge for a pan detour

// Minimum boresight→sun separation while sweeping ONE axis from a→b at fixed
// other-axis, inclusive of endpoints. This is the exact "does the path cross the
// sun" test, done by sampling — robust and directly testable.
function minSepAlong(
  R: Mat3, sunEnu: Vec3, axis: "pan" | "tilt", fixed: number, a: number, b: number,
): number {
  const steps = Math.max(1, Math.ceil(Math.abs(b - a) / PARK_SAMPLE_DEG));
  let min = Infinity;
  for (let i = 0; i <= steps; i++) {
    const v = a + ((b - a) * i) / steps;
    const enu = axis === "tilt" ? boresightEnu(R, fixed, v) : boresightEnu(R, v, fixed);
    min = Math.min(min, angleBetweenDeg(enu, sunEnu));
  }
  return min;
}

export function planPark(
  R: Mat3, curPanDeg: number, curTiltDeg: number,
  sunEnu: Vec3, coneDeg: number, parkTiltDeg: number,
  limits: ParkLimits,
): ParkPlan {
  const tiltTarget = Math.max(limits.tiltMin, Math.min(limits.tiltMax, parkTiltDeg));

  // 1. Direct: tilt down at the current pan. Safe iff the sweep never enters the cone.
  if (minSepAlong(R, sunEnu, "tilt", curPanDeg, curTiltDeg, tiltTarget) >= coneDeg) {
    return { kind: "direct", panDeg: curPanDeg, tiltDeg: tiltTarget };
  }

  // 2. Pan detour: swing pan clear of the sun's azimuth, then tilt down. The sun's
  // pan/tilt in user frame tells us which way and how far.
  const sunPT = enuToPanTilt(R, sunEnu);
  const clearOffset = coneDeg / Math.max(0.2, Math.cos((sunPT.tiltDeg * Math.PI) / 180)) + DETOUR_MARGIN_DEG;
  for (const cand of [sunPT.panDeg + clearOffset, sunPT.panDeg - clearOffset]) {
    // Resolve the candidate into [panMin, panMax] via ±360 like the pointing code.
    const resolved = [cand, cand - 360, cand + 360].find((p) => p >= limits.panMin && p <= limits.panMax);
    if (resolved === undefined) continue;
    const panClear = minSepAlong(R, sunEnu, "pan", curTiltDeg, curPanDeg, resolved) >= coneDeg;
    const tiltClear = minSepAlong(R, sunEnu, "tilt", resolved, curTiltDeg, tiltTarget) >= coneDeg;
    if (panClear && tiltClear) return { kind: "pan-detour", panDeg: resolved, tiltDeg: tiltTarget };
  }

  // 3. Nothing safe — refuse to move.
  return { kind: "no-safe-path", panDeg: curPanDeg, tiltDeg: curTiltDeg };
}
