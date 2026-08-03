import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { onReboot, rezeroFromEnu } from "../src/rezero-tools.js";
import { Mat3, Vec3, matMul, rotX, rotZ, deg2rad, matVec, normalize, angleBetweenDeg } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";

const GP = -1;
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C: Vec3 = normalize([0.02, 0.99, 0.08]);
const RS: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const DB: Vec3 = normalize([-0.008, -0.024, -0.9997]);

function stores() {
  const d = mkdtempSync(join(tmpdir(), "tb3-"));
  const calib = new CalibrationStore(join(d, "calibration.json")); calib.load();
  const limits = new LimitsStore(join(d, "limits.json")); limits.load();
  const boot = new BootWatcher(join(d, "boot.json")); boot.load();
  return { calib, limits, boot };
}

function boresight(R_: Mat3, c: Vec3, pan: number, tilt: number): Vec3 {
  return matVec(matMul(R_, mountHeadRotation(GP * pan, tilt)), c);
}
function gravityAt(pan: number, tilt: number): Vec3 {
  const M = mountHeadRotation(GP * pan, tilt);
  const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
  return matVec(matMul(t(RS), t(M)), DB);
}

describe("onReboot", () => {
  it("corrects tilt limits immediately and clears pan limits", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dTilt = 23.33;
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(18, 12),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 - dTilt }),
      bootId: 2,
    });
    expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(limits.get().tiltMin).toBeCloseTo(-20 - dTilt, 1);
    expect(limits.get().panMin).toBeUndefined();  // unknown until Delta-pan solved
    expect(calib.needsRezero()).toBe(true);
  });

  it("refuses to apply when the tripod moved", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20);
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]);
    const M = mountHeadRotation(GP * 18, 12);
    const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => matVec(matMul(t(RS), t(M)), moved),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(limits.get().tiltMin).toBeUndefined();  // cleared, not shifted by a bad number
  });

  it("falls back to the ceiling when the IMU is absent rather than guessing", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("panMin", -90);
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => undefined,             // /api/imu reports chip "none"
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/no IMU gravity/);
    expect(limits.get().tiltMin).toBeUndefined();
    expect(limits.get().panMin).toBeUndefined();
    expect(calib.needsRezero()).toBe(true);
  });
});

describe("rezeroFromEnu", () => {
  it("restores pointing for an independent posture", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt }), bootId: 2 });
    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);
    expect(res.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(calib.needsRezero()).toBe(false);
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - dPan, 33 - dTilt), boresight(R, C, 60, 33))).toBeLessThan(0.3);
    expect(limits.get().panMin).toBeCloseTo(-90 - dPan, 1);
  });

  // The third pass is the whole point of iterating: with a large pan error the
  // first-pass Delta-tilt is measurably wrong, and the refined one is not.
  it("the third pass removes the pan-induced tilt error", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    const dPan = 90, dTilt = 12;          // 90deg is where the coupling peaks
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25 - dPan, tiltDeg: 19 - dTilt }), bootId: 2 });
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      boresight(R, C, -25, 19), { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    // Refined tilt must beat the 2.03deg worst case the single-pass solve has.
    expect(Math.abs((res.deltaTiltDeg as number) - dTilt)).toBeLessThan(0.3);
  });
});
