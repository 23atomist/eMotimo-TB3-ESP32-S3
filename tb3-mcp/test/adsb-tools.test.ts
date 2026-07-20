import { describe, it, expect } from "vitest";
import { scanAircraft, isTrackable, type ScanParams } from "../src/adsb-tools.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot, EnrichedAircraft } from "../src/adsb/types.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Mat3 } from "../src/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG: Geodetic = { lat: 0, lon: 0, height: 0 };
const NIGHT = Date.UTC(2026, 0, 1, 0, 0, 0);
const cfg = loadConfig(undefined, {});
const P: ScanParams = { maxRangeKm: 100, onlyTrackable: true, limit: 20 };

function snap(aircraft: AdsbSnapshot["aircraft"]): AdsbSnapshot {
  return { aircraft, fetchedAtMs: 1000, ok: true };
}
function raw(hex: string, lat: number, altFt = 10000): AdsbSnapshot["aircraft"][number] {
  return {
    hex, callsign: null, lat, lon: 0, altBaroFt: null, altGeomFt: altFt,
    gsKt: 100, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null,
    squawk: null, seenPosSec: 0, rssi: null,
  };
}

describe("scanAircraft", () => {
  it("errors when not calibrated", () => {
    const r = scanAircraft(snap([]), null, null, cfg, NIGHT, P);
    expect("error" in r).toBe(true);
  });

  it("sorts by proximity and caps to the limit", () => {
    const r = scanAircraft(snap([raw("far", 0.5), raw("near", 0.05)]), RIG, I, cfg, NIGHT,
      { ...P, limit: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);
    expect(r.aircraft[0].hex).toBe("near");
  });

  it("filters out unreachable aircraft when only_trackable", () => {
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "80" });   // only near-zenith reachable
    // lat 0.5 => ~55km slant range (elevation ~0.7°, well below the 80° tilt
    // floor, so unreachable) -- must stay inside the default 100km maxRangeKm
    // so this exercises the trackable filter alone, not the range filter too.
    const r = scanAircraft(snap([raw("low", 0.5, 3000)]), RIG, I, c2, NIGHT, P);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
    const r2 = scanAircraft(snap([raw("low", 0.5, 3000)]), RIG, I, c2, NIGHT, { ...P, onlyTrackable: false });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.aircraft).toHaveLength(1);        // still returned when the filter is off
  });

  it("drops aircraft beyond max range", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, I, cfg, NIGHT, { ...P, maxRangeKm: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
  });
});

describe("isTrackable", () => {
  it("requires all three hard flags", () => {
    // Cast to EnrichedAircraft (not `never`): isTrackable only reads these three
    // flags, but `never` can't be spread (`{ ...base, ... }` below), while a
    // cast object type can.
    const base = { reachable: true, sunSafe: true, slewOk: true } as unknown as EnrichedAircraft;
    expect(isTrackable(base)).toBe(true);
    expect(isTrackable({ ...base, sunSafe: false })).toBe(false);
  });
});
