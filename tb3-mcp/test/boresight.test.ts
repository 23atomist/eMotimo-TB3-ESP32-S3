import { describe, it, expect } from "vitest";
import { panTiltToMount, mountToPanTilt } from "../src/geo/boresight.js";
import { norm } from "../src/geo/vec3.js";

describe("boresight", () => {
  it("pan=0 tilt=0 points along +Y (mount-forward), unit length", () => {
    const v = panTiltToMount(0, 0);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
    expect(v[2]).toBeCloseTo(0, 12);
    expect(norm(v)).toBeCloseTo(1, 12);
  });
  it("pan=90 tilt=0 points along +X (mount-right)", () => {
    const v = panTiltToMount(90, 0);
    expect(v[0]).toBeCloseTo(1, 12);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(0, 12);
  });
  it("tilt=90 points along +Z (mount-up)", () => {
    const v = panTiltToMount(0, 90);
    expect(v[2]).toBeCloseTo(1, 12);
  });
  it("round-trips pan/tilt through the mount vector", () => {
    for (const [p, t] of [[0, 0], [37.5, 12], [-120, 40], [175, -30], [-90, 0]]) {
      const back = mountToPanTilt(panTiltToMount(p, t));
      expect(back.panDeg).toBeCloseTo(p, 9);
      expect(back.tiltDeg).toBeCloseTo(t, 9);
    }
  });
});
