import { describe, it, expect } from "vitest";
import { calibrationSteps } from "../dashboard/public/step-gate.js";

const base = {
  calibration: { calibrated: false, provisional: false, rig: null, sightings: [], imuMounting: null },
  adsb: { aircraft: [] },
};
const byId = (s: any[], id: string) => s.find((x: any) => x.id === id);

describe("calibrationSteps", () => {
  it("blocks everything after rig location when it is unset", () => {
    const s = calibrationSteps(base);
    expect(byId(s, "rig-location").available).toBe(true);
    expect(byId(s, "imu").blocked).toBe(true);
    expect(byId(s, "imu").reason).toMatch(/rig location/i);
  });

  it("unblocks the IMU sweep once the rig location is set", () => {
    const s = calibrationSteps({ ...base, calibration: { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } } });
    expect(byId(s, "rig-location").done).toBe(true);
    expect(byId(s, "imu").available).toBe(true);
    expect(byId(s, "imu").blocked).toBe(false);
  });

  it("north-zero requires the IMU sweep -- and says so", () => {
    const s = calibrationSteps({ ...base, calibration: { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } } });
    expect(byId(s, "north-zero").blocked).toBe(true);
    expect(byId(s, "north-zero").reason).toMatch(/imu/i);
  });

  it("sighting 1 needs a provisional orientation", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 } };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "sight-1").blocked).toBe(true);
    const withProv = { ...cal, provisional: true };
    expect(byId(calibrationSteps({ ...base, calibration: withProv }), "sight-1").available).toBe(true);
  });

  it("sighting 2 is blocked until sighting 1 exists", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "sight-2").blocked).toBe(true);
    const one = { ...cal, sightings: [{ label: "QXE2320", panDeg: 10, tiltDeg: 35 }] };
    expect(byId(calibrationSteps({ ...base, calibration: one }), "sight-2").available).toBe(true);
  });

  it("solve is blocked until two sightings exist, and the reason says how many are missing", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true,
                  sightings: [{ label: "A", panDeg: 10, tiltDeg: 35 }] };
    const s = byId(calibrationSteps({ ...base, calibration: cal }), "solve");
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/2 sightings|second sighting/i);
  });

  it("solve becomes available with two sightings", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 }, provisional: true,
                  sightings: [{ label: "A", panDeg: 10, tiltDeg: 35 }, { label: "B", panDeg: 200, tiltDeg: 8 }] };
    expect(byId(calibrationSteps({ ...base, calibration: cal }), "solve").available).toBe(true);
  });

  it("every step is done once calibrated", () => {
    const cal = { calibrated: true, provisional: false, rig: { lat: 1, lon: 2, height: 3 },
                  imuMounting: { rmsDeg: 1.4 }, sightings: [{}, {}] };
    expect(calibrationSteps({ ...base, calibration: cal }).every((x: any) => x.done)).toBe(true);
  });

  it("a blocked step always carries a human reason -- never blocked with an empty reason", () => {
    for (const st of calibrationSteps(base)) {
      if (st.blocked) expect(String(st.reason).length).toBeGreaterThan(0);
    }
  });

  it("tolerates a missing/degraded calibration payload without throwing", () => {
    expect(() => calibrationSteps({})).not.toThrow();
    expect(() => calibrationSteps({ calibration: null })).not.toThrow();
  });

  // Regression pin for review finding C-1: after the FIRST sighting is
  // recorded, addSighting (calibration.ts) clears the orientation but not
  // orientationProvisional -- the daemon-side quirk this task deliberately
  // leaves alone. The fix lives in get_calibration (src/geo-tools.ts), which
  // now reports `provisional: false` in exactly this state (see
  // test/geo-tools.test.ts's own regression pin for the daemon side). This
  // test pins the CLIENT half: once the wire correctly says
  // provisional:false, north-zero must no longer read as done -- an
  // operator following the checklist needs to see that tracking is no
  // longer possible and a fresh north-zero is the way back, not silently
  // reach a "Sighting 2" that can never actually be reached.
  it("north-zero is NOT done once the wire correctly reports provisional:false after a sighting cleared the orientation (C-1)", () => {
    const cal = {
      ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 },
      provisional: false, sightings: [{ label: "QXE2320", panDeg: 10, tiltDeg: 35 }],
    };
    const northZero = byId(calibrationSteps({ ...base, calibration: cal }), "north-zero");
    expect(northZero.done).toBe(false);
    // Not stuck "blocked" either (the IMU sweep is already done) -- it reads
    // as the next available action, i.e. the real way back to a usable
    // orientation.
    expect(northZero.available).toBe(true);
  });
});
