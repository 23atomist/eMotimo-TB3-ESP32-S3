export interface PixelOffset { dxPx: number; dyPx: number }
export interface AngularError { panDeg: number; tiltDeg: number }

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Below this the pan axis is degenerate: near the pole a pan rotation barely
// moves the boresight, so a horizontal pixel error implies an unbounded pan
// correction. Refuse instead.
const MIN_COS_TILT = 0.05; // ~87.1deg

export function focalPxFromFov(widthPx: number, hfovDeg: number): number {
  return (widthPx / 2) / Math.tan((hfovDeg * RAD) / 2);
}

export function fovDegFromFocalPx(sizePx: number, focalPx: number): number {
  return 2 * Math.atan((sizePx / 2) / focalPx) * DEG;
}

// Per-axis handedness between "a pixel moved this way" and "the correction
// that closes it." NOT something to guess: mounting, mirroring, and
// panSign/tiltSign config can each flip either axis independently, and
// calibrate_vision_scale's step response MEASURES this directly (see
// vision/scale-calibration.ts's axisSign) rather than assuming it. The
// NOMINAL default (both +1) is what every pre-existing test on this branch
// was written against, so leaving it as the default parameter keeps every
// one of them passing unchanged -- it is a fallback for "not yet measured",
// never a claim about what a real camera actually does.
export interface AxisSigns { pan: 1 | -1; tilt: 1 | -1 }
export const NOMINAL_AXIS_SIGNS: AxisSigns = { pan: 1, tilt: 1 };

export function pixelToAngularError(
  off: PixelOffset, focalPx: number, tiltDeg: number,
  signs: AxisSigns = NOMINAL_AXIS_SIGNS,
): AngularError {
  // A detection at dxPx > 0 (aircraft right of centre in the image) needs a
  // pan correction that moves the boresight right too -- but whether that is
  // +pan or -pan in this rig's own commanded-angle convention depends on the
  // MEASURED axisSign for this mount (a camera panning +Δ sees a fixed
  // object move -Δ in the image on a normal mount, but a mirrored capture
  // path or an inverted panSign flips it). Same reasoning for tiltDeg against
  // app.py's y-down-positive image convention.
  const tiltErr = signs.tilt * Math.atan(off.dyPx / focalPx) * DEG;
  const c = Math.cos(tiltDeg * RAD);
  // Alt-az: a pan of dPan moves the boresight by ~dPan*cos(tilt). Recovering
  // pan from a horizontal pixel error therefore DIVIDES by cos(tilt).
  const panErr = Math.abs(c) < MIN_COS_TILT ? 0 : (signs.pan * Math.atan(off.dxPx / focalPx) * DEG) / c;
  return { panDeg: panErr, tiltDeg: tiltErr };
}
