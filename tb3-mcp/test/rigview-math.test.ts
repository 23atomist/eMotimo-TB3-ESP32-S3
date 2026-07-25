import { describe, it, expect } from "vitest";
import { boresightVector } from "../dashboard/public/rigmath.js";

describe("boresightVector (ENU, matches panTiltToMount)", () => {
  it("pan 0 / tilt 0 points due north", () => {
    const v = boresightVector(0, 0);
    expect(v.e).toBeCloseTo(0, 6); expect(v.n).toBeCloseTo(1, 6); expect(v.u).toBeCloseTo(0, 6);
  });
  it("pan 90 / tilt 0 points due east", () => {
    const v = boresightVector(90, 0);
    expect(v.e).toBeCloseTo(1, 6); expect(v.n).toBeCloseTo(0, 6); expect(v.u).toBeCloseTo(0, 6);
  });
  it("pan 180 points south; pan 270 points west", () => {
    const s = boresightVector(180, 0); expect(s.n).toBeCloseTo(-1, 6);
    const w = boresightVector(270, 0); expect(w.e).toBeCloseTo(-1, 6);
  });
  it("tilt 90 points straight up", () => {
    const v = boresightVector(0, 90);
    expect(v.u).toBeCloseTo(1, 6);
    expect(Math.hypot(v.e, v.n)).toBeCloseTo(0, 6);
  });
  it("returns a unit vector", () => {
    const v = boresightVector(37, 22);
    expect(Math.hypot(v.e, v.n, v.u)).toBeCloseTo(1, 9);
  });
});
