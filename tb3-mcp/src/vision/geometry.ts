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

export function pixelToAngularError(off: PixelOffset, focalPx: number, tiltDeg: number): AngularError {
  const tiltErr = Math.atan(off.dyPx / focalPx) * DEG;
  const c = Math.cos(tiltDeg * RAD);
  // Alt-az: a pan of dPan moves the boresight by ~dPan*cos(tilt). Recovering
  // pan from a horizontal pixel error therefore DIVIDES by cos(tilt).
  const panErr = Math.abs(c) < MIN_COS_TILT ? 0 : (Math.atan(off.dxPx / focalPx) * DEG) / c;
  return { panDeg: panErr, tiltDeg: tiltErr };
}
