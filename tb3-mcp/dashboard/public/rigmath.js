// Boresight direction (unit vector) in ENU for a user-frame pan/tilt, matching
// the daemon's panTiltToMount: [sin(pan)cos(tilt), cos(pan)cos(tilt), sin(tilt)].
// Pure — no DOM/Three.js — so vitest can import it in Node.
export function boresightVector(panDeg, tiltDeg) {
  const p = (panDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const ct = Math.cos(t);
  return { e: Math.sin(p) * ct, n: Math.cos(p) * ct, u: Math.sin(t) };
}
