import { describe, it, expect } from "vitest";
import { extrapolateSightingPosition } from "../src/adsb/extrapolate.js";
import { Aircraft } from "../src/adsb/types.js";

// Mirrors adsb-convert.test.ts's own `ac()` fixture builder.
function ac(p: Partial<Aircraft>): Aircraft {
  return {
    hex: "abc123", callsign: "TST123", lat: 37, lon: -122,
    altBaroFt: null, altGeomFt: 10000, gsKt: null, trackDeg: null,
    baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: 0, rssi: null, ...p,
  };
}

const MAX_AGE_SEC = 5;

describe("extrapolateSightingPosition", () => {
  it("zero age and zero video latency leaves the position unchanged", () => {
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: 0 });
    const r = extrapolateSightingPosition(a, "auto", 0, MAX_AGE_SEC);
    if ("error" in r) throw new Error(r.error);
    expect(r.geodetic.lat).toBe(37);
    expect(r.geodetic.lon).toBe(-122);
    expect(r.geodetic.height).toBeCloseTo(3048, 0);
    expect(r.movedM).toBe(0);
    expect(r.positionAgeSec).toBe(0);
  });

  it("moves the expected distance in the expected direction for a known velocity and age", () => {
    // Due east (track 90) at 100kt = 51.4444 m/s, report is 10s old, no video latency.
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: 10 });
    const r = extrapolateSightingPosition(a, "auto", 0, 20);
    if ("error" in r) throw new Error(r.error);
    expect(r.movedM).toBeCloseTo(514.444, 1);
    expect(r.geodetic.lat).toBeCloseTo(37, 3);       // pure-east motion: latitude ~unchanged
    expect(r.geodetic.lon).toBeGreaterThan(-122);    // moved east = increasing longitude
    // ~514m east at 37N is ~0.0058 deg of longitude.
    expect(r.geodetic.lon - -122).toBeCloseTo(0.0058, 3);
  });

  it("moves north for due-north travel and up for a climb", () => {
    const a = ac({ gsKt: 100, trackDeg: 0, geomRateFpm: 600, seenPosSec: 5 });
    const r = extrapolateSightingPosition(a, "auto", 0, MAX_AGE_SEC);
    if ("error" in r) throw new Error(r.error);
    expect(r.geodetic.lat).toBeGreaterThan(37);
    expect(r.geodetic.lon).toBeCloseTo(-122, 3);
    // climb 600 fpm = 3.048 m/s, 5s => +15.24m
    expect(r.geodetic.height).toBeCloseTo(3048 + 15.24, 0);
  });

  it("applies the video-latency offset with the correct sign: less far than extrapolating to `now`", () => {
    const withoutLatency = extrapolateSightingPosition(
      ac({ gsKt: 100, trackDeg: 90, seenPosSec: 10 }), "auto", 0, 20,
    );
    const withLatency = extrapolateSightingPosition(
      ac({ gsKt: 100, trackDeg: 90, seenPosSec: 10 }), "auto", 300, 20,
    );
    if ("error" in withoutLatency) throw new Error(withoutLatency.error);
    if ("error" in withLatency) throw new Error(withLatency.error);
    // dtSec = 10 - 0.3 = 9.7s instead of 10s -- a smaller forward displacement,
    // still in the same (eastward) direction.
    expect(withLatency.movedM).toBeLessThan(withoutLatency.movedM);
    expect(withLatency.movedM).toBeCloseTo(51.4444 * 9.7, 1);
    expect(withLatency.geodetic.lon).toBeGreaterThan(-122);
    expect(withLatency.geodetic.lon).toBeLessThan(withoutLatency.geodetic.lon);
  });

  it("a video latency longer than the report age extrapolates slightly backward, not forward", () => {
    // seenPosSec=0 (fresh report) but a 300ms video latency: the operator's
    // frame is older than the report itself, so the correct position is
    // BEHIND (west of) the raw report, not ahead of it.
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: 0 });
    const r = extrapolateSightingPosition(a, "auto", 300, MAX_AGE_SEC);
    if ("error" in r) throw new Error(r.error);
    expect(r.geodetic.lon).toBeLessThan(-122);
    expect(r.movedM).toBeCloseTo(51.4444 * 0.3, 2);
  });

  it("rejects when ground speed/track (velocity) is unavailable, rather than treating it as zero", () => {
    const noSpeed = extrapolateSightingPosition(ac({ gsKt: null, trackDeg: 90, seenPosSec: 1 }), "auto", 0, MAX_AGE_SEC);
    expect("error" in noSpeed).toBe(true);
    const noTrack = extrapolateSightingPosition(ac({ gsKt: 100, trackDeg: null, seenPosSec: 1 }), "auto", 0, MAX_AGE_SEC);
    expect("error" in noTrack).toBe(true);
  });

  it("rejects a position report older than calibMaxPosAgeSec", () => {
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: 6 });
    const r = extrapolateSightingPosition(a, "auto", 0, 5);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toMatch(/stale|old/i);
  });

  it("accepts a position report exactly at the max age threshold", () => {
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: 5 });
    const r = extrapolateSightingPosition(a, "auto", 0, 5);
    expect("error" in r).toBe(false);
  });

  it("rejects when the position age itself is unknown (seen_pos missing)", () => {
    const a = ac({ gsKt: 100, trackDeg: 90, seenPosSec: null });
    const r = extrapolateSightingPosition(a, "auto", 0, MAX_AGE_SEC);
    expect("error" in r).toBe(true);
  });

  it("rejects when there is no usable altitude for the configured source", () => {
    const a = ac({ gsKt: 100, trackDeg: 90, altGeomFt: null, altBaroFt: null, seenPosSec: 0 });
    const r = extrapolateSightingPosition(a, "auto", 0, MAX_AGE_SEC);
    expect("error" in r).toBe(true);
  });
});
