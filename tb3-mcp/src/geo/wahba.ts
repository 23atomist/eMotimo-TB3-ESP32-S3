import { Vec3, Mat3 } from "./vec3.js";

// Optimal PROPER rotation R minimizing Σ wᵢ|R·srcᵢ − dstᵢ|² (Wahba's problem),
// solved SVD-free by Davenport's q-method.
//
// Build the attitude-profile matrix B = Σ wᵢ·dstᵢ·srcᵢᵀ, assemble the 4×4
// symmetric Davenport matrix K from B, and take the eigenvector of K's LARGEST
// eigenvalue — that eigenvector IS the optimal attitude quaternion. Converting
// it to a matrix yields a proper rotation (det = +1) UNCONDITIONALLY: this
// handles genuine reflections (det(B) < 0) and rank-deficient inputs (fewer
// than 3 non-collinear pairs) natively — it flips the axis of the smallest
// singular value exactly as the SVD-Kabsch solution does — with no regularizer
// and no reflection escape hatch. The dominant eigenvector is extracted with a
// Jacobi rotation sweep, which is robust even when the top two eigenvalues are
// nearly equal (the near-singular data produced by callers that alternate this
// solve against a moving target set), where shifted power iteration would stall.

type Mat4 = number[][]; // 4×4 scratch; internal-only, never a caller value

// Eigenvector of the largest eigenvalue of a 4×4 symmetric matrix, via the
// cyclic Jacobi eigenvalue algorithm. Operates on copies — the caller's matrix
// is never mutated. Converges quadratically; 60 sweeps is far more than a 4×4
// ever needs, and the loop exits early once the off-diagonal mass is negligible.
function largestEigenvector4(K: Mat4): [number, number, number, number] {
  const n = 4;
  const a: Mat4 = K.map((row) => row.slice());
  const v: Mat4 = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      diag += a[i][i] * a[i][i];
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    }
    if (off <= 1e-30 * (diag + 1e-300)) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (apq === 0) continue;
        // Rotation angle that zeros a[p][q]: cot(2θ) = (a_qq − a_pp)/(2 a_pq).
        const tau = (a[q][q] - a[p][p]) / (2 * apq);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // A ← Jᵀ A J : first the column update (A·J), then the row update (Jᵀ·).
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        // V ← V J : accumulate the eigenvectors as matrix columns.
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

export function wahbaRotation(src: Vec3[], dst: Vec3[], weights?: number[]): Mat3 {
  if (src.length !== dst.length || src.length === 0) {
    throw new Error("wahbaRotation: src/dst must be equal-length and non-empty");
  }
  // Attitude-profile matrix B = Σ wᵢ·dstᵢ·srcᵢᵀ.
  const B: Mat4 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < src.length; k++) {
    const w = weights ? weights[k] : 1;
    const d = dst[k];
    const s = src[k];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[i][j] += w * d[i] * s[j];
  }
  // Davenport 4×4 symmetric matrix K = [[S − σI₃, z], [zᵀ, σ]] with
  // S = B + Bᵀ, z = [B₂₃−B₃₂, B₃₁−B₁₃, B₁₂−B₂₁], σ = tr(B).
  const sigma = B[0][0] + B[1][1] + B[2][2];
  const z0 = B[1][2] - B[2][1];
  const z1 = B[2][0] - B[0][2];
  const z2 = B[0][1] - B[1][0];
  const K: Mat4 = [
    [B[0][0] + B[0][0] - sigma, B[0][1] + B[1][0], B[0][2] + B[2][0], z0],
    [B[1][0] + B[0][1], B[1][1] + B[1][1] - sigma, B[1][2] + B[2][1], z1],
    [B[2][0] + B[0][2], B[2][1] + B[1][2], B[2][2] + B[2][2] - sigma, z2],
    [z0, z1, z2, sigma],
  ];
  // Optimal attitude quaternion = eigenvector of K's largest eigenvalue.
  // Order (x, y, z, w): vector part first, scalar last — the Markley convention.
  let [x, y, zc, w] = largestEigenvector4(K);
  const qn = Math.sqrt(x * x + y * y + zc * zc + w * w);
  x /= qn;
  y /= qn;
  zc /= qn;
  w /= qn;
  // Quaternion → rotation (Markley attitude matrix), so that R·srcᵢ ≈ dstᵢ.
  return [
    [w * w + x * x - y * y - zc * zc, 2 * (x * y + w * zc), 2 * (x * zc - w * y)],
    [2 * (x * y - w * zc), w * w - x * x + y * y - zc * zc, 2 * (y * zc + w * x)],
    [2 * (x * zc + w * y), 2 * (y * zc - w * x), w * w - x * x - y * y + zc * zc],
  ];
}
