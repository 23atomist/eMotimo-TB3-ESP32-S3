import { Vec3, deg2rad, rad2deg } from "./vec3.js";

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
