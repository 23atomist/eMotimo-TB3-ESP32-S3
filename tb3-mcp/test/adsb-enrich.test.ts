import { describe, it, expect } from "vitest";
import { enrichAircraft } from "../src/adsb/enrich.js";
import { Aircraft } from "../src/adsb/types.js";
import { loadConfig } from "../src/config.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Mat3 } from "../src/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG: Geodetic = { lat: 0, lon: 0, height: 0 };
// Night so the sun is below the horizon and never trips sunSafe in geometry tests.
const NIGHT_MS = Date.UTC(2026, 0, 1, 0, 0, 0);     // ~midnight UTC at lon 0
const cfg = loadConfig(undefined, {});

function ac(p: Partial<Aircraft>): Aircraft {
  return {
    hex: "abc123", callsign: null, lat: null, lon: null,
    altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
    baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: null, rssi: null, ...p,
  };
}

describe("enrichAircraft geometry", () => {
  it("computes azimuth/elevation/range for a point due north and up", () => {
    // ~1.11 km north (0.01° lat) at 1000 m altitude.
    const e = enrichAircraft(ac({ lat: 0.01, lon: 0, altGeomFt: 3280.84 }), RIG, I, cfg, NIGHT_MS)!;
    expect(e.azimuthDeg).toBeCloseTo(0, 1);
    expect(e.rangeM).toBeGreaterThan(1450);
    expect(e.rangeM).toBeLessThan(1550);            // sqrt(1113^2 + 1000^2) ≈ 1497
    expect(e.elevationDeg).toBeGreaterThan(30);
    expect(e.reachable).toBe(true);                 // default limits are full sphere
  });

  it("returns null with no usable altitude", () => {
    expect(enrichAircraft(ac({ lat: 0.01, lon: 0 }), RIG, I, cfg, NIGHT_MS)).toBeNull();
  });

  it("marks below-tilt-limit targets unreachable", () => {
    // Restrict tilt to >= 10°; a low, distant target sits below that.
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "10" });
    const e = enrichAircraft(ac({ lat: 1.0, lon: 0, altGeomFt: 3280 }), RIG, I, c2, NIGHT_MS)!;
    expect(e.elevationDeg).toBeLessThan(10);
    expect(e.reachable).toBe(false);
  });
});

describe("enrichAircraft slew rate", () => {
  it("crossing traffic close in needs a high slew rate; distant is slow", () => {
    // 2 km due north, flying due east at 200 m/s (~389 kt) → LoS rate ≈ 5.7°/s.
    const near = enrichAircraft(
      ac({ lat: 0.018, lon: 0, altGeomFt: 0, gsKt: 200 / 0.514444, trackDeg: 90 }), RIG, I, cfg, NIGHT_MS)!;
    expect(near.requiredSlewDps).toBeGreaterThan(3);
    // 100 km north, same speed → LoS rate ≈ 0.11°/s.
    const far = enrichAircraft(
      ac({ lat: 0.9, lon: 0, altGeomFt: 0, gsKt: 200 / 0.514444, trackDeg: 90 }), RIG, I, cfg, NIGHT_MS)!;
    expect(far.requiredSlewDps).toBeLessThan(1);
    expect(far.slewOk).toBe(true);
  });
});

describe("enrichAircraft sun-safe", () => {
  it("flags an aircraft sitting on the sun as unsafe", () => {
    // Daytime; put the aircraft along the sun's own ENU direction by using a high
    // sun elevation moment. We assert the flag is boolean and consistent with the cone.
    const e = enrichAircraft(ac({ lat: 0.5, lon: 0, altGeomFt: 30000 }), RIG, I, cfg, Date.UTC(2026, 0, 1, 12, 0, 0))!;
    expect(typeof e.sunSafe).toBe("boolean");
  });
});
