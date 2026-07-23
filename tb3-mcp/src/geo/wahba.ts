import { Vec3, Mat3, matMul, transpose, inv3, det3 } from "./vec3.js";

// Optimal proper rotation R minimizing Σ wᵢ|R·srcᵢ − dstᵢ|² (Wahba's problem).
// R is the orthogonal polar factor of M = Σ wᵢ·dstᵢ·srcᵢᵀ, computed by Higham's
// iteration Xₖ₊₁ = ½(Xₖ + Xₖ⁻ᵀ). For near-aligned data det(M)>0 so the polar
// factor is already a proper rotation; we assert det>0 to catch degenerate input.
//
// M is rank-deficient (singular) whenever fewer than 3 non-collinear vector
// pairs are supplied — e.g. exactly 2 pairs gives rank(M)<=2, so det(M)=0 and
// the very first inv3(X) in the Higham loop would throw. We nudge M off the
// singular set with a tiny diagonal regularizer before iterating; at 1e-9 this
// is far below the precision the callers/tests need (~1e-6) but keeps the
// iteration well-defined for any span of input directions, including this
// under-determined case (the recovered rotation is then just one of the
// family of rotations consistent with the partial data).
export function wahbaRotation(src: Vec3[], dst: Vec3[], weights?: number[]): Mat3 {
  if (src.length !== dst.length || src.length === 0) {
    throw new Error("wahbaRotation: src/dst must be equal-length and non-empty");
  }
  let M: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < src.length; k++) {
    const w = weights ? weights[k] : 1;
    const d = dst[k], s = src[k];
    M = [
      [M[0][0] + w * d[0] * s[0], M[0][1] + w * d[0] * s[1], M[0][2] + w * d[0] * s[2]],
      [M[1][0] + w * d[1] * s[0], M[1][1] + w * d[1] * s[1], M[1][2] + w * d[1] * s[2]],
      [M[2][0] + w * d[2] * s[0], M[2][1] + w * d[2] * s[1], M[2][2] + w * d[2] * s[2]],
    ];
  }
  const REG = 1e-9;
  let X: Mat3 = [
    [M[0][0] + REG, M[0][1], M[0][2]],
    [M[1][0], M[1][1] + REG, M[1][2]],
    [M[2][0], M[2][1], M[2][2] + REG],
  ];
  for (let it = 0; it < 100; it++) {
    const Xit = transpose(inv3(X)); // X⁻ᵀ
    const next: Mat3 = [
      [0.5 * (X[0][0] + Xit[0][0]), 0.5 * (X[0][1] + Xit[0][1]), 0.5 * (X[0][2] + Xit[0][2])],
      [0.5 * (X[1][0] + Xit[1][0]), 0.5 * (X[1][1] + Xit[1][1]), 0.5 * (X[1][2] + Xit[1][2])],
      [0.5 * (X[2][0] + Xit[2][0]), 0.5 * (X[2][1] + Xit[2][1]), 0.5 * (X[2][2] + Xit[2][2])],
    ];
    let diff = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) diff += Math.abs(next[i][j] - X[i][j]);
    X = next;
    if (diff < 1e-14) break;
  }
  if (det3(X) < 0) throw new Error("wahbaRotation: degenerate input (reflection, det < 0)");
  return X;
}
