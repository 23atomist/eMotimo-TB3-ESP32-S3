import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, rotAlign, enuToPanTiltOffset, enuToPanTiltOffsetAll, boresightToEnu, GravitySample } from "../src/geo/imu-orientation.js";
import { enuToPanTilt } from "../src/geo/orientation.js";
import { normalize, deg2rad, matMul, rotZ, angleBetweenDeg } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
const LIM = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };
const unitFromAzEl = (az: number, el: number): Vec3 => [Math.sin(deg2rad(az)) * Math.cos(deg2rad(el)), Math.cos(deg2rad(az)) * Math.cos(deg2rad(el)), Math.sin(deg2rad(el))];

describe("enuToPanTiltOffset", () => {
  // A calibration built DIRECTLY rather than through a solver. This file
  // tests the pan/tilt inversion, so it needs some valid (R, cHead) — it does
  // not need a solve, and taking one from the fixture's two sightings was how
  // it came to pin -23.78°, a number produced entirely by the old
  // two-sighting solver overfitting a 47°-off boresight onto data that cannot
  // support one. Real tripod lean, a real heading and a real (small) camera
  // offset, stated outright:
  const samples: GravitySample[] = field.sweep.map((s: any) => ({ panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3) }));
  const { dBase } = solveImuMounting(samples, -1);
  const R: Mat3 = matMul(rotZ(deg2rad(12)), rotAlign([-dBase[0], -dBase[1], -dBase[2]], [0, 0, 1]));
  const CE = deg2rad(4.4); // the rig's real ~4.4° boresight elevation offset
  const cHead: Vec3 = [0, Math.cos(CE), Math.sin(CE)];

  it("regression: a high target maps to a sane UPWARD tilt, not into the ground", () => {
    const r = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(154, 10), LIM);
    expect(r.inRange).toBe(true);
    expect(r.tiltDeg).toBeGreaterThan(-50); // was -63 (broken TRIAD) / -87 (level assumption)
    const hi = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(90, 45), LIM);
    expect(hi.tiltDeg).toBeGreaterThan(15); // el+45 must tilt well up
  });

  // The inversion's defining property, pinned without any solver in the loop:
  // forward-project a posture to a direction, invert it, get the posture back.
  it("round-trips every posture through its own boresight direction", () => {
    for (const [pan, tilt] of [[-26.2, -31], [0, 0], [80, 40], [-120, 12.5], [175, -8]]) {
      const u = normalize(boresightToEnu(R, cHead, -1, pan, tilt));
      const back = enuToPanTiltOffset(R, cHead, -1, u, LIM, tilt);
      expect(back.panDeg).toBeCloseTo(pan, 6);
      expect(back.tiltDeg).toBeCloseTo(tilt, 6);
      expect(angleBetweenDeg(normalize(boresightToEnu(R, cHead, -1, back.panDeg, back.tiltDeg)), u)).toBeLessThan(1e-6);
    }
  });

  it("is backward-compatible: cHead=[0,1,0], geoPanSign=+1 equals the legacy enuToPanTilt", () => {
    const Rid: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const u = normalize([0.3, 0.8, 0.5] as Vec3);
    const legacy = enuToPanTilt(Rid, u);
    const off = enuToPanTiltOffset(Rid, [0, 1, 0], 1, u, LIM);
    expect(off.panDeg).toBeCloseTo(legacy.panDeg, 6);
    expect(off.tiltDeg).toBeCloseTo(legacy.tiltDeg, 6);
  });
});

describe("enuToPanTiltOffsetAll degenerate-cHead guard", () => {
  it("throws when cHead is parallel to the pan axis (Rmag would be 0)", () => {
    // cHead=[1,0,0]: cy=cz=0, so Rmag=hypot(0,0)=0 and val=m[2]/Rmag would be
    // a 0/0 NaN -- tilt can never move this boresight off the pan axis, so
    // there is no pan/tilt solution for an arbitrary target direction.
    const Rid: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const u = normalize([0.3, 0.8, 0.5] as Vec3);
    expect(() => enuToPanTiltOffsetAll(Rid, [1, 0, 0], 1, u, LIM)).toThrow(
      /parallel to the pan axis/,
    );
  });
});
