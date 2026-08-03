// Reboot re-zero: recovering a lost step origin without recalibrating.
//
// The firmware does not persist step position, so every power cycle (and every
// OTA flash, which reboots the ESP32) moves the origin while the tripod, the
// camera on the head and the IMU on the mount all stay put. That perturbation
// is exactly two scalars, and it folds into the existing calibration rather
// than invalidating it.
import {
  Mat3, Vec3, rotX, matMul, matVec, deg2rad, angleBetweenDeg, normalize,
} from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { dBaseFromGravity } from "./imu-orientation.js";

// Above this the "only the origin moved" assumption is false -- the tripod was
// disturbed, or rS is stale. Applying an offset then would bake in a wrong
// answer that looks precise, so callers must fall back to full recalibration.
export const MAX_TILT_RESIDUAL_DEG = 3.0;
export const MAX_PAN_RESIDUAL_DEG = 3.0;

// boresight = R · M(gp·pan, tilt) · cHead, with
// M(pan,tilt) = mountHeadRotation = rotZ(-pan)·rotX(tilt)  -- note the NEGATIVE pan.
//
// Rotations about a shared axis commute, so
//   M(gp·(pan+d), tilt) = rotZ(-gp·d) · M(gp·pan, tilt)
// and rotZ(-gp·d) is exactly mountHeadRotation(gp·d, 0). Left-multiplying by R:
export function applyPanOffset(R: Mat3, deltaPanDeg: number, geoPanSign: number): Mat3 {
  return matMul(R, mountHeadRotation(geoPanSign * deltaPanDeg, 0));
}

// Rx(tilt+d) = Rx(tilt)·Rx(d), and that trailing factor sits immediately left
// of cHead, so the tilt offset is absorbed by the boresight vector itself.
export function applyTiltOffset(cHead: Vec3, deltaTiltDeg: number): Vec3 {
  return normalize(matVec(rotX(deg2rad(deltaTiltDeg)), cHead));
}

// Coarse sweep then golden-section refine. The objective is the angle between a
// fixed vector and one rotated about a single axis, so it has one minimum over
// the interval; the coarse pass exists only to land inside the right basin.
function minimise(f: (x: number) => number, lo: number, hi: number, coarseStep: number):
  { x: number; f: number } {
  let bx = lo, bf = f(lo);
  for (let x = lo + coarseStep; x <= hi; x += coarseStep) {
    const v = f(x);
    if (v < bf) { bf = v; bx = x; }
  }
  let a = bx - coarseStep, b = bx + coarseStep;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < 80 && b - a > 1e-4; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
  }
  const x = (a + b) / 2;
  return { x, f: f(x) };
}

// Delta-tilt from ONE gravity read. Needs no operator action: gravity is
// absolute, and rS/dBase are still valid because neither the sensor nor the
// tripod moved. dBase lies almost along the pan axis, so this is nearly
// independent of any pan-origin error -- see the decoupling test.
export function solveTiltOffset(
  rS: Mat3, dBaseStored: Vec3, panDeg: number, tiltDeg: number,
  gravity: Vec3, geoPanSign: number,
): { deltaTiltDeg: number; residualDeg: number } {
  const f = (d: number) =>
    angleBetweenDeg(dBaseFromGravity(rS, panDeg, tiltDeg + d, gravity, geoPanSign), dBaseStored);
  const { x, f: r } = minimise(f, -90, 90, 1);
  return { deltaTiltDeg: x, residualDeg: r };
}

// Delta-pan from a reference of known ENU direction, centred by the operator.
// Callers MUST pass a tiltDeg already corrected by deltaTilt, so this is
// genuinely one unknown.
export function solvePanOffset(
  R: Mat3, cHead: Vec3, geoPanSign: number,
  refEnu: Vec3, panDeg: number, tiltDeg: number,
): { deltaPanDeg: number; residualDeg: number } {
  const f = (d: number) => {
    const b = matVec(matMul(applyPanOffset(R, d, geoPanSign),
                            mountHeadRotation(geoPanSign * panDeg, tiltDeg)), cHead);
    return angleBetweenDeg(b, refEnu);
  };
  const { x, f: r } = minimise(f, -180, 180, 1);
  return { deltaPanDeg: x, residualDeg: r };
}
