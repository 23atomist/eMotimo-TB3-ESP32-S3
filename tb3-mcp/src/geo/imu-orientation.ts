import { Vec3, Mat3, matVec, transpose, normalize, dot, rad2deg } from "./vec3.js";
import { mountHeadRotation } from "./boresight.js";
import { wahbaRotation } from "./wahba.js";

export interface GravitySample { panDeg: number; tiltDeg: number; gravity: Vec3; }
export interface ImuMounting { rS: Mat3; dBase: Vec3; residualsDeg: number[]; rmsDeg: number; }

// The model: M(gp·pan, tilt)·R_s·g_s = d_base  (constant across all samples),
// where g_s is the normalized sensor-frame gravity. Alternate:
//   given d_base, target wᵢ = normalize(Mᵢᵀ·d_base); R_s = wahba(g_s → w);
//   update d_base = normalize(mean_i Mᵢ·R_s·g_sᵢ). Iterate to a fixpoint.
function angleDeg(a: Vec3, b: Vec3): number {
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))));
}

export function solveImuMounting(samples: GravitySample[], geoPanSign: number): ImuMounting {
  if (samples.length < 4) throw new Error("solveImuMounting: need ≥4 samples spanning pan and tilt");
  const Ms = samples.map((s) => mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg));
  const gs = samples.map((s) => normalize(s.gravity));

  const fitRs = (dBase: Vec3): Mat3 => {
    const w = Ms.map((M) => normalize(matVec(transpose(M), dBase)));
    return wahbaRotation(gs, w);
  };

  let dBase: Vec3 = [0, 0, -1];
  let rS = fitRs(dBase);
  for (let it = 0; it < 500; it++) {
    rS = fitRs(dBase);
    const acc: number[] = [0, 0, 0];
    for (let i = 0; i < samples.length; i++) {
      const v = matVec(Ms[i], matVec(rS, gs[i]));
      acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2];
    }
    const nv = normalize([acc[0], acc[1], acc[2]]);
    const moved = angleDeg(nv, dBase);
    dBase = nv;
    if (moved < 1e-9) break;
  }
  rS = fitRs(dBase);
  const residualsDeg = samples.map((_, i) => angleDeg(matVec(rS, gs[i]), normalize(matVec(transpose(Ms[i]), dBase))));
  const rmsDeg = Math.sqrt(residualsDeg.reduce((a, b) => a + b * b, 0) / residualsDeg.length);
  return { rS, dBase, residualsDeg, rmsDeg };
}
