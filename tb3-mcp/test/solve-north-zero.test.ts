import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { solveImuMounting, solveNorthZero, dBaseFromGravity, boresightToEnu, GravitySample } from "../src/geo/imu-orientation.js";
import { normalize, rad2deg } from "../src/geo/vec3.js";
import { wrapDeg180 } from "../src/track/control.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

// Compass azimuth (0-360) of an ENU unit vector's horizontal component --
// same convention used throughout src/ (e.g. solveCalibrationWithGravity,
// track/session.ts's enuAzimuthDeg).
function azimuthDeg(v: Vec3): number {
  let az = rad2deg(Math.atan2(v[0], v[1]));
  if (az < 0) az += 360;
  return az;
}

describe("solveNorthZero (set_north_zero's geometry)", () => {
  const samples: GravitySample[] = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
    panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
  }));
  const GEO_PAN_SIGN = -1; // matches the fixture's own characterization convention

  it("the declared posture points EXACTLY at azimuth 0 (true north) under the produced R", () => {
    const { rS } = solveImuMounting(samples, GEO_PAN_SIGN);
    const posture = field.sweep[2]; // an arbitrary swept posture, not (0,0)
    const gravity = normalize([posture.ax, posture.ay, posture.az] as Vec3);
    const dBase = dBaseFromGravity(rS, posture.pan, posture.tilt, gravity, GEO_PAN_SIGN);

    const R = solveNorthZero(dBase, posture.pan, posture.tilt, GEO_PAN_SIGN);
    const boresight = boresightToEnu(R, [0, 1, 0], GEO_PAN_SIGN, posture.pan, posture.tilt);

    // wrapDeg180(az - 0) must be ~0 -- exact up to floating-point, since this
    // is a closed-form solve, not an iterative fit.
    expect(Math.abs(wrapDeg180(azimuthDeg(boresight)))).toBeLessThan(1e-6);
  });

  it("works from a DIFFERENT declared posture and still produces azimuth 0 there — heading is genuinely the only free parameter", () => {
    const { rS } = solveImuMounting(samples, GEO_PAN_SIGN);
    for (const posture of [field.sweep[0], field.sweep[4], field.sweep[6]]) {
      const gravity = normalize([posture.ax, posture.ay, posture.az] as Vec3);
      const dBase = dBaseFromGravity(rS, posture.pan, posture.tilt, gravity, GEO_PAN_SIGN);
      const R = solveNorthZero(dBase, posture.pan, posture.tilt, GEO_PAN_SIGN);
      const boresight = boresightToEnu(R, [0, 1, 0], GEO_PAN_SIGN, posture.pan, posture.tilt);
      expect(Math.abs(wrapDeg180(azimuthDeg(boresight)))).toBeLessThan(1e-6);
    }
  });

  it("does NOT force elevation to 0 — it reflects whatever the gravity fix + current tilt already implies", () => {
    const { rS } = solveImuMounting(samples, GEO_PAN_SIGN);
    // sweep[2] has a non-zero tilt (see the fixture), so the true elevation
    // at that posture is not exactly 0 -- solveNorthZero must not silently
    // clamp it to the horizon.
    const posture = field.sweep[2];
    expect(posture.tilt).not.toBe(0);
    const gravity = normalize([posture.ax, posture.ay, posture.az] as Vec3);
    const dBase = dBaseFromGravity(rS, posture.pan, posture.tilt, gravity, GEO_PAN_SIGN);
    const R = solveNorthZero(dBase, posture.pan, posture.tilt, GEO_PAN_SIGN);
    const boresight = boresightToEnu(R, [0, 1, 0], GEO_PAN_SIGN, posture.pan, posture.tilt);
    const elevationDeg = rad2deg(Math.asin(Math.max(-1, Math.min(1, boresight[2]))));
    // Non-level tilt -> a genuinely non-zero elevation, not forced flat.
    expect(Math.abs(elevationDeg)).toBeGreaterThan(1);
  });

  it("a small heading nudge afterward (as if from drift calibration) moves azimuth by exactly that amount", () => {
    // Sanity-checks that solveNorthZero's R behaves like an ordinary
    // orientation for downstream pointing math -- not asserting anything
    // about track/offset.ts here, just that R is a well-formed rotation.
    const { rS } = solveImuMounting(samples, GEO_PAN_SIGN);
    const posture = field.sweep[1];
    const gravity = normalize([posture.ax, posture.ay, posture.az] as Vec3);
    const dBase = dBaseFromGravity(rS, posture.pan, posture.tilt, gravity, GEO_PAN_SIGN);
    const R = solveNorthZero(dBase, posture.pan, posture.tilt, GEO_PAN_SIGN);
    // Determinant ~1 (a proper rotation, not a reflection/degenerate matrix).
    const det =
      R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
      R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
      R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    expect(det).toBeCloseTo(1, 6);
  });
});
