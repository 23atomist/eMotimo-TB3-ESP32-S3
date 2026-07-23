import { describe, it, expect } from "vitest";
import { wahbaRotation } from "../src/geo/wahba.js";
import { rotX, rotZ, matMul, matVec, det3, normalize } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

describe("wahbaRotation", () => {
  it("recovers a known rotation from clean vector pairs", () => {
    const R = matMul(rotZ(0.6), rotX(-0.4)); // arbitrary known rotation
    const src: Vec3[] = [normalize([1, 0.2, -0.3]), normalize([0.1, 1, 0.4]), normalize([-0.2, 0.3, 1])];
    const dst = src.map((v) => matVec(R, v));
    const est = wahbaRotation(src, dst);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(est[i][j]).toBeCloseTo(R[i][j], 6);
    expect(det3(est)).toBeCloseTo(1, 6);
  });

  it("returns a proper rotation (det +1) even from two pairs", () => {
    const R = rotX(0.5);
    const src: Vec3[] = [normalize([0.3, 1, 0.1]), normalize([1, -0.2, 0.5])];
    const dst = src.map((v) => matVec(R, v));
    expect(det3(wahbaRotation(src, dst))).toBeCloseTo(1, 6);
  });

  it("returns the optimal PROPER rotation for a genuine reflection (det(M) < 0)", () => {
    // Construct a genuine reflection: each dst is a rotated src mirrored through
    // the xy-plane, so the unconstrained least-squares fit is IMPROPER
    // (det of the attitude-profile matrix M = Σ dst·srcᵀ is < 0). Wahba must
    // return the best PROPER rotation (det +1) — matching numpy SVD-Kabsch —
    // NOT the improper mirror and NOT a silently non-optimal rotation.
    const R = matMul(rotZ(0.6), rotX(-0.4));
    const src: Vec3[] = [normalize([1, 0.2, -0.3]), normalize([0.1, 1, 0.4]), normalize([-0.2, 0.3, 1])];
    const dst: Vec3[] = src.map((v) => {
      const rv = matVec(R, v);
      return [rv[0], rv[1], -rv[2]] as Vec3; // mirror through xy-plane => reflection
    });

    // Sanity: this really is a reflection (det(M) < 0), the case the old
    // escalating-regularizer solver could not correctly handle.
    const M: Mat3 = [
      [
        dst[0][0] * src[0][0] + dst[1][0] * src[1][0] + dst[2][0] * src[2][0],
        dst[0][0] * src[0][1] + dst[1][0] * src[1][1] + dst[2][0] * src[2][1],
        dst[0][0] * src[0][2] + dst[1][0] * src[1][2] + dst[2][0] * src[2][2],
      ],
      [
        dst[0][1] * src[0][0] + dst[1][1] * src[1][0] + dst[2][1] * src[2][0],
        dst[0][1] * src[0][1] + dst[1][1] * src[1][1] + dst[2][1] * src[2][1],
        dst[0][1] * src[0][2] + dst[1][1] * src[1][2] + dst[2][1] * src[2][2],
      ],
      [
        dst[0][2] * src[0][0] + dst[1][2] * src[1][0] + dst[2][2] * src[2][0],
        dst[0][2] * src[0][1] + dst[1][2] * src[1][1] + dst[2][2] * src[2][1],
        dst[0][2] * src[0][2] + dst[1][2] * src[1][2] + dst[2][2] * src[2][2],
      ],
    ];
    expect(det3(M)).toBeLessThan(0);

    const est = wahbaRotation(src, dst);
    expect(det3(est)).toBeCloseTo(1, 6);

    // Expected optimal proper rotation from numpy SVD-Kabsch (kabsch(src, dst)).
    const expected: Mat3 = [
      [0.191237717454547, 0.199316377501539, -0.961093708793497],
      [0.521996524409323, 0.808566437140697, 0.271550999324595],
      [0.831232677369797, -0.553618368905208, 0.050585943535482],
    ];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(est[i][j]).toBeCloseTo(expected[i][j], 6);
  });
});
