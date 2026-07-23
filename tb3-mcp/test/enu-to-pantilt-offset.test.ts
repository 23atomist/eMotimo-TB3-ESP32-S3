import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, solveCalibrationWithGravity, enuToPanTiltOffset, enuToPanTiltOffsetAll, GravitySample, GravitySighting } from "../src/geo/imu-orientation.js";
import { enuToPanTilt } from "../src/geo/orientation.js";
import { enuDirection, azElRange } from "../src/geo/wgs84.js";
import { normalize, deg2rad } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
const rig = field.rig;
const LIM = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };
const unitFromAzEl = (az: number, el: number): Vec3 => [Math.sin(deg2rad(az)) * Math.cos(deg2rad(el)), Math.cos(deg2rad(az)) * Math.cos(deg2rad(el)), Math.sin(deg2rad(el))];
function sighting(idx: number): GravitySighting {
  const s = field.sightings[idx];
  const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
  const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
}

describe("enuToPanTiltOffset", () => {
  const samples: GravitySample[] = field.sweep.map((s: any) => ({ panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3) }));
  const { dBase } = solveImuMounting(samples, -1);
  const { R, cHead } = solveCalibrationWithGravity(dBase, [sighting(0), sighting(1)], -1);

  it("regression: a high target maps to a sane UPWARD tilt, not into the ground", () => {
    const r = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(154, 10), LIM);
    expect(r.inRange).toBe(true);
    expect(r.tiltDeg).toBeCloseTo(-23.78, 0); // was -63 (broken TRIAD) / -87 (level assumption)
    expect(r.tiltDeg).toBeGreaterThan(-50);
    const hi = enuToPanTiltOffset(R, cHead, -1, unitFromAzEl(90, 45), LIM);
    expect(hi.tiltDeg).toBeGreaterThan(15); // el+45 must tilt well up
  });

  it("recovers each sighting's own posture from its landmark direction", () => {
    const a = enuToPanTiltOffset(R, cHead, -1, sighting(0).enuUnit, LIM, -31);
    expect(a.panDeg).toBeCloseTo(-26.2, 0);
    expect(a.tiltDeg).toBeCloseTo(-31.0, 0);
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
