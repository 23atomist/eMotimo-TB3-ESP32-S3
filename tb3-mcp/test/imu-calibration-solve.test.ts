import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, solveCalibrationWithGravity, boresightToEnu, GravitySample, GravitySighting } from "../src/geo/imu-orientation.js";
import { enuDirection, azElRange } from "../src/geo/wgs84.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));
const rig = field.rig;

function sighting(idx: number): GravitySighting {
  const s = field.sightings[idx];
  const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
  const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
  return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
}

describe("solveCalibrationWithGravity", () => {
  const samples: GravitySample[] = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
    panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
  }));
  const { dBase } = solveImuMounting(samples, -1);
  const A = sighting(0), B = sighting(1);

  it("recovers c_head and heading matching the numpy golden result", () => {
    const { cHead, headingResidualDeg } = solveCalibrationWithGravity(dBase, [A, B], -1);
    expect(cHead[0]).toBeCloseTo(-0.520849, 2);
    expect(cHead[1]).toBeCloseTo(0.735122, 2);
    expect(cHead[2]).toBeCloseTo(0.433949, 2);
    expect(cHead[1]).toBeGreaterThan(0); // disambiguation: camera looks forward
    expect(headingResidualDeg).toBeLessThan(1.0);
  });

  it("reproduces both landmarks to < 0.5°", () => {
    const { R, cHead } = solveCalibrationWithGravity(dBase, [A, B], -1);
    for (const s of [A, B]) {
      const bw = boresightToEnu(R, cHead, -1, s.panDeg, s.tiltDeg);
      const cos = (bw[0] * s.enuUnit[0] + bw[1] * s.enuUnit[1] + bw[2] * s.enuUnit[2]) /
        Math.hypot(bw[0], bw[1], bw[2]);
      expect(Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toBeLessThan(0.5);
    }
  });
});
