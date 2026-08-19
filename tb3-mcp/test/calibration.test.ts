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

  // Inverted from the two-sighting era, where addSighting tore the solve down
  // because the pair it came from was being replaced. With an unbounded list a
  // sighting only ADDS evidence, and callers re-solve from the whole list, so
  // tearing anything down would just reopen the 2026-07-29 dead-[Track] window.
  it("addSighting keeps the solved orientation AND the IMU mounting", () => {
    const s = new CalibrationStore(file());
    s.load();
    s.setRigLocation(45.5, -122.6, 50);
    s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, -1]);
    s.setGravityCalibration([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [-0.52, 0.735, 0.434], "2026-07-22T00:00:00Z");

    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });

    expect(s.get().orientation).toBeDefined();
    expect(s.get().solvedAt).toBe("2026-07-22T00:00:00Z");
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

  it("KEEPS a SOLVED orientation -- a sighting adds evidence, it does not invalidate", () => {
    const s = new CalibrationStore(tmpFile());
    s.load();
    s.setRigLocation(33.38, -112.14, 341);
    s.setOrientation(R, "2026-07-29T00:00:00Z");
    expect(s.isCalibrated()).toBe(true);

    s.addSighting({ lat: 33.5, lon: -112.2, height: 3000, panDeg: 10, tiltDeg: 20 });

    // Still pointable. Without a gravity anchor there is nothing to re-solve
    // FROM, so the existing solve must stand rather than be torn down.
    expect(s.getOrientation()).toBeDefined();
    expect(s.isCalibrated()).toBe(true);
    expect(s.get().solvedAt).toBe("2026-07-29T00:00:00Z");
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

describe("CalibrationStore sighting list", () => {
  it("keeps more than two sightings", () => {
    const s = new CalibrationStore(tmpFile());
    for (let i = 0; i < 5; i++) s.addSighting({ lat: i, lon: 2, height: 3, panDeg: i, tiltDeg: 5 });
    expect(s.get().sightings).toHaveLength(5);
  });

  it("assigns a stable id and timestamp to every sighting", () => {
    const s = new CalibrationStore(tmpFile());
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.addSighting({ lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10 });
    const [a, b] = s.get().sightings;
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toEqual(b.id);
    expect(Date.parse(a.atIso!)).not.toBeNaN();
  });

  it("removes a sighting by id and reports whether it matched", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.addSighting({ lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10 });
    const id = s.get().sightings[0].id!;

    expect(s.removeSighting(id)).toBe(true);
    expect(s.get().sightings).toHaveLength(1);
    expect(s.removeSighting("nope")).toBe(false);

    const reloaded = new CalibrationStore(f);
    reloaded.load();
    expect(reloaded.get().sightings).toHaveLength(1);
  });

  it("clearSightings empties the list but keeps the rig location", () => {
    const s = new CalibrationStore(tmpFile());
    s.setRigLocation(33, -112, 341);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.clearSightings();
    expect(s.get().sightings).toEqual([]);
    expect(s.get().rig).toEqual({ lat: 33, lon: -112, height: 341 });
  });

  it("migrates a legacy two-sighting profile with no ids", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({
      version: 1,
      rig: { lat: 33, lon: -112, height: 341 },
      sightings: [
        { lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5, label: "OLD1" },
        { lat: 6, lon: 7, height: 8, panDeg: 9, tiltDeg: 10, label: "OLD2" },
      ],
    }));
    const s = new CalibrationStore(f);
    s.load();
    const got = s.get().sightings;
    expect(got).toHaveLength(2);
    expect(got[0].id).toBeTruthy();
    expect(got[1].id).toBeTruthy();
    expect(got[0].label).toBe("OLD1");
  });
});
