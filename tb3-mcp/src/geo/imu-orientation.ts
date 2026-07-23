import { Vec3, Mat3, matVec, transpose, normalize, dot, rad2deg, matMul, cross, rotZ, deg2rad } from "./vec3.js";
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

export interface GravitySighting { panDeg: number; tiltDeg: number; enuUnit: Vec3; elevationDeg: number; }
export interface GravityCalibration { R: Mat3; cHead: Vec3; headingResidualDeg: number; }

// Rotation aligning unit a → unit b (Rodrigues); used to build R0 from gravity.
function rotAlign(a: Vec3, b: Vec3): Mat3 {
  const an = normalize(a), bn = normalize(b);
  const v = cross(an, bn);
  const c = dot(an, bn);
  const s = Math.hypot(v[0], v[1], v[2]);
  if (s < 1e-12) {
    if (c > 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // 180°: rotate about any axis ⟂ a.
    const axis = Math.abs(an[0]) < 0.9 ? cross(an, [1, 0, 0]) : cross(an, [0, 1, 0]);
    const u = normalize(axis);
    return [
      [2 * u[0] * u[0] - 1, 2 * u[0] * u[1], 2 * u[0] * u[2]],
      [2 * u[1] * u[0], 2 * u[1] * u[1] - 1, 2 * u[1] * u[2]],
      [2 * u[2] * u[0], 2 * u[2] * u[1], 2 * u[2] * u[2] - 1],
    ];
  }
  const vx: Mat3 = [[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]];
  const k = (1 - c) / (s * s);
  const vx2 = matMul(vx, vx);
  return [
    [1 + vx[0][0] + k * vx2[0][0], vx[0][1] + k * vx2[0][1], vx[0][2] + k * vx2[0][2]],
    [vx[1][0] + k * vx2[1][0], 1 + vx[1][1] + k * vx2[1][1], vx[1][2] + k * vx2[1][2]],
    [vx[2][0] + k * vx2[2][0], vx[2][1] + k * vx2[2][1], 1 + vx[2][2] + k * vx2[2][2]],
  ];
}

// Forward boresight in ENU for a user-frame pan/tilt (offset-aware).
export function boresightToEnu(R: Mat3, cHead: Vec3, geoPanSign: number, panDeg: number, tiltDeg: number): Vec3 {
  return matVec(matMul(R, mountHeadRotation(geoPanSign * panDeg, tiltDeg)), cHead);
}

export function solveCalibrationWithGravity(
  dBase: Vec3, sightings: [GravitySighting, GravitySighting], geoPanSign: number,
): GravityCalibration {
  const R0 = rotAlign([-dBase[0], -dBase[1], -dBase[2]], [0, 0, 1]); // R = Rz(heading)·R0
  const rows: Vec3[] = [];
  const sel: number[] = [];
  for (const s of sightings) {
    const M = mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg);
    const R0M = matMul(R0, M);
    rows.push([R0M[2][0], R0M[2][1], R0M[2][2]]); // z-row: (R0·M·c)_z is linear in c
    sel.push(Math.sin(deg2rad(s.elevationDeg)));
  }
  // Minimum-norm solution c0 of N·c = sel (N is 2×3): c0 = Nᵀ(N Nᵀ)⁻¹ sel.
  const N = rows;
  const nnt: [[number, number], [number, number]] = [
    [dot(N[0], N[0]), dot(N[0], N[1])],
    [dot(N[1], N[0]), dot(N[1], N[1])],
  ];
  const det = nnt[0][0] * nnt[1][1] - nnt[0][1] * nnt[1][0];
  const inv: [[number, number], [number, number]] = [
    [nnt[1][1] / det, -nnt[0][1] / det],
    [-nnt[1][0] / det, nnt[0][0] / det],
  ];
  const y = [inv[0][0] * sel[0] + inv[0][1] * sel[1], inv[1][0] * sel[0] + inv[1][1] * sel[1]];
  const c0: Vec3 = [
    N[0][0] * y[0] + N[1][0] * y[1],
    N[0][1] * y[0] + N[1][1] * y[1],
    N[0][2] * y[0] + N[1][2] * y[1],
  ];
  const nz = normalize(cross(N[0], N[1])); // null direction: c = c0 + t·nz on the unit sphere
  const disc = 1 - dot(c0, c0);
  if (disc < 0) throw new Error("solveCalibrationWithGravity: no real c_head (|c0|>1) — degenerate sightings");
  const roots = [Math.sqrt(disc), -Math.sqrt(disc)];
  const candidates = roots.map((t) => {
    const c: Vec3 = [c0[0] + t * nz[0], c0[1] + t * nz[1], c0[2] + t * nz[2]];
    // per-landmark heading = az(enu) − az(R0·M·c); average, and measure disagreement.
    const hs = sightings.map((s) => {
      const p = matVec(matMul(R0, mountHeadRotation(geoPanSign * s.panDeg, s.tiltDeg)), c);
      const azp = rad2deg(Math.atan2(p[0], p[1]));
      const azw = rad2deg(Math.atan2(s.enuUnit[0], s.enuUnit[1]));
      return ((azp - azw) % 360 + 360) % 360;
    });
    const dh = Math.abs(((hs[0] - hs[1] + 180) % 360 + 360) % 360 - 180);
    const hz = ((rad2deg(Math.atan2(
      hs.reduce((a, h) => a + Math.sin(deg2rad(h)), 0),
      hs.reduce((a, h) => a + Math.cos(deg2rad(h)), 0),
    )) % 360) + 360) % 360;
    const R = matMul(rotZ(deg2rad(hz)), R0);
    return { c, R, dh };
  });
  // Disambiguate: prefer the physical branch (camera forward: c·+Y > 0), then best heading agreement.
  const physical = candidates.filter((k) => k.c[1] > 0);
  const pool = physical.length ? physical : candidates;
  const best = pool.reduce((a, b) => (b.dh < a.dh ? b : a));
  return { R: best.R, cHead: best.c, headingResidualDeg: best.dh };
}
