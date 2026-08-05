const RAD = Math.PI / 180;
const MIN_COS_TILT = 0.05;
const MOVE_THRESHOLD_PX = 2;   // below this the image has not moved
// A single sample over threshold is not a step edge. Detector centroid jitter
// and JPEG artefacts routinely produce 2-3px blips, and anchoring the latency
// to one of them yields a latency far too small -- which feeds
// exposureMs = arrivedMs - latencyMs() and understamps every frame, exactly
// the pointing-lag class this whole feature exists to remove. Require the
// crossing to STAY crossed.
const MOVE_CONFIRM_SAMPLES = 3;

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

  // First index from which the threshold stays crossed for MOVE_CONFIRM_SAMPLES
  // consecutive samples (or to the end of the record, whichever comes first).
  let firstIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(sorted[i].dxPx) < MOVE_THRESHOLD_PX) continue;
    let run = 0;
    while (i + run < sorted.length && Math.abs(sorted[i + run].dxPx) >= MOVE_THRESHOLD_PX) run++;
    if (run >= MOVE_CONFIRM_SAMPLES || i + run >= sorted.length) { firstIdx = i; break; }
    i += run;   // a blip: skip past it and keep looking
  }
  if (firstIdx < 0) return null;
  const latencyMs = sorted[firstIdx].tMs - stepAppliedAtMs;
  if (latencyMs < 0) return null;   // movement before the command: clock problem

  // The TRUE angular step on an alt-az mount, not the commanded number.
  const trueAngleDeg = stepPanDeg * c;
  const focalPx = settledPx / Math.tan(trueAngleDeg * RAD);
  if (!Number.isFinite(focalPx) || focalPx <= 0) return null;
  return { focalPx, latencyMs };
}
