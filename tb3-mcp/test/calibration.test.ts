import { describe, it, expect, afterEach } from "vitest";
import { CalibrationStore } from "../src/calibration.js";
import {
  Mat3, Vec3, matMul, rotZ, rotX, deg2rad, normalize, angleBetweenDeg,
} from "../src/geo/vec3.js";
import { applyTiltOffset } from "../src/geo/rezero.js";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from "node:fs";
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

  it("setOrientation (a plain TRIAD re-solve) clears a stale cHead from a prior gravity solve", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    s.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");
    expect(s.getCHead()).toBeDefined();

    // A later plain-TRIAD re-solve (e.g. re-using the same 2 stored sightings,
    // no fresh gravity sighting) must not leave the OLD c_head paired with the
    // NEW R -- setOrientation is TRIAD-only and has no c_head of its own.
    s.setOrientation(R, "2026-07-23T00:00:00.000Z");

    expect(s.getCHead()).toBeUndefined();
    expect(s.getOrientation()).toEqual(R);
    expect(s.isCalibrated()).toBe(true);
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

  // Regression pin for the 2026-07-28 dashboard-redesign blocker: rmsDeg is
  // the value get_calibration/CalibrationRawZ/DashboardState.calibration
  // carry all the way to the operator (see geo-tools.ts's get_calibration and
  // dashboard/public/step-gate.js's "rms X.X°" detail line) -- if it silently
  // stopped round-tripping through the store, that entire chain would still
  // "work" (imuMounting present) but always show a blank/undefined RMS.
  it("setImuMounting persists rmsDeg, and getImuMounting returns it back unchanged", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    a.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1], 1.23);
    expect(a.getImuMounting()?.rmsDeg).toBe(1.23);

    // Also survives a reload from disk, not just the in-memory instance.
    const b = new CalibrationStore(f);
    b.load();
    expect(b.getImuMounting()?.rmsDeg).toBe(1.23);
  });

  it("setImuMounting without an rmsDeg (existing 2-arg call sites) leaves it undefined, not a stale value", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1], 1.23);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]); // no rmsDeg this time
    expect(s.getImuMounting()?.rmsDeg).toBeUndefined();
  });
});

describe("CalibrationStore provisional orientation (set_north_zero)", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");

  it("setProvisionalOrientation sets an orientation but is reported as provisional, NOT calibrated", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");

    expect(s.getOrientation()).toEqual(R); // usable for tracking/point_at's inverse math
    expect(s.isProvisional()).toBe(true);
    // The core safety property: a provisional seed must NEVER read as a
    // solved calibration, even though it has both a rig and an orientation.
    expect(s.isCalibrated()).toBe(false);
  });

  it("a real TRIAD solve (setOrientation) supersedes and clears the provisional flag", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");
    expect(s.isProvisional()).toBe(true);

    s.setOrientation(R, "2026-07-27T01:00:00Z");

    expect(s.isProvisional()).toBe(false);
    expect(s.isCalibrated()).toBe(true);
  });

  it("a real gravity-anchored solve (setGravityCalibration) also clears the provisional flag", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");

    s.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-27T01:00:00Z");

    expect(s.isProvisional()).toBe(false);
    expect(s.isCalibrated()).toBe(true);
  });

  it("invalidateCalibration clears the provisional flag along with the orientation", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");

    s.invalidateCalibration();

    expect(s.getOrientation()).toBeUndefined();
    expect(s.isProvisional()).toBe(false);
  });

  it("round-trips provisional through a reload", () => {
    const f = file();
    const a = new CalibrationStore(f);
    a.load();
    a.setRigLocation(45.5, -122.6, 50);
    a.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");

    const b = new CalibrationStore(f);
    b.load();
    expect(b.isProvisional()).toBe(true);
    expect(b.isCalibrated()).toBe(false);
    expect(b.getOrientation()).toEqual(R);
  });

  it("REGRESSION: without excluding provisional, isCalibrated() would be true for a mere set_north_zero seed", () => {
    // Documents exactly what isCalibrated()'s `orientationProvisional !== true`
    // clause guards against: rig + orientation alone (the OLD two-field
    // check) both being set is NOT sufficient once a provisional seed exists.
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setProvisionalOrientation(R, "2026-07-27T00:00:00Z");
    const p = s.get();
    const oldStyleCalibrated = p.rig !== undefined && p.orientation !== undefined; // pre-fix formula
    expect(oldStyleCalibrated).toBe(true); // would have been miscounted as calibrated
    expect(s.isCalibrated()).toBe(false);  // the fixed formula correctly excludes it
  });
});

// FIELD BUG 2026-07-29. The operator ran the guided procedure: rig location,
// IMU sweep, set_north_zero, then tracked a plane and sighted it. After that
// first sighting [Track] went dead on every aircraft row while [Sight]
// stayed live -- so there was no way to track the SECOND plane the procedure
// requires, and calibration could not be completed at all.
//
// Cause: addSighting cleared `orientation` unconditionally while leaving the
// `orientationProvisional` FLAG set, so the store reported "provisional" with
// no orientation to point by. Clearing is right for a SOLVED orientation (a
// new sighting invalidates the pair it was computed from) but wrong for a
// set_north_zero SEED: the seed is a bootstrap that exists precisely so the
// rig can track well enough to collect sightings, and it is not derived from
// them.
describe("addSighting and the provisional seed (field bug 2026-07-29)", () => {
  it("KEEPS a provisional orientation so the next plane can still be tracked", () => {
    const s = new CalibrationStore(tmpFile());
    s.load();
    s.setRigLocation(33.38, -112.14, 341);
    s.setProvisionalOrientation(R, "2026-07-29T00:00:00Z");
    expect(s.getOrientation()).toBeDefined();

    s.addSighting({ lat: 33.5, lon: -112.2, height: 3000, panDeg: 10, tiltDeg: 20 });

    // The whole point: still pointable, so the operator can track plane #2.
    expect(s.getOrientation()).toBeDefined();
    expect(s.isProvisional()).toBe(true);
    expect(s.isCalibrated()).toBe(false); // a seed is never a solve
    expect(s.get().sightings.length).toBe(1);
  });

  it("still clears a SOLVED orientation -- a new sighting invalidates the pair it came from", () => {
    const s = new CalibrationStore(tmpFile());
    s.load();
    s.setRigLocation(33.38, -112.14, 341);
    s.setOrientation(R, "2026-07-29T00:00:00Z");
    expect(s.isCalibrated()).toBe(true);

    s.addSighting({ lat: 33.5, lon: -112.2, height: 3000, panDeg: 10, tiltDeg: 20 });

    expect(s.getOrientation()).toBeUndefined();
    expect(s.isCalibrated()).toBe(false);
    expect(s.get().solvedAt).toBeUndefined();
  });

  it("never leaves the provisional FLAG set with no orientation behind it", () => {
    // The precise inconsistency that produced the dead [Track]: a store that
    // says "provisional" but cannot hand back a matrix.
    const s = new CalibrationStore(tmpFile());
    s.load();
    s.setRigLocation(33.38, -112.14, 341);
    s.setProvisionalOrientation(R, "2026-07-29T00:00:00Z");
    s.addSighting({ lat: 33.5, lon: -112.2, height: 3000, panDeg: 10, tiltDeg: 20 });
    s.addSighting({ lat: 33.9, lon: -111.8, height: 9000, panDeg: 80, tiltDeg: 35 });
    expect(s.isProvisional() && s.getOrientation() === undefined).toBe(false);
  });
});

describe("re-zero profile fields", () => {
  it("markRezeroNeeded sets the flag and stamps the boot id", () => {
    const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
    s.load();
    expect(s.needsRezero()).toBe(false);
    s.markRezeroNeeded(7);
    expect(s.needsRezero()).toBe(true);
    expect(s.getBootId()).toBe(7);
  });

  it("applyRezero clears the flag and persists orientation and cHead", () => {
    const I: Mat3 = [[1,0,0],[0,1,0],[0,0,1]];
    const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
    s.load();
    s.markRezeroNeeded(7);
    const c: Vec3 = [0, 1, 0];
    s.applyRezero(I, c, 7);
    expect(s.needsRezero()).toBe(false);
    expect(s.getOrientation()).toEqual(I);
    expect(s.getCHead()).toEqual(c);
  });

  it("a landmark round-trips through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    const a = new CalibrationStore(path); a.load();
    a.setLandmark({ label: "south tower", enu: [0, 1, 0], panDeg: 12, tiltDeg: 3, recordedAt: "2026-08-02T00:00:00Z" });
    const b = new CalibrationStore(path); b.load();
    expect(b.getLandmark()?.label).toBe("south tower");
    expect(b.getLandmark()?.enu).toEqual([0, 1, 0]);
  });

  it("a profile written before these fields existed still parses", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    writeFileSync(path, JSON.stringify({ version: 1, sightings: [] }));
    const s = new CalibrationStore(path);
    expect(() => s.load()).not.toThrow();
    expect(s.needsRezero()).toBe(false);
  });
});

describe("baseline and origin offset", () => {
  const store = () => new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
  const R0: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
  const C0: Vec3 = normalize([0.02, 0.99, 0.08]);

  it("getOrientation/getCHead derive from baseline + offset", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    expect(s.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    // With a zero offset the derived values ARE the baseline.
    expect(s.getOrientation()).toEqual(R0);
    expect(s.getCHead()).toEqual(C0);

    s.setOriginOffset(16.4, 23.33, 2);
    expect(s.getOriginOffset()).toEqual({ panDeg: 16.4, tiltDeg: 23.33 });
    expect(angleBetweenDeg(s.getCHead()!, applyTiltOffset(C0, 23.33))).toBeLessThan(1e-9);
    expect(s.getOrientation()).not.toEqual(R0);   // pan folded in
  });

  // The property the whole design exists for.
  it("setOriginOffset ASSIGNS — applying twice equals applying once", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    s.setOriginOffset(16.4, 23.33, 2);
    const afterFirst = JSON.stringify(s.get());
    s.setOriginOffset(16.4, 23.33, 2);
    expect(JSON.stringify(s.get())).toBe(afterFirst);
  });

  it("setOriginOffset clears needsRezero and stamps bootId", () => {
    const s = store();
    s.setBaseline(R0, C0, new Date().toISOString());
    s.markRezeroNeeded(3);
    s.setOriginOffset(1, 2, 3);
    expect(s.needsRezero()).toBe(false);
    expect(s.getBootId()).toBe(3);
  });

  // Migration: a pre-baseline profile must keep pointing identically.
  it("adopts a legacy orientation/cHead as the baseline with a zero offset", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json");
    const a = new CalibrationStore(path); a.load();
    a.setGravityCalibration(R0, C0, new Date().toISOString());
    // Strip the baseline to simulate a profile written before this change.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.baseline; delete raw.originOffset;
    writeFileSync(path, JSON.stringify(raw));

    const b = new CalibrationStore(path); b.load();
    expect(b.getOrientation()).toEqual(R0);
    expect(b.getCHead()).toEqual(C0);
    expect(b.getOriginOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    expect(b.getBaseline()).toBeDefined();
  });
});
