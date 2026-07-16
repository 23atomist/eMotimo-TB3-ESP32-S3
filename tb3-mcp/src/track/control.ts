import { Vec3, Mat3, matVec, norm, normalize } from "../geo/vec3.js";
import { panTiltToMount } from "../geo/boresight.js";
import { enuToPanTilt } from "../geo/orientation.js";
import { EstimatorState, estimateAt } from "./estimator.js";

// Feedforward finite-difference step. The position extrapolation is exact
// (linear), but pan/tilt are nonlinear functions (atan2/asin), so the
// finite difference is a first-order approximation. Error is negligibly
// small at Δt=10ms relative to realistic target dynamics. The estimate is
// a smooth analytic function (not a sensor), so there is no measurement
// noise to amplify.
const FF_DELTA_MS = 10;

// Below this range the pointing direction is undefined.
const MIN_RANGE_M = 1e-3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Wrap to (-180, 180] so errors always take the short way round.
export function wrapDeg180(d: number): number {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

// Where the rig is actually pointing, as an ENU unit vector. R maps mount->ENU.
export function boresightEnu(R: Mat3, panDeg: number, tiltDeg: number): Vec3 {
  return matVec(R, panTiltToMount(panDeg, tiltDeg));
}

export interface TargetAim {
  readonly panDeg: number;      // user frame
  readonly tiltDeg: number;     // user frame
  readonly ratePanDps: number;  // feedforward
  readonly rateTiltDps: number; // feedforward
  readonly enuUnit: Vec3;
  readonly rangeM: number;
}

// Where the target is at tMs, and how fast that aim point is moving.
export function targetAimAt(s: EstimatorState, R: Mat3, tMs: number): TargetAim | null {
  const p0 = estimateAt(s, tMs);
  const p1 = estimateAt(s, tMs + FF_DELTA_MS);
  if (!p0 || !p1) return null;
  const rangeM = norm(p0);
  if (rangeM < MIN_RANGE_M) return null;
  const u0 = normalize(p0);
  const a = enuToPanTilt(R, u0);
  const b = enuToPanTilt(R, normalize(p1));
  const dtSec = FF_DELTA_MS / 1000;
  return {
    panDeg: a.panDeg,
    tiltDeg: a.tiltDeg,
    ratePanDps: wrapDeg180(b.panDeg - a.panDeg) / dtSec,
    rateTiltDps: (b.tiltDeg - a.tiltDeg) / dtSec,
    enuUnit: u0,
    rangeM,
  };
}

export interface ControlOutput {
  readonly panDps: number;
  readonly tiltDps: number;
}

// rate = feedforward + Kp * error, clamped. P only — feedforward does the
// heavy lifting, so an integral term would fight it and wind up at the limits.
export function controlRate(
  aim: Pick<TargetAim, "panDeg" | "tiltDeg" | "ratePanDps" | "rateTiltDps">,
  rigPanDeg: number, rigTiltDeg: number, kp: number, maxJogDps: number,
): ControlOutput {
  const errPan = wrapDeg180(aim.panDeg - rigPanDeg);
  const errTilt = aim.tiltDeg - rigTiltDeg;   // tilt is bounded, it never wraps
  return {
    panDps: clamp(aim.ratePanDps + kp * errPan, -maxJogDps, maxJogDps),
    tiltDps: clamp(aim.rateTiltDps + kp * errTilt, -maxJogDps, maxJogDps),
  };
}

// Deflection units the firmware's cubic curve maps to full rate: |x|=100
// minus the deadband offset of 5.
const JOY_SPAN = 95;
const JOY_DEADBAND = 5;

// Convert a desired rate (deg/s, already sign-corrected for the axis) into a
// joystick deflection, inverting the firmware's cubic curve.
//
// Layer 1's `jog` tool maps this LINEARLY on purpose -- it is a human-in-the-
// loop framing nudge where "approximately" is fine. The servo has no such
// luxury: feedforward IS the design, so its mapping must match the hardware.
export function rateToDeflection(dps: number, maxJogDps: number): number {
  const f = Math.min(Math.abs(dps) / maxJogDps, 1);
  if (f <= 0) return 0;
  const joyDb = JOY_SPAN * Math.cbrt(f);
  const x = Math.round(joyDb + JOY_DEADBAND);
  return Math.sign(dps) * Math.min(x, 100);
}

export interface GuardLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

// The jog path does NOT enforce soft limits and the rig has no endstops, so the
// session must. Check the PREDICTED position over `horizonMs`, not the current
// one: by the time we are outside, it is already too late.
export function limitGuard(
  out: ControlOutput, rigPanDeg: number, rigTiltDeg: number,
  limits: GuardLimits, horizonMs: number,
): { out: ControlOutput; panBlocked: boolean; tiltBlocked: boolean } {
  const h = horizonMs / 1000;
  const predPan = rigPanDeg + out.panDps * h;
  const predTilt = rigTiltDeg + out.tiltDps * h;
  const panBlocked = predPan > limits.panMax || predPan < limits.panMin;
  const tiltBlocked = predTilt > limits.tiltMax || predTilt < limits.tiltMin;
  return {
    out: {
      panDps: panBlocked ? 0 : out.panDps,
      tiltDps: tiltBlocked ? 0 : out.tiltDps,
    },
    panBlocked,
    tiltBlocked,
  };
}
