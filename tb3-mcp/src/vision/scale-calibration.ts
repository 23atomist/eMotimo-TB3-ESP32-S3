const RAD = Math.PI / 180;
const MIN_COS_TILT = 0.05;
const MOVE_THRESHOLD_PX = 2;   // below this the image has not moved

export interface StepObservation { tMs: number; dxPx: number; dyPx: number }
export interface ScaleResult { focalPx: number; latencyMs: number }

export function solveStepResponse(
  obs: StepObservation[], stepAppliedAtMs: number, stepPanDeg: number, tiltDegAtStep: number,
): ScaleResult | null {
  if (obs.length < 2) return null;
  const c = Math.cos(tiltDegAtStep * RAD);
  // At the pole a pan step barely moves the boresight, so the observation
  // carries no usable scale information.
  if (Math.abs(c) < MIN_COS_TILT) return null;

  const sorted = [...obs].sort((a, b) => a.tMs - b.tMs);
  const settledPx = sorted[sorted.length - 1].dxPx;
  if (Math.abs(settledPx) < MOVE_THRESHOLD_PX) return null;

  const first = sorted.find((o) => Math.abs(o.dxPx) >= MOVE_THRESHOLD_PX);
  if (first === undefined) return null;
  const latencyMs = first.tMs - stepAppliedAtMs;
  if (latencyMs < 0) return null;   // movement before the command: clock problem

  // The TRUE angular step on an alt-az mount, not the commanded number.
  const trueAngleDeg = stepPanDeg * c;
  const focalPx = settledPx / Math.tan(trueAngleDeg * RAD);
  if (!Number.isFinite(focalPx) || focalPx <= 0) return null;
  return { focalPx, latencyMs };
}
