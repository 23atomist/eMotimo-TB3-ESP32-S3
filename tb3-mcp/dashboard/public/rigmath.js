// Boresight direction (unit vector) in ENU for a user-frame pan/tilt, matching
// the daemon's panTiltToMount: [sin(pan)cos(tilt), cos(pan)cos(tilt), sin(tilt)].
// Pure — no DOM/Three.js — so vitest can import it in Node.
export function boresightVector(panDeg, tiltDeg) {
  const p = (panDeg * Math.PI) / 180;
  const t = (tiltDeg * Math.PI) / 180;
  const ct = Math.cos(t);
  return { e: Math.sin(p) * ct, n: Math.cos(p) * ct, u: Math.sin(t) };
}

// --- rigview.js's pan/tilt -> world-frame mapping, extracted so it's testable ---
//
// rigview.js poses the schematic rig with two nested THREE.Group rotations:
// a pan turntable rotating about world +Y, carrying a tilt yoke that rotates
// about its own (turntable-local) +X. The camera body sits in the tilt group
// facing local +Z. These two functions are the *only* place those rotation
// angles are computed — rigview.js calls them rather than inlining the sign
// choices, so there is one source of truth for both the model pose and the
// boresight arrow below.
//
// panGroupRotationY: negated per the field note that the rig reports
// az = base - pan (pan handedness confirmed correct on-host 2026-07-27,
// unchanged by this fix).
export function panGroupRotationY(panDeg) {
  return (-panDeg * Math.PI) / 180;
}

// tiltGroupRotationX: negated so that positive tilt (which means "pointed up"
// on the real rig, per boresightVector's u = sin(tiltDeg) above) pitches the
// model's nose toward +Y instead of -Y. Three.js rotates a vector about +X by
// angle theta as (x,y,z) -> (x, y*cos(theta) - z*sin(theta), y*sin(theta) +
// z*cos(theta)); applied to the camera's local-forward (0,0,1) that is
// (0, -sin(theta), cos(theta)). With theta = +tiltRad (the pre-fix code),
// positive tilt gives a *negative* y — nose down — which is the reported bug.
// Negating theta fixes it: confirmed inverted and corrected in the field on
// 2026-07-27 (pan was reported reading correctly and was left alone).
export function tiltGroupRotationX(tiltDeg) {
  return (-tiltDeg * Math.PI) / 180;
}

// --- World-frame convention for the 3D rig view -----------------------------
//
// The scene is Three.js's standard right-handed, Y-up space. Composing the
// two rotations above — world = Ry(panGroupRotationY) * Rx(tiltGroupRotationX)
// * (0,0,1) — works out (see derivation below) to:
//
//     world.x = -e,  world.y = u,  world.z = n
//
// i.e. this mapping is *forced* by the rotation formulas above, not chosen
// independently: Up -> +Y, North -> +Z, East -> -X (right-handed: E x U = -N,
// so (-E) x U = N, matching X x Y = Z here). Both the model pose and the
// boresight arrow are driven from this single mapping, so they always agree
// with each other and with the real rig.
//
// Derivation: let phi = panGroupRotationY(panDeg), theta = tiltGroupRotationX(tiltDeg).
//   Rx(theta) * (0,0,1)        = (0, -sin(theta), cos(theta))
//   Ry(phi)   * (0,-sin(theta),cos(theta))
//                               = (cos(theta)*sin(phi), -sin(theta), cos(theta)*cos(phi))
// Substituting phi = -pan, theta = -tilt and e = sin(pan)cos(tilt),
// n = cos(pan)cos(tilt), u = sin(tilt) gives (-e, u, n) exactly.
export function enuToThreeJs({ e, n, u }) {
  return { x: -e, y: u, z: n };
}

// Inverse of enuToThreeJs — recovers an ENU direction from Three.js-space xyz.
export function threeJsToEnu({ x, y, z }) {
  return { e: -x, n: z, u: y };
}

// Convenience: the boresight direction directly in Three.js world space,
// i.e. what rigview.js sets the arrow's direction to.
export function boresightThreeJs(panDeg, tiltDeg) {
  return enuToThreeJs(boresightVector(panDeg, tiltDeg));
}

// The forward direction the panGroup/tiltGroup rotations above actually
// produce, computed independently via the raw rotation-matrix composition
// (not by calling enuToThreeJs). Used only in tests, to confirm the model's
// rotations and the arrow's ENU mapping stay in lockstep with each other —
// two independently-derived paths landing on the same vector is what
// "self-consistent" means here.
export function rigModelForwardThreeJs(panDeg, tiltDeg) {
  const phi = panGroupRotationY(panDeg);
  const theta = tiltGroupRotationX(tiltDeg);
  // Rx(theta) * (0,0,1)
  const rx = { x: 0, y: -Math.sin(theta), z: Math.cos(theta) };
  // Ry(phi) * rx
  return {
    x: rx.x * Math.cos(phi) + rx.z * Math.sin(phi),
    y: rx.y,
    z: -rx.x * Math.sin(phi) + rx.z * Math.cos(phi),
  };
}
