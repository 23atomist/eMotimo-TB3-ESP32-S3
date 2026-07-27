import { describe, it, expect } from "vitest";
import {
  boresightVector,
  enuToThreeJs,
  threeJsToEnu,
  boresightThreeJs,
  rigModelForwardThreeJs,
} from "../dashboard/public/rigmath.js";

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

  // Ground truth for the field-reported tilt inversion: tilt is "up" for
  // positive values and "down" for negative, full stop, independent of pan.
  it("positive/negative tilt has positive/negative Up; tilt 0 is level", () => {
    expect(boresightVector(0, 45).u).toBeGreaterThan(0);
    expect(boresightVector(0, -45).u).toBeLessThan(0);
    expect(boresightVector(0, 0).u).toBeCloseTo(0, 9);
  });
});

describe("enuToThreeJs / threeJsToEnu (rigview.js world-frame mapping)", () => {
  // This is the assertion whose absence let the tilt inversion ship: the old
  // inline mapping in rigview.js negated Up (y = -u), so a positive-Up
  // boresight silently became a negative Three.js Y and nothing objected.
  it("preserves the sign of Up: positive Up maps to positive Three.js Y", () => {
    expect(enuToThreeJs({ e: 0, n: 0, u: 1 }).y).toBeGreaterThan(0);
    expect(enuToThreeJs({ e: 0, n: 0, u: -1 }).y).toBeLessThan(0);
  });

  it("maps a level, due-north boresight to a level, +Z direction", () => {
    const tv = enuToThreeJs({ e: 0, n: 1, u: 0 });
    expect(tv.y).toBeCloseTo(0, 9);
    expect(tv.z).toBeGreaterThan(0);
  });

  it("round-trips through Three.js space for a sample of pan/tilt values", () => {
    const samples = [
      [0, 0], [0, 45], [0, -45], [90, 30], [180, -60], [270, 10], [37, 22],
    ];
    for (const [pan, tilt] of samples) {
      const v = boresightVector(pan, tilt);
      const back = threeJsToEnu(enuToThreeJs(v));
      expect(back.e).toBeCloseTo(v.e, 9);
      expect(back.n).toBeCloseTo(v.n, 9);
      expect(back.u).toBeCloseTo(v.u, 9);
    }
  });
});

describe("rigModelForwardThreeJs (panGroup/tiltGroup rotations vs. the arrow mapping)", () => {
  // Direct regression test for the reported bug: the model itself (not just
  // the arrow) must pitch up for positive tilt.
  it("tilt +45 pitches the model up (+Y); tilt -45 pitches it down; tilt 0 is level", () => {
    expect(rigModelForwardThreeJs(0, 45).y).toBeGreaterThan(0);
    expect(rigModelForwardThreeJs(0, -45).y).toBeLessThan(0);
    expect(rigModelForwardThreeJs(0, 0).y).toBeCloseTo(0, 9);
  });

  // The model's rotation-matrix-derived forward and the arrow's ENU mapping
  // must agree at every pan/tilt combo — two independently-derived paths
  // landing on the same vector, for pan as well as tilt (pan's sign is
  // untouched by this fix, so this also guards against a future pan
  // regression breaking model/arrow agreement).
  it("stays self-consistent with boresightThreeJs across pan and tilt", () => {
    const pans = [0, 30, 90, 145, 180, 270, -40];
    const tilts = [0, 45, -45, 10, -80, 89];
    for (const pan of pans) {
      for (const tilt of tilts) {
        const model = rigModelForwardThreeJs(pan, tilt);
        const arrow = boresightThreeJs(pan, tilt);
        expect(model.x).toBeCloseTo(arrow.x, 9);
        expect(model.y).toBeCloseTo(arrow.y, 9);
        expect(model.z).toBeCloseTo(arrow.z, 9);
      }
    }
  });
});
