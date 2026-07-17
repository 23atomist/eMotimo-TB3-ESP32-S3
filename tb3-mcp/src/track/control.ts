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

// --- Firmware deceleration model -------------------------------------------
// All four constants below are read off updateMotorVelocities2()
// (src/TB3_Nunchuck.ino), which owns the rig's velocity accumulator.

// The velocity engine's cycle: "Happens 20 times a second".
const FW_CYCLE_MS = 50;

// Per-cycle accumulator ramp limit: accelmax0/1 = (65535/20)/1.0, i.e. sized so
// zero->full takes ~1s. This is the ONLY thing bounding how fast a commanded
// rate change is honoured, in either direction -- decel is not special-cased.
const FW_ACCEL_PER_CYCLE = 65535 / 20;

// Accumulator value at full deflection. The firmware cubes the deflection
// (joy^3/10000) then scales by 655.3 * motormax, where
// motormax = PAN_MAX_JOG_STEPS_PER_SEC/20000 = 10000/20000
// (TB3_Black_109_Release1.ino:227). At |joy| = JOY_SPAN this is ~28092, and
// that accumulator value is what the measured maxJogDps plateau corresponds to.
const FW_ACCUM_SCALE = 655.3;
const FW_MOTORMAX = 10000 / 20000;
const FW_FULL_SCALE_ACCUM = (Math.pow(JOY_SPAN, 3) / 10000) * FW_ACCUM_SCALE * FW_MOTORMAX;

/**
 * How long the rig takes to ramp a standing rate back down to zero, in ms.
 *
 * The accumulator moves at most FW_ACCEL_PER_CYCLE per 50ms cycle, and
 * FW_FULL_SCALE_ACCUM of accumulator == maxJogDps of rate, so the rig sheds
 * ~2.22 deg/s per cycle at the default 19 deg/s plateau => ~450ms from full
 * rate. Scales with the commanded rate: a slow rate stops almost immediately,
 * which is exactly why the limit guard's horizon is computed rather than fixed.
 */
export function decelMs(rateDps: number, maxJogDps: number): number {
  const dpsPerCycle = maxJogDps * (FW_ACCEL_PER_CYCLE / FW_FULL_SCALE_ACCUM);
  if (!(dpsPerCycle > 0) || !Number.isFinite(rateDps)) return 0;
  return Math.ceil(Math.abs(rateDps) / dpsPerCycle) * FW_CYCLE_MS;
}

/**
 * How far ahead the limit guard must predict, in ms, for ONE axis.
 *
 * This was a flat 3 ticks (300ms). That is shorter than the rig's real stopping
 * distance, and the shortfall is invisible in simulation because the mock
 * pushes telemetry 4x faster than the rig and stops dead instead of ramping.
 * Every term below is a real delay between "the rig is here" and "the rig has
 * actually stopped", so the guard has to cover their sum:
 *
 *   telemetryAgeMs  the reading is already this old (the rig pushes at 5Hz --
 *                   src/tb3_web.cpp -- so up to 200ms, not the mock's 50ms)
 *   tickPeriodMs    nothing re-evaluates until the next tick
 *   decelMs(rate)   the firmware ramps the rate down, ~450ms from saturation
 *
 * Computed rather than a bigger constant on purpose: decelMs scales with the
 * commanded rate, so this spends ~14deg of lookahead only when actually
 * saturated and next to nothing when creeping. A constant sized for the worst
 * case would surrender that travel at every rate.
 */
export function limitHorizonMs(
  rateDps: number, telemetryAgeMs: number, tickPeriodMs: number, maxJogDps: number,
): number {
  return Math.max(0, telemetryAgeMs) + tickPeriodMs + decelMs(rateDps, maxJogDps);
}

export interface GuardLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

/** Per-axis lookahead. Each axis decelerates on its own rate, so each gets its own. */
export interface GuardHorizon {
  readonly panMs: number;
  readonly tiltMs: number;
}

// The jog path does NOT enforce soft limits and the rig has no endstops, so the
// session must. Check the PREDICTED position over the horizon, not the current
// one: by the time we are outside, it is already too late.
//
// Predicting at the FULL commanded rate for the whole horizon deliberately
// over-estimates the stopping distance (the real decel ramp averages about half
// the rate). On a rig with no endstops, erring long is the correct direction.
export function limitGuard(
  out: ControlOutput, rigPanDeg: number, rigTiltDeg: number,
  limits: GuardLimits, horizon: GuardHorizon,
): { out: ControlOutput; panBlocked: boolean; tiltBlocked: boolean } {
  const predPan = rigPanDeg + out.panDps * (horizon.panMs / 1000);
  const predTilt = rigTiltDeg + out.tiltDps * (horizon.tiltMs / 1000);
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
