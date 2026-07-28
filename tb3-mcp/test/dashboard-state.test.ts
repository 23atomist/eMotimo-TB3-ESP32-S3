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
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 }),
    tracked: ok({ hex: null }),
    calibration: ok({ calibrated: true, rig: { lat: 33, lon: -112, height: 0 }, sightings: [], solved_at: "2026-07-19T00:00:00Z", provisional: false }),
    sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }),
    services: SVC,
    adsb: ok({ rawCount: 12, aircraft: [], trackable: [] }),
    capture: ok({ autoEnabled: true, recording: false, passIcao: null, lastSnapshot: null, lastError: null, lastSkipReason: null }),
    camera: { enabled: false, streaming: false, viewers: 0 },
    ...over,
  };
}

describe("mergeState mode derivation", () => {
  it("idle when agent off and not tracking", () => {
    expect(mergeState(inputs(), 1000).mode).toBe("idle");
  });
  it("manual when agent off but tracking active", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 }),
      tracked: ok({ hex: "abc123" }) }), 1000);
    expect(s.mode).toBe("manual");
    expect(s.tracking.hex).toBe("abc123");
    expect(s.tracking.callsign).toBe("UAL1");
    expect(s.tracking.targetAzDeg).toBe(90);
  });
  it("autonomous when the agent service is active", () => {
    const s = mergeState(inputs({ services: { ...SVC, tb3agent: "active" },
      tracking: ok({ state: "tracking", label: "x", target_azimuth_deg: 1, target_elevation_deg: 1,
        target_range_m: 1, pointing_error_deg: 1, pan_limited: false, tilt_limited: false,
        offset_pan_deg: 0, offset_tilt_deg: 0 }) }), 1000);
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
      adsb: allErr, capture: allErr, camera: { enabled: false, streaming: false, viewers: 0 } }, 4242);
    expect(s.ts).toBe(4242);
    expect(s.mode).toBe("idle");
    expect(s.rig.connected).toBe(false);
    expect(s.adsb.aircraft).toEqual([]);
    expect(s.adsb.trackable).toEqual([]);
    expect(s.capture).toBeNull();
  });

  it("carries the camera streamer status through unchanged", () => {
    const s = mergeState(inputs({ camera: { enabled: true, streaming: true, viewers: 2 } }), 1000);
    expect(s.camera).toEqual({ enabled: true, streaming: true, viewers: 2 });
  });

  it("carries the jog ramp config through unchanged when present", () => {
    const s = mergeState(inputs({ jog: { maxJogDps: 12, jogRampSeconds: 2.5, jogMinDps: 0.5 } }), 1000);
    expect(s.jog).toEqual({ maxJogDps: 12, jogRampSeconds: 2.5, jogMinDps: 0.5 });
  });

  it("defaults the jog ramp config (mirroring config.ts) when a fixture omits it", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.jog).toEqual({ maxJogDps: 19, jogRampSeconds: 4, jogMinDps: 1 });
  });

  // --- Fix round: a startup camera CONFIG error (item 1, final review) must
  // surface in `errors` every tick, independent of every polled Result leg. ---
  it("surfaces a persistent cameraError in `errors`, alongside a healthy poll", () => {
    const s = mergeState(inputs({ cameraError: "cameraFfmpegBin=\"/nope\" cannot be executed (ENOENT)" }), 1000);
    expect(s.errors.some((e) => e.includes("ENOENT"))).toBe(true);
    // Nothing else degrades -- this is a static startup fact, not a poll failure.
    expect(s.rig.connected).toBe(true);
    expect(s.calibration.calibrated).toBe(true);
  });

  it("omits any camera error when cameraError is absent/null", () => {
    const s = mergeState(inputs({ cameraError: null }), 1000);
    expect(s.errors).toEqual([]);
  });
});

describe("mergeState carries the drift-calibration offset + provisional flag", () => {
  it("passes the tracking aim-offset through", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 2.3, offset_tilt_deg: -0.5 }) }), 1000);
    expect(s.tracking.offsetPanDeg).toBe(2.3);
    expect(s.tracking.offsetTiltDeg).toBe(-0.5);
  });
  it("defaults the offset to 0 when the tracking source is degraded", () => {
    const s = mergeState(inputs({ tracking: err("get_tracking_status failed") }), 1000);
    expect(s.tracking.offsetPanDeg).toBe(0);
    expect(s.tracking.offsetTiltDeg).toBe(0);
  });
  it("passes a provisional calibration through distinctly from a solved one", () => {
    const s = mergeState(inputs({ calibration: ok({
      calibrated: false, rig: { lat: 33, lon: -112, height: 0 }, sightings: [],
      solved_at: "2026-07-27T00:00:00Z", provisional: true,
    }) }), 1000);
    expect(s.calibration.provisional).toBe(true);
    expect(s.calibration.calibrated).toBe(false);
  });
  it("defaults provisional to false when the calibration source is degraded", () => {
    const s = mergeState(inputs({ calibration: err("get_calibration failed") }), 1000);
    expect(s.calibration.provisional).toBe(false);
  });
});

describe("mergeState carries the effective travel limits (rigview.js's envelope)", () => {
  it("passes the effective range through when the poll succeeds", () => {
    const s = mergeState(inputs({
      limits: ok({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 }),
    }), 1000);
    expect(s.limits).toEqual({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 });
  });

  it("collapses to null when the limits poll leg fails", () => {
    const s = mergeState(inputs({ limits: err("get_taught_limits failed") }), 1000);
    expect(s.limits).toBeNull();
    expect(s.errors.some((e) => e.includes("get_taught_limits failed"))).toBe(true);
  });

  it("collapses to null when a fixture/test omits it (pre-feature convention)", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.limits).toBeNull();
  });
});

describe("mergeState carries the sun-guard enabled flag", () => {
  it("passes enabled:true through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }) }), 1000);
    expect(s.sunGuard.enabled).toBe(true);
  });
  it("passes enabled:false through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "disabled", locked: false, separationDeg: null, enabled: false }) }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
  it("defaults enabled to false when the sun source is degraded", () => {
    const s = mergeState(inputs({ sun: err("get_sun failed") }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
});
