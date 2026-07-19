import { describe, it, expect } from "vitest";
import { parseAircraftJson } from "../src/adsb/parse.js";

// A dump1090-fa / readsb aircraft.json shape (trimmed to fields we use).
const SAMPLE = {
  now: 1_700_000_000,
  aircraft: [
    { hex: "A1B2C3", flight: "UAL123  ", lat: 37.62, lon: -122.38, alt_baro: 30000,
      alt_geom: 30500, gs: 420, track: 95, baro_rate: -64, category: "A3",
      squawk: "1200", seen_pos: 0.3, rssi: -12.1 },
    { hex: "DEAD01", flight: "", alt_baro: "ground", gs: 0 },          // no lat/lon -> dropped
    { flight: "NOHEX", lat: 1, lon: 2 },                                // no hex -> dropped
    { hex: "BEEF99", lat: 51.0, lon: -0.1, alt_baro: "ground" },        // altBaroFt -> null, kept
  ],
};

describe("parseAircraftJson", () => {
  it("normalizes fields and lowercases hex", () => {
    const out = parseAircraftJson(SAMPLE);
    const a = out.find((x) => x.hex === "a1b2c3");
    expect(a).toBeDefined();
    expect(a!.callsign).toBe("UAL123");           // trimmed
    expect(a!.altBaroFt).toBe(30000);
    expect(a!.altGeomFt).toBe(30500);
    expect(a!.gsKt).toBe(420);
    expect(a!.trackDeg).toBe(95);
    expect(a!.baroRateFpm).toBe(-64);
    expect(a!.category).toBe("A3");
    expect(a!.squawk).toBe("1200");
  });

  it("drops aircraft with no hex or no position", () => {
    const out = parseAircraftJson(SAMPLE);
    expect(out.map((x) => x.hex).sort()).toEqual(["a1b2c3", "beef99"]);
  });

  it("maps non-numeric altitude to null but keeps the aircraft", () => {
    const beef = parseAircraftJson(SAMPLE).find((x) => x.hex === "beef99")!;
    expect(beef.altBaroFt).toBeNull();
    expect(beef.altGeomFt).toBeNull();
  });

  it("is defensive against garbage input", () => {
    expect(parseAircraftJson(null)).toEqual([]);
    expect(parseAircraftJson({})).toEqual([]);
    expect(parseAircraftJson({ aircraft: "nope" })).toEqual([]);
    expect(parseAircraftJson({ aircraft: [null, 42, "x"] })).toEqual([]);
  });
});
