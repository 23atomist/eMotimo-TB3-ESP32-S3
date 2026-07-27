import { describe, it, expect } from "vitest";
import { deriveTrackable, mergeState, type SourceInputs, type AircraftRow } from "../src/dashboard/state.js";

const flags = (o: Partial<{ reachable: boolean; sunSafe: boolean; slewOk: boolean; inSector: boolean }> = {}) =>
  ({ reachable: true, sunSafe: true, slewOk: true, inSector: true, ...o });

describe("deriveTrackable", () => {
  it("is true only when all four flags are true", () => {
    expect(deriveTrackable(flags())).toBe(true);
    expect(deriveTrackable(flags({ reachable: false }))).toBe(false);
    expect(deriveTrackable(flags({ sunSafe: false }))).toBe(false);
    expect(deriveTrackable(flags({ slewOk: false }))).toBe(false);
    expect(deriveTrackable(flags({ inSector: false }))).toBe(false);
  });
});

describe("mergeState carries adsb.aircraft + adsb.trackable independently", () => {
  it("passes both plane lists through with their own flags", () => {
    // aircraft: every plane seen (for the mini-map) — includes an untrackable
    // one. trackable: the dedicated trackable-only scan (for the list) — a
    // different, narrower array, not derived from `aircraft` by mergeState.
    const untrackableRow: AircraftRow = {
      hex: "abc123", callsign: "TEST", category: null, squawk: null, altitude_m: 6000,
      ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 10, range_km: 30, est_track_sec: 60,
      reachable: true, sunSafe: true, slewOk: true, inSector: false, trackable: false,
    };
    const trackableRow: AircraftRow = {
      hex: "def456", callsign: "OK1", category: null, squawk: null, altitude_m: 5000,
      ground_speed_kt: 380, azimuth_deg: 45, elevation_deg: 20, range_km: 15, est_track_sec: 90,
      reachable: true, sunSafe: true, slewOk: true, inSector: true, trackable: true,
    };
    const s = {
      deviceStatus: { ok: false, error: "x" }, rigDirect: { ok: false, error: "x" },
      tracking: { ok: false, error: "x" }, tracked: { ok: false, error: "x" },
      calibration: { ok: false, error: "x" }, sun: { ok: false, error: "x" }, capture: { ok: false, error: "x" },
      services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
      adsb: { ok: true, value: { rawCount: 5, aircraft: [untrackableRow, trackableRow], trackable: [trackableRow] } },
      camera: { enabled: false, streaming: false, viewers: 0 },
    } as unknown as SourceInputs;
    const merged = mergeState(s, 0);
    expect(merged.adsb.aircraft).toHaveLength(2);
    expect(merged.adsb.aircraft[0].inSector).toBe(false);
    expect(merged.adsb.aircraft[0].trackable).toBe(false);
    expect(merged.adsb.trackable).toHaveLength(1);
    expect(merged.adsb.trackable[0].hex).toBe("def456");
    expect(merged.adsb.trackable[0].trackable).toBe(true);
  });
});
