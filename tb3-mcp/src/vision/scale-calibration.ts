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
export interface ScaleResult {
  focalPx: number;      // always positive magnitude
  latencyMs: number;
  axisSign: 1 | -1;     // sign of (pixel displacement) / (commanded angle) on the stepped axis
}

// Which pixel axis the step was commanded on. Only "pan" gets the cos(tilt)
// foreshortening (an alt-az pan rotation is scaled by cos(tilt); tilt moves
// the boresight 1:1 regardless of pan) and only "pan" is degenerate at the
// pole -- a tilt step conveys full scale information there.
export type StepAxis = "pan" | "tilt";

export function solveStepResponse(
  obs: StepObservation[], stepAppliedAtMs: number, stepDeg: number, tiltDegAtStep: number,
  axis: StepAxis = "pan",
): ScaleResult | null {
  if (obs.length < 2) return null;
  const c = Math.cos(tiltDegAtStep * RAD);
  // At the pole a pan step barely moves the boresight, so the observation
  // carries no usable scale information. Does not apply to a tilt step.
  if (axis === "pan" && Math.abs(c) < MIN_COS_TILT) return null;

  const sorted = [...obs].sort((a, b) => a.tMs - b.tMs);
  const pxOf = (o: StepObservation) => (axis === "pan" ? o.dxPx : o.dyPx);

  // Pre-step baseline: the mean of whatever samples arrived STRICTLY BEFORE
  // the command (tMs < stepAppliedAtMs). Everything below measures
  // displacement FROM this baseline, never the absolute offset from frame
  // centre -- an aircraft sitting off-centre before the step is not "the
  // step happening", and without this the very first sample could already
  // exceed MOVE_THRESHOLD_PX, anchoring latency at ~0 and inflating focalPx.
  // Defaults to 0 (frame centre) when no pre-step sample is present, which
  // is exactly the old behaviour for every fixture that starts its
  // observations AT the step (stepAppliedAtMs <= every tMs).
  const before = sorted.filter((o) => o.tMs < stepAppliedAtMs);
  const baseline = before.length > 0
    ? before.reduce((sum, o) => sum + pxOf(o), 0) / before.length
    : 0;
  const disp = (o: StepObservation) => pxOf(o) - baseline;

  const settled = disp(sorted[sorted.length - 1]);
  if (Math.abs(settled) < MOVE_THRESHOLD_PX) return null;

  // First index from which the threshold stays crossed for MOVE_CONFIRM_SAMPLES
  // consecutive samples (or to the end of the record, whichever comes first).
  // Thresholded on displacement FROM BASELINE, not the absolute pixel value.
  let firstIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (Math.abs(disp(sorted[i])) < MOVE_THRESHOLD_PX) continue;
    let run = 0;
    while (i + run < sorted.length && Math.abs(disp(sorted[i + run])) >= MOVE_THRESHOLD_PX) run++;
    if (run >= MOVE_CONFIRM_SAMPLES || i + run >= sorted.length) { firstIdx = i; break; }
    i += run;   // a blip: skip past it and keep looking
  }
  if (firstIdx < 0) return null;
  const latencyMs = sorted[firstIdx].tMs - stepAppliedAtMs;
  if (latencyMs < 0) return null;   // movement before the command: clock problem

  // The TRUE angular step on an alt-az mount, not the commanded number.
  const trueAngleDeg = axis === "pan" ? stepDeg * c : stepDeg;
  // SIGNED. A camera panning +Δ sees a fixed distant object move LEFT
  // (negative dxPx) on a normally-mounted, non-mirrored rig -- so
  // signedFocal is the NEGATIVE, EXPECTED answer there, not a failure.
  // Mounting, mirroring, and panSign/tiltSign config can each flip this, and
  // this step response is precisely how that handedness gets MEASURED
  // instead of assumed. Refuse only on "nothing moved" (above) or a
  // non-finite/zero result -- never on sign.
  const signedFocal = settled / Math.tan(trueAngleDeg * RAD);
  const focalPx = Math.abs(signedFocal);
  if (!Number.isFinite(focalPx) || focalPx === 0) return null;
  const axisSign: 1 | -1 = signedFocal < 0 ? -1 : 1;
  return { focalPx, latencyMs, axisSign };
}
