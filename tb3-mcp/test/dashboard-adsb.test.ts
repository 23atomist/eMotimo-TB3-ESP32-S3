import { describe, it, expect, vi, afterEach } from "vitest";
import { getAdsb } from "../src/dashboard/server.js";
import type { McpDashboardClient } from "../src/dashboard/client.js";
import type { Config } from "../src/config.js";
import type { AircraftRow } from "../src/dashboard/state.js";

const AIRCRAFT_ROW: AircraftRow = {
  hex: "abc123", callsign: "TEST", category: null, squawk: null, altitude_m: 6000,
  ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 10, range_km: 30, est_track_sec: 60,
  reachable: true, sunSafe: true, slewOk: true, inSector: true, trackable: true,
};

// getAdsb only reads cfg.adsbUrl (for the best-effort rawCount peek).
// Deliberately invalid so fetch() rejects synchronously -- no network, no
// timers -- keeping every test below fast and independent of
// ADSB_FETCH_TIMEOUT_MS.
const CFG = { adsbUrl: "not-a-valid-url" } as Config;

function fakeClient(over: {
  scanTrackable?: () => Promise<AircraftRow[]>;
  scanAircraft?: () => Promise<AircraftRow[]>;
}): McpDashboardClient {
  return {
    scanTrackable: over.scanTrackable ?? (async () => []),
    scanAircraft: over.scanAircraft ?? (async () => []),
  } as unknown as McpDashboardClient;
}

describe("getAdsb", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The operator's actual blocked case (see the field report this pins):
  // pre-calibration, the daemon correctly refuses scanTrackable() (no solved
  // mount orientation yet) while scanAircraft() correctly succeeds (rig
  // location alone is enough -- see 489313c). The old Promise.all let that
  // *expected* scanTrackable rejection discard the successful scanAircraft()
  // result too, leaving both lists empty. getAdsb must instead degrade
  // `trackable` to [] and still return the populated `aircraft` list.
  it("scanTrackable rejects, scanAircraft resolves -> ok, aircraft populated, trackable empty", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => { throw new Error("no solved mount orientation (R)"); },
        scanAircraft: async () => [AIRCRAFT_ROW],
      });

      const result = await getAdsb(client, CFG);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aircraft).toEqual([AIRCRAFT_ROW]);
        expect(result.value.trackable).toEqual([]);
      }
      // The refusal must still reach the operator, not be swallowed.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanTrackable"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("scanAircraft rejects, scanTrackable resolves -> ok, mirrored", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => [AIRCRAFT_ROW],
        scanAircraft: async () => { throw new Error("boom"); },
      });

      const result = await getAdsb(client, CFG);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.trackable).toEqual([AIRCRAFT_ROW]);
        expect(result.value.aircraft).toEqual([]);
      }
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanAircraft"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("both legs reject -> error Result, as today", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => { throw new Error("trackable-down"); },
        scanAircraft: async () => { throw new Error("aircraft-down"); },
      });

      const result = await getAdsb(client, CFG);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("trackable-down");
        expect(result.error).toContain("aircraft-down");
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  // Pinned so a future change to this leg is provably a widening, not a
  // regression: both legs succeeding must stay unchanged from today.
  it("both legs resolve -> ok, unchanged from current behavior", async () => {
    const trackableRow = { ...AIRCRAFT_ROW, hex: "trackable1" };
    const aircraftRow = { ...AIRCRAFT_ROW, hex: "aircraft1" };
    const client = fakeClient({
      scanTrackable: async () => [trackableRow],
      scanAircraft: async () => [aircraftRow],
    });

    const result = await getAdsb(client, CFG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trackable).toEqual([trackableRow]);
      expect(result.value.aircraft).toEqual([aircraftRow]);
    }
  });

  it("a hanging leg still hits its per-call timeout and doesn't stall the other", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hanging = new Promise<AircraftRow[]>(() => { /* deliberately never settles */ });
      const client = fakeClient({
        scanTrackable: () => hanging,
        scanAircraft: async () => [AIRCRAFT_ROW],
      });

      const pending = getAdsb(client, CFG);
      await vi.advanceTimersByTimeAsync(4001); // > COLLECT_CALL_TIMEOUT_MS (4000ms in server.ts)
      const result = await pending;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aircraft).toEqual([AIRCRAFT_ROW]);
        expect(result.value.trackable).toEqual([]);
      }
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanTrackable"));
    } finally {
      errSpy.mockRestore();
    }
  });
});
