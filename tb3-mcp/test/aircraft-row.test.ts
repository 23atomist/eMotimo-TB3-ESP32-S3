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

  it("allows sighting whenever the rig location is known and neither gate is tripped", () => {
    const a = aircraftRowActions(row, { calibration: { rig: { lat: 1, lon: 2, height: 3 } } });
    expect(a.canSight).toBe(true);
  });

  it("refuses sighting without a rig location", () => {
    const a = aircraftRowActions(row, { calibration: {} });
    expect(a.canSight).toBe(false);
    expect(a.sightReason).toMatch(/location/i);
  });

  // Review finding C-2: sight_aircraft commands no motion, but it is NOT
  // exempt from E-STOP -- it records the rig's CURRENT pan/tilt, and an
  // E-STOP can halt a tracking slew wherever it happens to land, so the
  // instant it latches the rig may no longer be centred on the target it's
  // supposedly sighting. The drawer's [Sight it] strip (sightGateOk,
  // procedure-actions.js) and the physical joystick's Sight button
  // (app.js) both already refuse under estopLatched||sunLocked -- this
  // aircraft-row [Sight] button was the one surface of the three that
  // didn't.
  it("refuses sighting under E-STOP, even with a known rig location (C-2)", () => {
    const a = aircraftRowActions(row, {
      calibration: { rig: { lat: 1, lon: 2, height: 3 } }, estopLatched: true,
    });
    expect(a.canSight).toBe(false);
    expect(a.sightReason).toMatch(/stop/i);
  });

  it("trackable:null (pre-calibration unknown) is not treated as false", () => {
    const a = aircraftRowActions({ ...row, trackable: null }, { calibration: { provisional: true } });
    expect(a.canTrack).toBe(true);
  });

  // Regression pin for review finding C-1: once get_calibration's wire fix
  // (src/geo-tools.ts) reports provisional:false after a sighting has
  // cleared the orientation (see test/geo-tools.test.ts's own pin for the
  // daemon side, and test/step-gate.test.ts's pin for north-zero's
  // done-ness), [Track] must refuse and say why -- matching
  // TrackingSession.start()'s own real refusal ("not calibrated -- run
  // solve_calibration first") instead of the pre-fix UI, which kept
  // claiming trackable right up to a failed POST.
  it("refuses tracking once the wire correctly reports provisional:false after a sighting cleared the orientation (C-1)", () => {
    const a = aircraftRowActions(row, { calibration: { calibrated: false, provisional: false } });
    expect(a.canTrack).toBe(false);
    expect(a.trackReason).toMatch(/calibrat|north zero/i);
  });
});
