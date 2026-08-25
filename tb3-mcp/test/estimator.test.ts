import { describe, it, expect } from "vitest";
import {
  emptyEstimator, withFix, velocityOf, estimateAt, lastFixMs, velocityFromSpeedHeading,
} from "../src/track/estimator.js";
import { add, scale } from "../src/geo/vec3.js";

const RIG = { lat: 45, lon: 10, height: 0 };

describe("velocityFromSpeedHeading", () => {
  it("heading 0 is due North", () => {
    const v = velocityFromSpeedHeading(100, 0, 0);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[1]).toBeCloseTo(100, 9);
    expect(v[2]).toBeCloseTo(0, 9);
  });

  it("heading 90 is due East, and climb is Up", () => {
    const v = velocityFromSpeedHeading(100, 90, 5);
    expect(v[0]).toBeCloseTo(100, 9);
    expect(v[1]).toBeCloseTo(0, 9);
    expect(v[2]).toBeCloseTo(5, 9);
  });
});

describe("estimator", () => {
  it("returns null before any fix", () => {
    expect(estimateAt(emptyEstimator(), 1000)).toBeNull();
    expect(lastFixMs(emptyEstimator())).toBeNull();
  });

  it("a stated velocity extrapolates linearly in ENU", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [10, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p2 = estimateAt(s, 3000)!;   // +2s at 10 m/s East
    expect(p2[0] - p0[0]).toBeCloseTo(20, 6);
    expect(p2[1] - p0[1]).toBeCloseTo(0, 6);
    expect(p2[2] - p0[2]).toBeCloseTo(0, 6);
  });

  it("holds position when velocity is zero and none can be derived", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    expect(velocityOf(s)).toEqual([0, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p9 = estimateAt(s, 9999)!;
    expect(p9).toEqual(p0);
  });

  it("derives velocity from two successive fixes when none is stated", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    // Second fix 1000m up, 2 seconds later => +500 m/s Up.
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, null);
    const v = velocityOf(s);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(0, 6);
    expect(v[2]).toBeCloseTo(500, 6);
  });

  it("a stated velocity takes precedence over one derivable from fixes", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, [1, 2, 3]);
    expect(velocityOf(s)).toEqual([1, 2, 3]);
  });

  it("withFix does not mutate the state it is given", () => {
    const a = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [1, 0, 0]);
    const before = estimateAt(a, 5000)!;
    withFix(a, RIG, { lat: 46, lon: 11, height: 9000 }, 4000, [9, 9, 9]);
    expect(estimateAt(a, 5000)).toEqual(before);
    expect(lastFixMs(a)).toBe(1000);
  });
});

// The decoder keeps re-serving the LAST position (growing seen_pos) whenever
// position messages stop decoding -- routinely, not just on hard dropouts.
describe("estimator repeat and clock coherence", () => {
  // 50 m/s due East; one degree of longitude at lat 45 ~ 78.7km, so move lon
  // by meters/M_PER_DEG_LON like the other suites do. Small helper here to
  // keep the cases readable.
  const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);
  const at = (tMs: number, eastM: number, upM = 1000) =>
    withFix(emptyEstimator(), RIG, { lat: 45, lon: 10 + eastM / M_PER_DEG_LON, height: upM }, tMs, null);

  it("a repeated position is ignored entirely: the trajectory is not reset", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [50, 0, 0]);
    s = withFix(s, RIG, { lat: 45, lon: 10 + 50 / M_PER_DEG_LON, height: 1000 }, 2000, [50, 0, 0]);
    const snap = s;
    // Same spot re-served a second later (the dropout signature): must be a
    // strict no-op, or it would flatten velocity and refresh staleness.
    expect(withFix(s, RIG, { lat: 45, lon: 10 + 50 / M_PER_DEG_LON, height: 1000 }, 3000, null)).toBe(snap);
  });

  it("a repeat carrying a fresh stated velocity still updates velocity", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [50, 0, 0]);
    s = withFix(s, RIG, { lat: 45, lon: 10 + 50 / M_PER_DEG_LON, height: 1000 }, 2000, [50, 0, 0]);
    s = withFix(s, RIG, { lat: 45, lon: 10 + 50 / M_PER_DEG_LON, height: 1000 }, 3000, [40, 30, 0]);
    expect(velocityOf(s)).toEqual([40, 30, 0]);
    expect(lastFixMs(s)).toBe(2000);   // position information did NOT advance
  });

  it("rejects a fix stamped before the one it holds (seen_pos jitter)", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 5000, [50, 0, 0]);
    const snap = s;
    s = withFix(s, RIG, { lat: 45, lon: 10 + 500 / M_PER_DEG_LON, height: 1000 }, 4900, null);
    expect(s).toBe(snap);
  });

  it("accepts a fix stamped within the monotonic tolerance", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 5000, [50, 0, 0]);
    s = withFix(s, RIG, { lat: 45, lon: 10 + 20 / M_PER_DEG_LON, height: 1000 }, 4970, null);
    expect(lastFixMs(s)).toBe(4970);
  });
});

describe("estimator smoothing and rejection", () => {
  const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);
  const fixAt = (s: ReturnType<typeof emptyEstimator>, tMs: number, eastM: number, northM = 0) =>
    withFix(s, RIG, { lat: 45 + northM / 111_320, lon: 10 + eastM / M_PER_DEG_LON, height: 1000 }, tMs, null);

  it("regression averages a noisy newest fix instead of snapping onto it", () => {
    // Four fixes flying East at 50 m/s; the NEWEST carries 40m of North
    // noise. The old two-point difference would read that as +40 m/s of
    // drift; a fit over the window dilutes it across all four samples.
    let s = emptyEstimator();
    s = fixAt(s, 1000, 0);
    s = fixAt(s, 2000, 50);
    s = fixAt(s, 3000, 100);
    s = fixAt(s, 4000, 150, 40);
    const v = velocityOf(s);
    // The fixture converts meters to degrees with a spherical cos(lat)
    // approximation, so even the exact axis reads ~0.2% off; the point here
    // is the NOISE axis, not millimeter fidelity on East.
    expect(v[0]).toBeCloseTo(50, 0);
    expect(Math.abs(v[1])).toBeLessThan(20);   // damped, not amplified
    expect(v[1]).toBeGreaterThan(0);           // ...but not ignored either
  });

  it("the anchor absorbs only a fraction of a measurement jump", () => {
    // Established straight-line flight, then a fix 400m off track -- inside
    // the outlier gate, as real GPS/CPR noise occasionally is. The aim point
    // must NUDGE toward it (alpha), not jump onto it (the old behavior).
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [50, 0, 0]);
    s = fixAt(s, 2000, 50);
    s = fixAt(s, 3000, 400, 0);   // prediction said E=100; measurement says 400
    const p = estimateAt(s, 3000)!;
    // The anchor's East lands mid-way (predicted 100, measured 400 -> moved
    // 35% of the gap), and North stays put: alpha applies to the full
    // innovation vector, so a purely-Eastward jump must not invent drift.
    expect(p[0]).toBeGreaterThan(150);
    expect(p[0]).toBeLessThan(250);
    expect(Math.abs(p[1])).toBeLessThan(0.01);
  });

  it("rejects an outlier far outside what the model allows", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [50, 0, 0]);
    s = fixAt(s, 2000, 50);
    const snap = s;
    // 5km sideways in one second: no aircraft maneuver does that; a bad CPR
    // decode does. Reject outright rather than yank the aim.
    s = fixAt(s, 3000, 100, 5000);
    expect(s).toBe(snap);
  });

  it("does not gate the first velocity-establishing fixes", () => {
    // No stated velocity: the second fix is what CREATES the model. A 1km
    // move in 2s must be admitted even though "sit still" predicted nothing --
    // this is exactly how derived velocity comes into existence.
    let s = fixAt(emptyEstimator(), 1000, 0);
    s = fixAt(s, 3000, 500);
    expect(velocityOf(s)[0]).toBeCloseTo(250, 0);
    expect(Math.abs(velocityOf(s)[1])).toBeLessThan(1);
  });
});

describe("estimator turn-aware coasting", () => {
  const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);
  const M_PER_DEG_LAT = 111_320;

  it("bends the extrapolation along the turn instead of a straight line", () => {
    // Flying East at 50 m/s, then turning LEFT toward North (track 90 -> 0).
    // The stated velocities carry the heading change.
    const p = (eastM: number) => ({ lat: 45, lon: 10 + eastM / M_PER_DEG_LON, height: 1000 });
    let s = withFix(emptyEstimator(), RIG, p(0), 1000, [50, 0, 0]);
    s = withFix(s, RIG, p(350), 8000, [0, 50, 0]);   // now heading North

    // Coast 10s past the last fix. Straight-line dead reckoning runs due
    // North; the fitted left turn must curve the path West of that line,
    // while covering less North distance than the straight line claims.
    const curved = estimateAt(s, 18000)!;
    expect(curved[0]).toBeLessThan(340);      // West of the straight line's E=350...
    expect(curved[0]).toBeGreaterThan(-200);  // ...an arc, not a spiral
    expect(curved[1]).toBeGreaterThan(350);   // still moving substantially North
    expect(curved[1]).toBeLessThan(500);      // but less far than dead reckoning
  });

  it("propagates backward symmetrically (no forward-only asymmetry)", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [0, 50, 0]);
    s = withFix(
      s, RIG,
      { lat: 45 + 350 / M_PER_DEG_LAT, lon: 10, height: 1000 }, 8000, [-50, 0, 0],
    );
    const anchor = estimateAt(s, 8000)!;
    const fwd = estimateAt(s, 16000)!;
    const back = estimateAt(s, 0)!;
    // Whatever the arc, running the same turn rate forward and backward from
    // the same anchor must land equidistant from it.
    const df = Math.hypot(fwd[0] - anchor[0], fwd[1] - anchor[1]);
    const db = Math.hypot(back[0] - anchor[0], back[1] - anchor[1]);
    expect(df).toBeCloseTo(db, 3);
  });

  it("zeroes the turn rate when horizontal speed is negligible", () => {
    // A 90deg heading flip over 7s at sub-walking-pace speed is heading
    // noise, not coordinated flight: no arc may be fitted.
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [0.5, 0, 0]);
    s = withFix(
      s, RIG,
      { lat: 45 + 350 / M_PER_DEG_LAT, lon: 10, height: 1000 }, 8000, [0, 0.5, 0],
    );
    const linear = add(s.anchor!.enu, scale(s.vel, 10));
    const got = estimateAt(s, 18000)!;
    expect(got[0]).toBeCloseTo(linear[0], 6);
    expect(got[1]).toBeCloseTo(linear[1], 6);
  });
});
