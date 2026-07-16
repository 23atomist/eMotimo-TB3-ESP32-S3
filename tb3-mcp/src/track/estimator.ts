import { Vec3, add, sub, scale, deg2rad } from "../geo/vec3.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";

export interface EnuFix {
  readonly enu: Vec3;   // meters, relative to the rig
  readonly tMs: number;
}

export interface EstimatorState {
  readonly fix: EnuFix | null;
  readonly prevFix: EnuFix | null;
  readonly statedVel: Vec3 | null;  // ENU m/s
}

export function emptyEstimator(): EstimatorState {
  return { fix: null, prevFix: null, statedVel: null };
}

// Aviation-natural velocity -> ENU. Heading 0 = North, 90 = East.
export function velocityFromSpeedHeading(speedMps: number, headingDeg: number, climbMps: number): Vec3 {
  const h = deg2rad(headingDeg);
  return [speedMps * Math.sin(h), speedMps * Math.cos(h), climbMps];
}

export function withFix(
  s: EstimatorState, rig: Geodetic, g: Geodetic, tMs: number, statedVel: Vec3 | null,
): EstimatorState {
  return { fix: { enu: enuPosition(rig, g), tMs }, prevFix: s.fix, statedVel };
}

export function velocityOf(s: EstimatorState): Vec3 {
  if (s.statedVel) return s.statedVel;
  if (s.fix && s.prevFix) {
    const dtSec = (s.fix.tMs - s.prevFix.tMs) / 1000;
    if (dtSec > 0) return scale(sub(s.fix.enu, s.prevFix.enu), 1 / dtSec);
  }
  return [0, 0, 0];
}

// Constant-velocity extrapolation in the rig's ENU frame. Straight-line ENU is
// an excellent model here: a 300mph target over a 10s horizon covers ~1.3km,
// across which earth curvature drops ~0.13m — far below achievable pointing.
export function estimateAt(s: EstimatorState, tMs: number): Vec3 | null {
  if (!s.fix) return null;
  const dtSec = (tMs - s.fix.tMs) / 1000;
  return add(s.fix.enu, scale(velocityOf(s), dtSec));
}

export function lastFixMs(s: EstimatorState): number | null {
  return s.fix?.tMs ?? null;
}
