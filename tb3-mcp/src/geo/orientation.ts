import {
  Vec3, Mat3, normalize, cross, matFromColumns, matMul, transpose, matVec, angleBetweenDeg,
} from "./vec3.js";
import { mountToPanTilt } from "./boresight.js";

// TRIAD: build an orthonormal triad from each vector pair and align them.
// Returns R mapping mount-frame -> ENU-frame.
export function solveOrientation(mountA: Vec3, enuA: Vec3, mountB: Vec3, enuB: Vec3): Mat3 {
  const t1 = normalize(mountA);
  const t2 = normalize(cross(mountA, mountB));
  const t3 = cross(t1, t2);
  const M = matFromColumns(t1, t2, t3);

  const w1 = normalize(enuA);
  const w2 = normalize(cross(enuA, enuB));
  const w3 = cross(w1, w2);
  const W = matFromColumns(w1, w2, w3);

  return matMul(W, transpose(M)); // R = W · Mᵀ
}

// Apply Rᵀ (ENU->mount) to a target ENU unit vector, then invert the boresight.
export function enuToPanTilt(R: Mat3, enuUnit: Vec3): { panDeg: number; tiltDeg: number } {
  const mount = matVec(transpose(R), enuUnit);
  return mountToPanTilt(mount);
}

export function separationDeg(enuA: Vec3, enuB: Vec3): number {
  return angleBetweenDeg(enuA, enuB);
}

// Try pan, pan-360, pan+360; return the first within [min,max], else null.
export function resolvePanInRange(panDeg: number, panMin: number, panMax: number): number | null {
  for (const cand of [panDeg, panDeg - 360, panDeg + 360]) {
    if (cand >= panMin && cand <= panMax) return cand;
  }
  return null;
}
