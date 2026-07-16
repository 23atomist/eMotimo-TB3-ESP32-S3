import { describe, it, expect } from "vitest";
import { geodeticToEcef, enuDirection, azElRange, Geodetic } from "../src/geo/wgs84.js";
import { norm } from "../src/geo/vec3.js";

describe("wgs84", () => {
  it("geodeticToEcef at the equator/prime meridian, sea level", () => {
    // lat=0, lon=0, h=0 → x=a, y=0, z=0
    const p = geodeticToEcef({ lat: 0, lon: 0, height: 0 });
    expect(p[0]).toBeCloseTo(6378137.0, 1);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });
  it("geodeticToEcef at the north pole", () => {
    // lat=90 → z = b = a(1-f)
    const p = geodeticToEcef({ lat: 90, lon: 0, height: 0 });
    const b = 6378137.0 * (1 - 1 / 298.257223563);
    expect(p[0]).toBeCloseTo(0, 3);
    expect(p[1]).toBeCloseTo(0, 3);
    expect(p[2]).toBeCloseTo(b, 1);
  });
  it("enuDirection: a point due north and level reads azimuth 0, elevation 0", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    // 1 km due north, same height → mostly North, ~0 elevation
    const target: Geodetic = { lat: 45 + 1000 / 111320, lon: 10, height: 100 };
    const { unit, range } = enuDirection(rig, target);
    expect(unit[0]).toBeCloseTo(0, 3);          // East ≈ 0
    expect(unit[1]).toBeGreaterThan(0.99);       // mostly North
    expect(Math.abs(unit[2])).toBeLessThan(0.02); // near level
    expect(range).toBeGreaterThan(950);
    expect(range).toBeLessThan(1050);
  });
  it("azElRange: due-east target reads azimuth ~90", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    const target: Geodetic = { lat: 45, lon: 10 + 0.01, height: 100 };
    const r = azElRange(rig, target);
    expect(r.azimuth).toBeGreaterThan(89);
    expect(r.azimuth).toBeLessThan(91);
    expect(Math.abs(r.elevation)).toBeLessThan(1);
  });
  it("azElRange: a target directly overhead reads elevation ~90", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 0 };
    const target: Geodetic = { lat: 45, lon: 10, height: 1000 };
    const r = azElRange(rig, target);
    expect(r.elevation).toBeGreaterThan(89);
    expect(r.range).toBeCloseTo(1000, 0);
  });
  it("azimuth is normalized to [0,360): due-west reads ~270", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    const target: Geodetic = { lat: 45, lon: 10 - 0.01, height: 100 };
    const r = azElRange(rig, target);
    expect(r.azimuth).toBeGreaterThan(269);
    expect(r.azimuth).toBeLessThan(271);
  });
  it("azElRange: a due-north target (same longitude) reads azimuth ~0, not ~360", () => {
    // Same longitude as the rig — the East component of the ENU direction is
    // pure floating-point noise (~1e-10 m), which used to push atan2 to
    // ~359.99999999999994° instead of snapping to the equivalent 0°.
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    const target: Geodetic = { lat: 46, lon: 10, height: 100 };
    const r = azElRange(rig, target);
    expect(r.azimuth).toBeGreaterThanOrEqual(0);
    expect(r.azimuth).toBeLessThan(0.001);
  });
});
