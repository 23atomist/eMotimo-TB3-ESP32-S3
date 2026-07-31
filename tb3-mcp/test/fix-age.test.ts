import { describe, it, expect } from "vitest";
import { emptyEstimator, withFix, estimateAt, velocityFromSpeedHeading } from "../src/track/estimator.js";

// FIELD 2026-07-30. The operator: planes are "always a bit too far right...
// i can't catch up to them", and one plane sat almost centred for ~10s and
// then "the location just was complete off again" the moment it turned.
//
// That is not an orientation error -- a bad calibration does not care whether
// the target manoeuvres. It is the tracker pointing where the aircraft WAS.
//
// ADS-B positions arrive already stale. Measured on this rig's own feed the
// same day: median seen_pos 2.8s, p90 37.8s, max 56.7s. The follower passed
// each fix to the session with no timestamp, so the session stamped it now()
// -- treating a 2.8s-old position as current. At 255kt that is 7.4km of lag
// on the worst offender, ~37 deg of bearing error at 10km.
//
// The estimator itself was always capable of this: withFix() takes the fix's
// OWN time and estimateAt() extrapolates to any instant. Nothing told it the
// truth.
const RIG = { lat: 33.3832, lon: -112.1413, height: 341 };
const T0 = 1_700_000_000_000;
const EAST_250 = velocityFromSpeedHeading(250, 90, 0); // 250 m/s due east

describe("ADS-B fix age (field bug 2026-07-30)", () => {
  it("a fix stamped at its TRUE time extrapolates further than one stamped 'now'", () => {
    const target = { lat: 33.3832, lon: -112.0, height: 3000 };
    const ageSec = 2.8;

    // Wrong (what shipped): pretend the report is current.
    const asNow = estimateAt(withFix(emptyEstimator(), RIG, target, T0, EAST_250), T0)!;
    // Right: the report describes where it was ageSec ago.
    const trueTime = estimateAt(withFix(emptyEstimator(), RIG, target, T0 - ageSec * 1000, EAST_250), T0)!;

    const lagM = trueTime[0] - asNow[0]; // east component
    expect(lagM).toBeCloseTo(250 * ageSec, 0); // 700 m
    expect(lagM).toBeGreaterThan(600);
  });

  it("the lag is ALONG TRACK -- which is why it reads as a constant sideways miss", () => {
    const target = { lat: 33.3832, lon: -112.0, height: 3000 };
    const st = withFix(emptyEstimator(), RIG, target, T0 - 2800, EAST_250);
    const p = estimateAt(st, T0)!;
    const q = estimateAt(withFix(emptyEstimator(), RIG, target, T0, EAST_250), T0)!;
    expect(Math.abs(p[1] - q[1])).toBeLessThan(1); // no north/south difference
    expect(Math.abs(p[2] - q[2])).toBeLessThan(1); // none vertical
    expect(p[0] - q[0]).toBeGreaterThan(600);      // all of it downrange
  });

  it("a very old fix extrapolates a distance that is pure fiction once the plane turns", () => {
    // 56.7s at 255kt was really on the feed. Extrapolating that far assumes
    // the aircraft held heading the whole time -- exactly the assumption the
    // operator watched break.
    const target = { lat: 33.3832, lon: -112.0, height: 3000 };
    const st = withFix(emptyEstimator(), RIG, target, T0 - 56_700, EAST_250);
    const p = estimateAt(st, T0)!;
    expect(p[0]).toBeGreaterThan(14_000); // >14 km of pure guesswork
  });
});

// End-to-end through the follower: the age must actually reach the session,
// not just be representable.
import { AdsbFollower } from "../src/adsb/follower.js";

describe("the follower carries seen_pos into the session", () => {
  function sinkSpy() {
    const seen: Array<{ call: string; ageSec: number | undefined }> = [];
    return {
      seen,
      sink: {
        isActive: () => true,
        start: (_g: unknown, _v: unknown, _l: unknown, _h: unknown, ageSec?: number) => {
          seen.push({ call: "start", ageSec }); return null;
        },
        updateTarget: (_g: unknown, _v: unknown, ageSec?: number) => {
          seen.push({ call: "updateTarget", ageSec }); return null;
        },
      },
    };
  }
  const plane = (seenPos: number) => ({
    hex: "a1b2c3", callsign: "TST1", lat: 33.4, lon: -112.0,
    altBaroFt: 10000, altGeomFt: 10000, gsKt: 400, trackDeg: 90,
    baroRateFpm: 0, seenPosSec: seenPos, seenSec: seenPos, squawk: null, category: null,
  });

  it("passes the report's own age on the first fix and on updates", () => {
    const { seen, sink } = sinkSpy();
    const f = new AdsbFollower(sink as never, "auto", 15000, () => 1000);
    f.bind("a1b2c3");
    f.onSnapshot({ aircraft: [plane(2.8)] as never });
    f.onSnapshot({ aircraft: [plane(4.1)] as never });
    expect(seen.map((s) => s.call)).toEqual(["start", "updateTarget"]);
    expect(seen[0].ageSec).toBeCloseTo(2.8, 6);
    expect(seen[1].ageSec).toBeCloseTo(4.1, 6);
  });

  it("treats a missing seen_pos as 0 rather than NaN", () => {
    const { seen, sink } = sinkSpy();
    const f = new AdsbFollower(sink as never, "auto", 15000, () => 1000);
    f.bind("a1b2c3");
    f.onSnapshot({ aircraft: [{ ...plane(0), seenPosSec: null }] as never });
    expect(seen[0].ageSec).toBe(0);
  });
});
