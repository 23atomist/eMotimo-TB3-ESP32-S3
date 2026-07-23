import { describe, it, expect, afterEach } from "vitest";
import { CalibrationStore } from "../src/calibration.js";
import { Mat3 } from "../src/geo/vec3.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3cal-"));
  return join(dir, "sub", "calibration.json"); // nested dir must be created on save
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

const R: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

describe("CalibrationStore", () => {
  it("starts uncalibrated and empty", () => {
    const s = new CalibrationStore(tmpFile());
    s.load();
    expect(s.isCalibrated()).toBe(false);
    expect(s.get().sightings).toEqual([]);
  });

  it("setRigLocation persists and clears sightings", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.setRigLocation(45, 10, 100);
    expect(s.get().rig).toEqual({ lat: 45, lon: 10, height: 100 });
    expect(s.get().sightings).toEqual([]);
    expect(existsSync(f)).toBe(true);
  });

  it("addSighting keeps only the last two", () => {
    const s = new CalibrationStore(tmpFile());
    s.addSighting({ lat: 1, lon: 1, height: 0, panDeg: 0, tiltDeg: 0 });
    s.addSighting({ lat: 2, lon: 2, height: 0, panDeg: 10, tiltDeg: 0 });
    const count = s.addSighting({ lat: 3, lon: 3, height: 0, panDeg: 20, tiltDeg: 0 });
    expect(count).toBe(2);
    expect(s.get().sightings.map((x) => x.lat)).toEqual([2, 3]);
  });

  it("setOrientation makes it calibrated and round-trips through a reload", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.setRigLocation(45, 10, 100);
    s.setOrientation(R, "2026-07-16T00:00:00.000Z");
    expect(s.isCalibrated()).toBe(true);

    const s2 = new CalibrationStore(f);
    s2.load();
    expect(s2.isCalibrated()).toBe(true);
    expect(s2.getOrientation()).toEqual(R);
    expect(s2.get().solvedAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("clear resets to empty", () => {
    const s = new CalibrationStore(tmpFile());
    s.setRigLocation(45, 10, 100);
    s.clear();
    expect(s.get().rig).toBeUndefined();
    expect(s.isCalibrated()).toBe(false);
  });

  it("a corrupt file loads as empty and does not throw", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{ this is not valid json");
    const s = new CalibrationStore(f);
    expect(() => s.load()).not.toThrow();
    expect(s.isCalibrated()).toBe(false);
    expect(s.get().sightings).toEqual([]);
  });
});

describe("CalibrationStore IMU fields", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");

  it("persists and reloads R_s, d_base, and c_head", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    // Real usage always calls set_rig_location before a gravity solve (Task 9's
    // solve_calibration gravity path reads store.get().rig to build sightings) —
    // isCalibrated() correctly requires both rig and orientation, so set it here
    // too, before setImuMounting/setGravityCalibration (setRigLocation is a full
    // profile reset and must come first).
    a.setRigLocation(45.5, -122.6, 50);
    a.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    a.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");
    const b = new CalibrationStore(f);
    b.load();
    expect(b.getImuMounting()?.dBase).toEqual([0, 0, -1]);
    expect(b.getCHead()).toEqual([-0.52, 0.735, 0.434]);
    expect(b.isCalibrated()).toBe(true);
  });

  it("loads a legacy profile without the new fields (backward compatible)", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    a.setOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], "2026-01-01T00:00:00Z");
    const b = new CalibrationStore(f);
    b.load();
    expect(b.getCHead()).toBeUndefined();
    expect(b.getImuMounting()).toBeUndefined();
  });

  it("addSighting clears cHead but the IMU stays bolted on (imuMounting survives)", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    s.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");

    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });

    expect(s.getCHead()).toBeUndefined();
    expect(s.get().orientation).toBeUndefined();
    expect(s.get().solvedAt).toBeUndefined();
    expect(s.getImuMounting()?.dBase).toEqual([0, 0, -1]);
  });

  it("invalidateCalibration clears cHead but the IMU stays bolted on (imuMounting survives)", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    s.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");

    s.invalidateCalibration();

    expect(s.getCHead()).toBeUndefined();
    expect(s.get().orientation).toBeUndefined();
    expect(s.get().solvedAt).toBeUndefined();
    expect(s.getImuMounting()?.dBase).toEqual([0, 0, -1]);
  });

  it("setRigLocation and clear both drop imuMounting (a new rig means re-characterize)", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);

    s.setRigLocation(1, 2, 3);
    expect(s.getImuMounting()).toBeUndefined();

    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    s.clear();
    expect(s.getImuMounting()).toBeUndefined();
  });
});
