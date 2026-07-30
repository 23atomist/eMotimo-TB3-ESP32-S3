import { describe, it, expect } from "vitest";
import { calibrationSteps, sightingSeparationDeg } from "../dashboard/public/step-gate.js";

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

// FIELD 2026-07-30. The rig held TWO BYTE-IDENTICAL sightings -- same
// aircraft position, same pan/tilt, 0.0deg apart -- because the same plane
// was recorded twice. This list counted them, marked Sighting 2 done, and
// offered Solve. An orientation cannot be derived from one direction, so the
// solve would have been arbitrary and the badge would have read CALIBRATED
// over it. Counting sightings is not enough; the GAP is what matters.
describe("sighting separation gating (field bug 2026-07-30)", () => {
  const sighting = (panDeg: number, tiltDeg: number) => ({ lat: 33.3, lon: -112.1, height: 3000, panDeg, tiltDeg });
  const withSightings = (sightings: unknown[]) => ({
    calibration: {
      rig: { lat: 33.38, lon: -112.14, height: 341 },
      imuMounting: { rmsDeg: 1.4 }, provisional: true, sightings,
    },
  });
  const stepById = (state: unknown, id: string) =>
    calibrationSteps(state).find((s: { id: string }) => s.id === id)!;

  it("blocks Solve when the two sightings are the same direction", () => {
    const s = withSightings([sighting(-53.59, 5.06), sighting(-53.59, 5.06)]); // the real pair
    const solve = stepById(s, "solve");
    expect(solve.blocked).toBe(true);
    expect(solve.reason).toMatch(/0\.0° apart/);
    expect(solve.reason).toMatch(/20°/); // says what is actually required
  });

  it("does not mark Sighting 2 done just because a second row exists", () => {
    const s = withSightings([sighting(-53.59, 5.06), sighting(-53.59, 5.06)]);
    expect(stepById(s, "sight-2").done).toBe(false);
  });

  it("allows Solve once the pair genuinely spans the sky", () => {
    const s = withSightings([sighting(-53.6, 5.1), sighting(20.4, 40.2)]);
    expect(stepById(s, "sight-2").done).toBe(true);
    expect(stepById(s, "solve").blocked).toBe(false);
  });

  it("still reports the plain count when there are fewer than two", () => {
    expect(stepById(withSightings([sighting(0, 10)]), "solve").reason).toMatch(/needs 2 sightings \(have 1\)/);
  });

  it("treats an unmeasurable gap as NOT satisfied, never as satisfied", () => {
    const s = withSightings([{ lat: 1, lon: 2, height: 3 }, { lat: 1, lon: 2, height: 3 }]);
    const solve = stepById(s, "solve");
    expect(solve.blocked).toBe(true);
    expect(solve.reason).toMatch(/pan\/tilt/);
  });

  it("accounts for azimuth converging at high tilt", () => {
    // 30deg of pan near the zenith is a much smaller angle on the sky than
    // 30deg at the horizon -- without the cosine these would read as equal.
    const low = sightingSeparationDeg(sighting(0, 0), sighting(30, 0))!;
    const high = sightingSeparationDeg(sighting(0, 80), sighting(30, 80))!;
    expect(high).toBeLessThan(low / 2);
  });
});
