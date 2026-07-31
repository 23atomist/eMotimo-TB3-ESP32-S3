import { Vec3, Mat3, matVec, transpose, normalize, dot, rad2deg, matMul, cross, rotZ, rotX, deg2rad } from "./vec3.js";
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

// Base-frame down vector from ONE gravity read at a known posture: d_base =
// normalize(M(gp·pan,tilt)·R_s·g_s). Constant across postures for a fixed tripod.
export function dBaseFromGravity(rS: Mat3, panDeg: number, tiltDeg: number, gravity: Vec3, geoPanSign: number): Vec3 {
  const M = mountHeadRotation(geoPanSign * panDeg, tiltDeg);
  return normalize(matVec(matMul(M, rS), normalize(gravity)));
}

export interface GravitySighting { panDeg: number; tiltDeg: number; enuUnit: Vec3; elevationDeg: number; }
export interface GravityCalibration {
  R: Mat3; cHead: Vec3; headingResidualDeg: number;
  // How far the tripod base is from level, degrees. Surfaced because it is
  // the dominant term in whether this solve is well conditioned, and it was
  // completely invisible to the operator before.
  baseLeanDeg: number;
  // >0 when the elevation constraints admitted no exact unit boresight and
  // the nearest one was used instead. Pair it with headingResidualDeg: small
  // means "fine, the base tilt just cost some conditioning".
  infeasibleBy: number;
}

// set_north_zero: build a complete but PROVISIONAL orientation from just the
// IMU's gravity fix (level+roll, R0 below) plus a DECLARED heading at the
// CURRENT posture -- the operator asserts "I am pointed at true north,
// level" instead of providing a real sighting. Unlike
// solveCalibrationWithGravity there is only one (assumed, not measured)
// direction and no second sighting to solve c_head from, so c_head stays the
// same no-offset default every pre-gravity-cHead caller already uses
// ([0,1,0]) -- this is a heading-only solve, matching "gravity fixes level
// and roll; heading is the only unknown".
//
// Derivation mirrors solveCalibrationWithGravity's own heading step (hz =
// az_in_R0_frame - az_target, R = Rz(hz)*R0), just with a single target
// azimuth of 0 (true north) instead of averaging two real sightings'
// disagreement. Elevation is NOT separately forced to 0: whatever the
// gravity fix + current tilt already implies for elevation (rotZ cannot
// change it -- heading only rotates about the vertical axis) is left alone,
// so a not-quite-level current tilt does not fight the solve.
export function solveNorthZero(
  dBase: Vec3, panDeg: number, tiltDeg: number, geoPanSign: number, cHead: Vec3 = [0, 1, 0],
): Mat3 {
  const R0 = rotAlign([-dBase[0], -dBase[1], -dBase[2]], [0, 0, 1]);
  const M = mountHeadRotation(geoPanSign * panDeg, tiltDeg);
  const p = matVec(matMul(R0, M), cHead);
  const azpDeg = rad2deg(Math.atan2(p[0], p[1]));
  return matMul(rotZ(deg2rad(azpDeg)), R0);
}

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
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    throw new Error("solveCalibrationWithGravity: sightings are geometrically degenerate (parallel z-rows) — cannot solve");
  }
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
  // |c0| > 1 means the two elevation constraints admit no UNIT boresight: the
  // affine solution set misses the unit sphere entirely. That is not
  // necessarily bad sightings -- it is what a base tilt does to otherwise good
  // ones. Field 2026-07-30: two well-aimed sightings (tilt spread 20.3deg vs
  // elevation spread 19.3deg, a consistent -4.4deg camera offset in both)
  // solved cleanly at 0.01deg residual with a level base, and threw here with
  // the rig's real 3.87deg northward lean -- the tolerance for THAT geometry
  // was only 1.61deg. Throwing "degenerate sightings" sent the operator off to
  // re-sight, which could never have helped.
  //
  // So: fall back to the CLOSEST unit vector to the solution set (c0
  // normalized -- the exact nearest point) and let headingResidualDeg, which
  // every caller already gates on, decide whether the answer is usable. A
  // slightly-infeasible pair yields a small residual and a usable solve; a
  // genuinely inconsistent one yields a large residual and is refused
  // downstream with a number the operator can act on, instead of an opaque
  // throw naming an internal variable.
  const roots = disc >= 0 ? [Math.sqrt(disc), -Math.sqrt(disc)] : [0];
  const c0u = disc >= 0 ? c0 : normalize(c0);
  const baseLeanDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, -normalize(dBase)[2]))));
  const infeasibleBy = disc >= 0 ? 0 : Math.hypot(c0[0], c0[1], c0[2]) - 1;
  const candidates = roots.map((t) => {
    const c: Vec3 = [c0u[0] + t * nz[0], c0u[1] + t * nz[1], c0u[2] + t * nz[2]];
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
  return { R: best.R, cHead: best.c, headingResidualDeg: best.dh, baseLeanDeg, infeasibleBy };
}

export interface InversePosture { panDeg: number; tiltDeg: number; inRange: boolean; errDeg: number; }
interface Limits { panMin: number; panMax: number; tiltMin: number; tiltMax: number; }

// All (pan,tilt) postures whose offset boresight hits enuUnit (both tilt roots).
// Inverts R·M(gp·pan,tilt)·cHead = w. With m = Rᵀ·w and cHead=(cx,cy,cz):
//   Rx(T)·cHead has z = |(cy,cz)|·sin(T+φ) ⇒ two T roots; then the pan rotation
//   Rz(-gp·pan) aligns the xy parts.
export function enuToPanTiltOffsetAll(R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: Limits): InversePosture[] {
  const w = normalize(enuUnit);
  const m = matVec(transpose(R), w);
  const cy = cHead[1], cz = cHead[2];
  const Rmag = Math.hypot(cy, cz);
  // cHead parallel to the pan (mount X) axis -- e.g. cHead=[1,0,0] -- means
  // tilt can never move the boresight off that axis, so there is no
  // pan/tilt solution for an arbitrary target direction (val = m[2]/Rmag
  // below would be a 0/0 NaN). Unreachable today: calibration always
  // produces cHead[1]>0 (solveCalibrationWithGravity filters to c·+Y>0) and
  // the default is [0,1,0], but this is a public export, so guard it rather
  // than let a NaN posture propagate downstream.
  if (Rmag < 1e-9) {
    throw new Error("enuToPanTiltOffsetAll: cHead is parallel to the pan axis — no pan/tilt solution");
  }
  const phi = Math.atan2(cz, cy);
  const val = Math.max(-1, Math.min(1, m[2] / Rmag));
  const out: InversePosture[] = [];
  for (const base of [Math.asin(val), Math.PI - Math.asin(val)]) {
    const T = ((base - phi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // geo tilt (rad)
    const u = matVec(rotX(T), cHead);
    const P = Math.atan2(m[0], m[1]) - Math.atan2(u[0], u[1]); // geo pan (rad, mount frame)
    const panDeg = (((rad2deg(P) * geoPanSign + 180) % 360) + 360) % 360 - 180;
    const tiltDeg = rad2deg(T);
    const bw = boresightToEnu(R, cHead, geoPanSign, panDeg, tiltDeg);
    const bwn = normalize(bw);
    const errDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(bwn, w)))));
    const inRange = tiltDeg >= limits.tiltMin && tiltDeg <= limits.tiltMax && panDeg >= limits.panMin && panDeg <= limits.panMax;
    out.push({ panDeg, tiltDeg, inRange, errDeg });
  }
  return out;
}

export function enuToPanTiltOffset(
  R: Mat3, cHead: Vec3, geoPanSign: number, enuUnit: Vec3, limits: Limits, preferTiltDeg?: number,
): { panDeg: number; tiltDeg: number; inRange: boolean } {
  const sols = enuToPanTiltOffsetAll(R, cHead, geoPanSign, enuUnit, limits);
  const ranged = sols.filter((s) => s.inRange);
  const pool = ranged.length ? ranged : sols;
  const sorted = preferTiltDeg !== undefined && ranged.length
    ? [...pool].sort((a, b) => Math.abs(a.tiltDeg - preferTiltDeg) - Math.abs(b.tiltDeg - preferTiltDeg))
    : [...pool].sort((a, b) => a.errDeg - b.errDeg || Math.abs(a.tiltDeg) - Math.abs(b.tiltDeg));
  const s = sorted[0];
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, inRange: s.inRange };
}
