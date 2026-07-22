import { describe, it, expect } from "vitest";
import { mergeState, type SourceInputs, type ServicesState } from "../src/dashboard/state.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (error: string) => ({ ok: false as const, error });
const SVC: ServicesState = { readsb: "active", tb3mcp: "active", tb3agent: "inactive", llama: "inactive" };

function inputs(over: Partial<SourceInputs> = {}): SourceInputs {
  return {
    deviceStatus: ok({ connected: true, pan_deg: 10, tilt_deg: 20, moving: false, battery_v: 12.1, stale: false, last_update_age_ms: 100 }),
    rigDirect: ok({ connected: true, moving: false, batteryV: 12.1, panSteps: 4444, tiltSteps: 8888,
      imu: { ok: true, pitchDeg: 1, rollDeg: 2, tempC: 25, pressHpa: 1008 }, joyLatched: false }),
    tracking: ok({ state: "stopped", label: null, target_azimuth_deg: null, target_elevation_deg: null,
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false }),
    tracked: ok({ hex: null }),
    calibration: ok({ calibrated: true, rig: { lat: 33, lon: -112, height: 0 }, sightings: [], solved_at: "2026-07-19T00:00:00Z" }),
    sun: ok({ state: "monitoring", locked: false, separationDeg: 80 }),
    services: SVC,
    adsb: ok({ rawCount: 12, trackable: [] }),
    camera: { enabled: false, source: "v4l2", streaming: false, viewers: 0 },
    ...over,
  };
}

describe("mergeState mode derivation", () => {
  it("idle when agent off and not tracking", () => {
    expect(mergeState(inputs(), 1000).mode).toBe("idle");
  });
  it("manual when agent off but tracking active", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false }),
      tracked: ok({ hex: "abc123" }) }), 1000);
    expect(s.mode).toBe("manual");
    expect(s.tracking.hex).toBe("abc123");
    expect(s.tracking.callsign).toBe("UAL1");
    expect(s.tracking.targetAzDeg).toBe(90);
  });
  it("autonomous when the agent service is active", () => {
    const s = mergeState(inputs({ services: { ...SVC, tb3agent: "active" },
      tracking: ok({ state: "tracking", label: "x", target_azimuth_deg: 1, target_elevation_deg: 1,
        target_range_m: 1, pointing_error_deg: 1, pan_limited: false, tilt_limited: false }) }), 1000);
    expect(s.mode).toBe("autonomous");
  });
});

describe("mergeState degradation", () => {
  it("a failed source marks its field + records an error, others intact", () => {
    const s = mergeState(inputs({ deviceStatus: err("ECONNREFUSED"), rigDirect: err("timeout") }), 1000);
    expect(s.rig.connected).toBe(false);          // neither source up
    expect(s.rig.panDeg).toBeNull();
    expect(s.errors.some((e) => e.includes("ECONNREFUSED"))).toBe(true);
    expect(s.services.readsb).toBe("active");      // unaffected
    expect(s.calibration.calibrated).toBe(true);
  });
  it("rig connected via direct even when the daemon get_status fails", () => {
    const s = mergeState(inputs({ deviceStatus: err("daemon down") }), 1000);
    expect(s.rig.connected).toBe(true);            // rigDirect still up
    expect(s.rig.imu?.ok).toBe(true);
  });
  it("stamps ts and never throws on all-failed", () => {
    const allErr = err("x");
    const s = mergeState({ deviceStatus: allErr, rigDirect: allErr, tracking: allErr, tracked: allErr,
      calibration: allErr, sun: allErr, services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
      adsb: allErr, camera: { enabled: false, source: "v4l2", streaming: false, viewers: 0 } }, 4242);
    expect(s.ts).toBe(4242);
    expect(s.mode).toBe("idle");
    expect(s.rig.connected).toBe(false);
    expect(s.adsb.trackable).toEqual([]);
  });

  it("carries the camera streamer status through unchanged", () => {
    const s = mergeState(inputs({ camera: { enabled: true, source: "gphoto2", streaming: true, viewers: 2 } }), 1000);
    expect(s.camera).toEqual({ enabled: true, source: "gphoto2", streaming: true, viewers: 2 });
  });
});
