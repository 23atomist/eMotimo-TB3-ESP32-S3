import { describe, it, expect } from "vitest";
import { aircraftAltitudeM, aircraftGeodetic, aircraftVelocity } from "../src/adsb/convert.js";
import { Aircraft } from "../src/adsb/types.js";

function ac(p: Partial<Aircraft>): Aircraft {
  return {
    hex: "abc123", callsign: null, lat: 37, lon: -122,
    altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
    baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: null, rssi: null, ...p,
  };
}

describe("aircraftAltitudeM", () => {
  it("auto prefers geom over baro, feet→meters", () => {
    expect(aircraftAltitudeM(ac({ altGeomFt: 10000, altBaroFt: 9800 }), "auto")).toBeCloseTo(3048, 0);
    expect(aircraftAltitudeM(ac({ altGeomFt: null, altBaroFt: 9800 }), "auto")).toBeCloseTo(2987.04, 1);
  });
  it("respects explicit source and returns null when absent", () => {
    expect(aircraftAltitudeM(ac({ altGeomFt: 10000, altBaroFt: 9800 }), "baro")).toBeCloseTo(2987.04, 1);
    expect(aircraftAltitudeM(ac({ altGeomFt: null }), "geom")).toBeNull();
  });
});

describe("aircraftGeodetic", () => {
  it("builds a Geodetic in meters", () => {
    const g = aircraftGeodetic(ac({ lat: 37.5, lon: -122.1, altGeomFt: 10000 }), "auto");
    expect(g).not.toBeNull();
    expect(g!.lat).toBe(37.5);
    expect(g!.height).toBeCloseTo(3048, 0);
  });
  it("is null with no usable altitude", () => {
    expect(aircraftGeodetic(ac({ altBaroFt: null, altGeomFt: null }), "auto")).toBeNull();
  });
});

describe("aircraftVelocity", () => {
  it("converts kt+track+fpm into an ENU velocity (m/s)", () => {
    // Due east (track 90), 100 kt = 51.4444 m/s, climbing 600 fpm = 3.048 m/s.
    const v = aircraftVelocity(ac({ gsKt: 100, trackDeg: 90, geomRateFpm: 600 }))!;
    expect(v[0]).toBeCloseTo(51.4444, 3);  // east
    expect(v[1]).toBeCloseTo(0, 6);        // north
    expect(v[2]).toBeCloseTo(3.048, 3);    // up
  });
  it("falls back baro_rate→geom_rate and defaults climb to 0", () => {
    const v = aircraftVelocity(ac({ gsKt: 100, trackDeg: 0, baroRateFpm: -600, geomRateFpm: null }))!;
    expect(v[1]).toBeCloseTo(51.4444, 3);  // north
    expect(v[2]).toBeCloseTo(-3.048, 3);
    const v2 = aircraftVelocity(ac({ gsKt: 100, trackDeg: 0 }))!;
    expect(v2[2]).toBe(0);
  });
  it("is null without ground speed or track", () => {
    expect(aircraftVelocity(ac({ gsKt: null, trackDeg: 90 }))).toBeNull();
    expect(aircraftVelocity(ac({ gsKt: 100, trackDeg: null }))).toBeNull();
  });
});
