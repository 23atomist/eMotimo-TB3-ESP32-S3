import { describe, it, expect } from "vitest";
import {
  deg2rad, rad2deg, sub, add, dot, cross, norm, normalize, scale,
  matFromColumns, matVec, matMul, transpose, angleBetweenDeg, Vec3, Mat3,
} from "../src/geo/vec3.js";

describe("vec3 primitives", () => {
  it("deg/rad round-trip", () => {
    expect(rad2deg(deg2rad(37))).toBeCloseTo(37, 9);
    expect(deg2rad(180)).toBeCloseTo(Math.PI, 12);
  });
  it("basic vector ops", () => {
    expect(sub([3, 5, 7], [1, 2, 3])).toEqual([2, 3, 4]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(norm([3, 4, 0])).toBeCloseTo(5, 12);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
    const n = normalize([0, 3, 4]);
    expect(norm(n)).toBeCloseTo(1, 12);
    expect(n[2]).toBeCloseTo(0.8, 12);
  });
  it("normalize throws on zero-length", () => {
    expect(() => normalize([0, 0, 0])).toThrow();
  });
  it("matVec applies a matrix built from columns", () => {
    // identity from standard basis columns
    const I = matFromColumns([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(matVec(I, [5, 6, 7])).toEqual([5, 6, 7]);
    // columns become the images of the basis vectors
    const M = matFromColumns([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    expect(matVec(M, [1, 0, 0])).toEqual([1, 2, 3]);
    expect(matVec(M, [0, 1, 0])).toEqual([4, 5, 6]);
  });
  it("transpose and matMul give R·Rᵀ = I for a rotation", () => {
    // 90° rotation about Z, as columns (images of x,y,z)
    const R = matFromColumns([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    const I = matMul(R, transpose(R));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(I[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
  });
  it("angleBetweenDeg", () => {
    expect(angleBetweenDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 9);
    expect(angleBetweenDeg([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 9);
    expect(angleBetweenDeg([1, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 6);
  });
});

describe("add", () => {
  it("adds componentwise", () => {
    expect(add([1, 2, 3], [10, 20, 30])).toEqual([11, 22, 33]);
  });
});
