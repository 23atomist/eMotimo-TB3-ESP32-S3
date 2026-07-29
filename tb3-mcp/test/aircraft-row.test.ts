import { describe, it, expect } from "vitest";
import { aircraftRowActions } from "../dashboard/public/cockpit.js";

const row = { hex: "a1b2c3", callsign: "AAL1", azimuth_deg: 47, elevation_deg: 31, range_km: 8.2, trackable: true };

describe("aircraftRowActions", () => {
  it("allows tracking a trackable aircraft when calibrated", () => {
    const a = aircraftRowActions(row, { calibration: { calibrated: true } });
    expect(a.canTrack).toBe(true);
  });

  it("allows tracking under a PROVISIONAL orientation -- that is the whole point", () => {
    // Drift calibration requires tracking BEFORE a real solve exists.
    const a = aircraftRowActions(row, { calibration: { provisional: true } });
    expect(a.canTrack).toBe(true);
  });

  it("refuses tracking with no orientation at all, and says why", () => {
    const a = aircraftRowActions(row, { calibration: {} });
    expect(a.canTrack).toBe(false);
    expect(a.trackReason).toMatch(/calibrat|north zero/i);
  });

  it("refuses tracking under E-STOP", () => {
    const a = aircraftRowActions(row, { calibration: { calibrated: true }, estopLatched: true });
    expect(a.canTrack).toBe(false);
    expect(a.trackReason).toMatch(/stop/i);
  });

  it("allows sighting whenever the rig location is known -- sighting does not move the rig", () => {
    const a = aircraftRowActions(row, { calibration: { rig: { lat: 1, lon: 2, height: 3 } } });
    expect(a.canSight).toBe(true);
  });

  it("refuses sighting without a rig location", () => {
    const a = aircraftRowActions(row, { calibration: {} });
    expect(a.canSight).toBe(false);
    expect(a.sightReason).toMatch(/location/i);
  });

  it("trackable:null (pre-calibration unknown) is not treated as false", () => {
    const a = aircraftRowActions({ ...row, trackable: null }, { calibration: { provisional: true } });
    expect(a.canTrack).toBe(true);
  });
});
