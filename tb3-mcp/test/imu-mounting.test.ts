import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, GravitySample } from "../src/geo/imu-orientation.js";
import { normalize, rad2deg, dot } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

describe("solveImuMounting (winning convention geoPanSign=-1)", () => {
  const samples: GravitySample[] = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
    panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
  }));

  it("recovers R_s matching the numpy golden matrix", () => {
    const { rS } = solveImuMounting(samples, -1);
    const gold = [[0.986919, 0.106064, 0.121417], [0.028234, -0.855185, 0.517554], [0.158728, -0.507355, -0.846992]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(rS[i][j]).toBeCloseTo(gold[i][j], 2);
  });

  it("reads the tripod as ~4.3° from vertical, NOT 144°", () => {
    const { dBase, rmsDeg } = solveImuMounting(samples, -1);
    // d_base points down; tripod tilt = angle between -d_base and world up [0,0,1].
    const tilt = rad2deg(Math.acos(Math.max(-1, Math.min(1, dot(normalize([-dBase[0], -dBase[1], -dBase[2]]), [0, 0, 1])))));
    expect(tilt).toBeCloseTo(4.29, 1);
    expect(rmsDeg).toBeLessThan(1.7);
  });
});
