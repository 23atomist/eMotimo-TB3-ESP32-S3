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

describe("mergeState carries adsb.aircraft with flags", () => {
  it("passes the full plane list through under adsb.aircraft", () => {
    const row: AircraftRow = {
      hex: "abc123", callsign: "TEST", category: null, squawk: null, altitude_m: 6000,
      ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 10, range_km: 30, est_track_sec: 60,
      reachable: true, sunSafe: true, slewOk: true, inSector: false, trackable: false,
    };
    const s = {
      deviceStatus: { ok: false, error: "x" }, rigDirect: { ok: false, error: "x" },
      tracking: { ok: false, error: "x" }, tracked: { ok: false, error: "x" },
      calibration: { ok: false, error: "x" }, sun: { ok: false, error: "x" },
      services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
      adsb: { ok: true, value: { rawCount: 5, aircraft: [row] } },
      camera: { enabled: false, streaming: false, viewers: 0 },
    } as unknown as SourceInputs;
    const merged = mergeState(s, 0);
    expect(merged.adsb.aircraft).toHaveLength(1);
    expect(merged.adsb.aircraft[0].inSector).toBe(false);
    expect(merged.adsb.aircraft[0].trackable).toBe(false);
  });
});
