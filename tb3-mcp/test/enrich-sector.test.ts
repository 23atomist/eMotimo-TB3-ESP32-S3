import { describe, it, expect } from "vitest";
import { enrichAircraft } from "../src/adsb/enrich.js";
import { isTrackable } from "../src/adsb-tools.js";
import { DISABLED_SECTOR } from "../src/track/sector.js";
import type { Aircraft } from "../src/adsb/types.js";
import type { Config } from "../src/config.js";
import type { Mat3 } from "../src/geo/vec3.js";

// A rig at the equator/prime-meridian with identity orientation: ENU azimuth of
// a target is a plain compass bearing, so we can place a plane at a known az.
const rig = { lat: 0, lon: 0, height: 0 };
const R: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const cfg = { adsbAltSource: "geom", panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90, sunConeDeg: 25, maxJogDps: 19 } as unknown as Config;

// A slow plane due EAST (bearing ~90°), a few km out, well above the horizon.
function planeEast(): Aircraft {
  return {
    hex: "abc123", callsign: "TEST", lat: 0.0, lon: 0.05, altBaroFt: null, altGeomFt: 20000,
    gsKt: 5, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null, squawk: null,
    seenPosSec: 0, rssi: null,
  };
}

describe("enrichAircraft inSector + isTrackable", () => {
  it("disabled sector default leaves inSector true (backward compatible)", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0)!;   // no sector arg
    expect(e.inSector).toBe(true);
    expect(e.azimuthDeg).toBeGreaterThan(80);
    expect(e.azimuthDeg).toBeLessThan(100);
  });

  it("an arc excluding the plane's bearing sets inSector false and makes it not trackable", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0, { enabled: true, startDeg: 180, endDeg: 350 })!;
    expect(e.inSector).toBe(false);
    // reachable+sunSafe+slewOk may be true, but the sector gate must drop it:
    expect(isTrackable(e)).toBe(false);
  });

  it("an arc including the plane's bearing keeps it trackable", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0, { enabled: true, startDeg: 45, endDeg: 135 })!;
    expect(e.inSector).toBe(true);
    expect(isTrackable(e)).toBe(e.reachable && e.sunSafe && e.slewOk);
  });
});
