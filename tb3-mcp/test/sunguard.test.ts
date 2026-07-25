import { describe, it, expect } from "vitest";
import { checkSun, planPark } from "../src/track/sunguard.js";
import { Mat3, Vec3, angleBetweenDeg } from "../src/geo/vec3.js";
import { boresightEnu } from "../src/track/control.js";

// Identity R: mount frame == ENU. Then boresight(pan,tilt) == the ENU direction
// with azimuth=pan, elevation=tilt, so cases are hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// A sun ENU unit vector at (az, el).
const sun = (azDeg: number, elDeg: number): Vec3 => {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
};
const LIM = { panMin: -180, panMax: 180, tiltMin: -30, tiltMax: 90 };

describe("checkSun", () => {
  it("does not trip when the boresight is far from the sun", () => {
    const r = checkSun(I, 0, 10, 0, 0, 0, sun(180, 60), 25);
    expect(r.separationDeg).toBeGreaterThan(25);
    expect(r.tripped).toBe(false);
  });

  it("trips when the current boresight is inside the cone", () => {
    const r = checkSun(I, 175, 60, 0, 0, 0, sun(180, 60), 25);
    expect(r.separationDeg).toBeLessThan(25);
    expect(r.tripped).toBe(true);
  });

  it("trips PREDICTIVELY: current boresight clear, but a slew carries it in", () => {
    // At (150°,60°) the sun (180°,60°) is ~15° away in azimuth → outside a 10° cone.
    // Slewing +pan at 30°/s for a 1s horizon predicts (180°,60°) → inside.
    const clear = checkSun(I, 150, 60, 0, 0, 0, sun(180, 60), 10);
    expect(clear.tripped).toBe(false);
    const pred = checkSun(I, 150, 60, 30, 0, 1000, sun(180, 60), 10);
    expect(pred.predictedSeparationDeg).toBeLessThan(clear.separationDeg);
    expect(pred.tripped).toBe(true);
  });
});

describe("checkSun under a real camera offset (non-default cHead/geoPanSign)", () => {
  // The field-calibrated cHead/geoPanSign from imu-calib-field.json (see
  // imu-calibration-solve.test.ts / enu-to-pantilt-offset.test.ts) -- a real,
  // non-trivial camera offset, not the identity default every other case in
  // this file uses. Locks that checkSun actually threads cHead/geoPanSign
  // into its boresight -- the guard must agree with the aim model about
  // where the camera is REALLY pointing, or the rig could be pointed at the
  // sun while the guard (using the legacy identity model) thinks it's safe.
  const FIELD_CHEAD: Vec3 = [-0.520849, 0.735122, 0.433949];
  const FIELD_GEO_PAN_SIGN = -1;

  it("separation and trip decision reflect the OFFSET boresight, not the legacy [0,1,0]/+1 model", () => {
    const pan = 175, tiltDeg = 60;
    const s = sun(180, 60);

    const legacy = checkSun(I, pan, tiltDeg, 0, 0, 0, s, 25);
    const offset = checkSun(I, pan, tiltDeg, 0, 0, 0, s, 25, FIELD_CHEAD, FIELD_GEO_PAN_SIGN);

    // The offset separation must equal angleBetweenDeg of the OFFSET
    // boresight (not the legacy one) to the sun -- the exact formula
    // checkSun uses internally, recomputed independently here.
    const expectedOffsetSep = angleBetweenDeg(
      boresightEnu(I, pan, tiltDeg, FIELD_CHEAD, FIELD_GEO_PAN_SIGN), s,
    );
    expect(offset.separationDeg).toBeCloseTo(expectedOffsetSep, 9);

    // And it must genuinely differ from the legacy identity-cHead answer for
    // the SAME pan/tilt/sun -- proving the offset is actually threaded
    // through, not silently defaulted. At this posture the legacy model
    // reads the boresight as ~2.5° from the sun (tripped, inside a 25° cone)
    // while the real, offset boresight is ~40.7° away (NOT tripped) -- the
    // exact scenario the guard exists to get right: a legacy-only check
    // would report "safe" (or "unsafe") based on where the mount points, not
    // where the camera actually looks.
    expect(Math.abs(offset.separationDeg - legacy.separationDeg)).toBeGreaterThan(10);
    expect(legacy.tripped).toBe(true);
    expect(offset.tripped).toBe(false);
  });
});

describe("planPark", () => {
  it("goes direct-down when the tilt sweep stays clear of a high sun", () => {
    // Sun overhead-ish (el 70°), boresight at tilt 20° → tilting DOWN to -20°
    // only increases separation. Direct: one waypoint, tilt-down at current pan.
    const plan = planPark(I, 0, 20, sun(180, 70), 25, -20, LIM);
    expect(plan.kind).toBe("direct");
    expect(plan.waypoints).toEqual([{ panDeg: 0, tiltDeg: -20 }]);
  });

  it("takes a pan detour when tilting down would sweep through a LOW sun", () => {
    // Low sun (el 10°) dead ahead (az 0°). Boresight above it at tilt 40°, same
    // azimuth. Tilting straight down crosses the sun's elevation at az 0 → unsafe.
    const plan = planPark(I, 0, 40, sun(0, 10), 15, -20, LIM);
    expect(plan.kind).toBe("pan-detour");
    // Two waypoints flown in order: pan sweep at the CURRENT tilt (40°), THEN
    // tilt down at the detour pan. Both share the detour pan; that is the L-path
    // the planner actually verified, so the rig must fly it, not a diagonal.
    expect(plan.waypoints.length).toBe(2);
    expect(plan.waypoints[0].tiltDeg).toBe(40);
    expect(plan.waypoints[1].tiltDeg).toBe(-20);
    expect(plan.waypoints[0].panDeg).toBe(plan.waypoints[1].panDeg);
    expect(Math.abs(plan.waypoints[1].panDeg)).toBeGreaterThanOrEqual(15);
  });

  it("the pan-detour L-path it returns is actually clear of the sun end to end", () => {
    // Fly the returned waypoints and confirm the minimum separation never enters
    // the cone. Interpolate BOTH axes between consecutive waypoints (not just the
    // one that changed) — for a correct single-axis leg the unchanged axis is a
    // no-op, but this way the test would ALSO catch a regression that collapsed
    // the detour back to a single diagonal-endpoint waypoint (the original bug).
    const cone = 15;
    const s = sun(0, 10);
    const plan = planPark(I, 0, 40, s, cone, -20, LIM);
    expect(plan.kind).toBe("pan-detour");
    let prev = { panDeg: 0, tiltDeg: 40 };
    let worst = Infinity;
    for (const wp of plan.waypoints) {
      const span = Math.max(Math.abs(wp.panDeg - prev.panDeg), Math.abs(wp.tiltDeg - prev.tiltDeg));
      const steps = Math.max(1, Math.ceil(span / 0.25));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const pan = prev.panDeg + (wp.panDeg - prev.panDeg) * f;
        const tilt = prev.tiltDeg + (wp.tiltDeg - prev.tiltDeg) * f;
        worst = Math.min(worst, angleBetweenDeg(boresightEnu(I, pan, tilt), s));
      }
      prev = wp;
    }
    expect(worst).toBeGreaterThanOrEqual(cone);
  });

  it("scales sampling to the cone: a sub-degree cone hidden between 1° samples is still caught", () => {
    // Sun at tilt 10.5° — exactly between the integer tilt samples a fixed 1°
    // sampler would take on a 40°→-20° sweep at pan 0. With a 0.3° cone, plain 1°
    // sampling (nearest sample 0.5° away, outside the cone) would MISS the transit
    // and call it a safe direct tilt-down. The cone-scaled sampler must not.
    const s = sun(0, 10.5);
    const plan = planPark(I, 0, 40, s, 0.3, -20, LIM);
    expect(plan.kind).not.toBe("direct");
  });

  it("escapes an already-in-cone start instead of reporting no-safe-path", () => {
    // Boresight aimed nearly AT a high sun (sep ~0.6°, deep inside a 25° cone) —
    // the situation the park most exists for. It must NOT fault as no-safe-path;
    // it must tilt down and away, and the path must never get CLOSER to the sun
    // than the (tiny) starting separation.
    const s = sun(175, 77.6);
    const plan = planPark(I, 175, 77, s, 25, -20, LIM);
    expect(plan.kind).toBe("direct");
    expect(plan.waypoints).toEqual([{ panDeg: 175, tiltDeg: -20 }]);
    const startSep = angleBetweenDeg(boresightEnu(I, 175, 77), s);
    let prev = { panDeg: 175, tiltDeg: 77 };
    let worst = Infinity;
    for (const wp of plan.waypoints) {
      const span = Math.max(Math.abs(wp.panDeg - prev.panDeg), Math.abs(wp.tiltDeg - prev.tiltDeg));
      const steps = Math.max(1, Math.ceil(span / 0.25));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const pan = prev.panDeg + (wp.panDeg - prev.panDeg) * f;
        const tilt = prev.tiltDeg + (wp.tiltDeg - prev.tiltDeg) * f;
        worst = Math.min(worst, angleBetweenDeg(boresightEnu(I, pan, tilt), s));
      }
      prev = wp;
    }
    expect(worst).toBeGreaterThanOrEqual(startSep - 0.01); // never closer than the start
  });

  it("a pan-detour's second (tilt) leg stays STRICTLY outside the cone, even from an in-cone start", () => {
    // In-cone start (sep ~6.99° < 25°) whose direct tilt-down dips toward a sun
    // below it → forces a detour. The escape relaxation applies only to the leg
    // that starts at the forced current position (the pan sweep); the tilt sweep
    // at the chosen detour pan must NOT re-enter the cone.
    //
    // NOTE ON GEOMETRY CHOICE: the task brief's original numbers for this test —
    // sun(-40, 61.5), start (0, 68), cone 25 — are VACUOUS against this fix: planPark
    // offers exactly two detour candidates, sunPT.panDeg ± clearOffset, and because
    // cos(+off) === cos(-off) their tilt-sweep minimum separation from the sun is
    // mathematically IDENTICAL. Pre-fix, the relaxed threshold let the +offset
    // candidate through at a ~24.3° dip (< the 25° cone) — the bug this test guards
    // against. Post-fix, the strict check correctly rejects that dip, but by the same
    // symmetry the -offset candidate has the identical ~24.3° minimum, so it is
    // rejected too, and planPark falls through to "no-safe-path" rather than a
    // different, still-valid detour. That makes `if (kind !== "pan-detour") return`
    // skip the assertion loop entirely — a silently-vacuous test. This is not a bad
    // choice of numbers; it is a structural property of the ± symmetric candidate
    // search: no geometry can be simultaneously non-vacuous post-fix AND a literal
    // pass/fail differentiator against the pre-fix relaxed tiltClear for the SAME
    // inputs (see task-5-report.md for the full argument). The geometry below is a
    // genuine, verified pan-detour instead, so `expect(plan.kind)` below is a real
    // assertion, not a bypassable guard.
    const s = sun(0, 10);
    const cone = 25;
    const plan = planPark(I, 5, 15, s, cone, -20, LIM);
    expect(plan.kind).toBe("pan-detour"); // must be non-vacuous, not silently skipped
    const [wp1, wp2] = plan.waypoints; // (detourPan, curTilt) then (detourPan, parkTilt)
    const steps = Math.max(1, Math.ceil(Math.abs(wp2.tiltDeg - wp1.tiltDeg) / 0.25));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const tilt = wp1.tiltDeg + (wp2.tiltDeg - wp1.tiltDeg) * f;
      expect(angleBetweenDeg(boresightEnu(I, wp2.panDeg, tilt), s)).toBeGreaterThanOrEqual(cone);
    }
  });

  it("REGRESSION: a geometry whose only detours would dip into the cone yields no-safe-path, never a cone-dipping detour", () => {
    // This exact geometry returned a pan-detour whose second leg reached ~24.3°
    // (< the 25° cone) when tiltClear used the relaxed sweepClear threshold. With
    // tiltClear strict, both symmetric detour candidates (±clearOffset) are
    // rejected identically and planPark falls through to no-safe-path. Asserting
    // no-safe-path fails loudly if a future change re-relaxes tiltClear (which
    // would make this return the cone-dipping pan-detour again).
    const plan = planPark(I, 0, 68, sun(-40, 61.5), 25, -20, LIM);
    expect(plan.kind).toBe("no-safe-path");
  });

  it("reports no-safe-path (empty waypoints) when limits block every detour around a low sun", () => {
    // Low sun straight ahead, but pan is pinned to a tiny window around it.
    const tight = { panMin: -5, panMax: 5, tiltMin: -30, tiltMax: 90 };
    const plan = planPark(I, 0, 40, sun(0, 10), 15, -20, tight);
    expect(plan.kind).toBe("no-safe-path");
    expect(plan.waypoints).toEqual([]);
  });

  it("degeneracy never coincides with danger: a near-zenith sun is never the crossing case", () => {
    // Sun near zenith (el 88°). Whatever the boresight, tilting down away from
    // near-vertical increases separation → always direct, never a detour.
    for (const bore of [0, 45, 90, 135, 180]) {
      const plan = planPark(I, bore, 30, sun(bore, 88), 20, -20, LIM);
      expect(plan.kind).toBe("direct");
    }
  });
});
