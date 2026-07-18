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
    // Fly the returned waypoints as single-axis sweeps and confirm the minimum
    // separation never enters the cone — the property the diagonal violated.
    const cone = 15;
    const s = sun(0, 10);
    const plan = planPark(I, 0, 40, s, cone, -20, LIM);
    expect(plan.kind).toBe("pan-detour");
    let prev = { panDeg: 0, tiltDeg: 40 };
    let worst = Infinity;
    for (const wp of plan.waypoints) {
      const axis: "pan" | "tilt" = wp.panDeg !== prev.panDeg ? "pan" : "tilt";
      const fixed = axis === "pan" ? prev.tiltDeg : prev.panDeg;
      const a = axis === "pan" ? prev.panDeg : prev.tiltDeg;
      const b = axis === "pan" ? wp.panDeg : wp.tiltDeg;
      const steps = Math.max(1, Math.ceil(Math.abs(b - a) / 0.25));
      for (let i = 0; i <= steps; i++) {
        const v = a + ((b - a) * i) / steps;
        const enu = axis === "pan" ? boresightEnu(I, v, fixed) : boresightEnu(I, fixed, v);
        worst = Math.min(worst, angleBetweenDeg(enu, s));
      }
      prev = wp;
    }
    expect(worst).toBeGreaterThanOrEqual(cone);
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
