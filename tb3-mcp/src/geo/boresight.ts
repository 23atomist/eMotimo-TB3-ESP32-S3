import { Vec3, Mat3, deg2rad, rad2deg, matMul, rotX, rotZ } from "./vec3.js";

// Mount-frame boresight: pan about mount-up (+Z), tilt raises toward +Z.
// d = [sin(pan)cos(tilt), cos(pan)cos(tilt), sin(tilt)]
export function panTiltToMount(panDeg: number, tiltDeg: number): Vec3 {
  const p = deg2rad(panDeg);
  const t = deg2rad(tiltDeg);
  const ct = Math.cos(t);
  return [Math.sin(p) * ct, Math.cos(p) * ct, Math.sin(t)];
}

export function mountToPanTilt(v: Vec3): { panDeg: number; tiltDeg: number } {
  const z = Math.max(-1, Math.min(1, v[2]));
  const tiltDeg = rad2deg(Math.asin(z));
  const panDeg = rad2deg(Math.atan2(v[0], v[1]));
  return { panDeg, tiltDeg };
}

// Full head-in-mount rotation: pan about mount-up (+Z), tilt about mount-X.
// M(pan,tilt) = Rz(-pan)·Rx(tilt).  M·[0,1,0] == panTiltToMount(pan,tilt).
export function mountHeadRotation(panDeg: number, tiltDeg: number): Mat3 {
  return matMul(rotZ(deg2rad(-panDeg)), rotX(deg2rad(tiltDeg)));
}
