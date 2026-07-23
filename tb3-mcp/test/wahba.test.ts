import { describe, it, expect } from "vitest";
import { wahbaRotation } from "../src/geo/wahba.js";
import { rotX, rotZ, matMul, matVec, det3, normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

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
});
