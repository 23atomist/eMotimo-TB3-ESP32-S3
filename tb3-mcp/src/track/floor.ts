import { Vec3 } from "../geo/vec3.js";

/**
 * A minimum-elevation gate on TRACKING, deliberately separate from the taught
 * travel limits.
 *
 * The travel limits (limits-store.ts) constrain EVERY motion path including
 * manual jog, which is exactly what makes them the wrong tool for "never aim
 * into the neighbour's front window": raising tiltMin far enough to clear a
 * roofline also makes it impossible to drive the rig level, which the
 * levelling and calibration workflows both need.
 *
 * So this mirrors the azimuth sector instead (track/sector.ts): it is checked
 * only on the tracking paths -- tick() and beginAcquire() -- and is invisible
 * to jog, goto and the levelling workflow.
 */
export interface TrackFloor {
  enabled: boolean;
  minElevationDeg: number;
}

export const DISABLED_FLOOR: TrackFloor = { enabled: false, minElevationDeg: 0 };

/**
 * True if a target at elDeg may be tracked. A disabled floor admits
 * everything.
 *
 * Written as `elDeg >= min` rather than `!(elDeg < min)` on purpose: both read
 * the same for real numbers, but they differ on NaN. `>=` is false for NaN, so
 * a target whose elevation could not be derived FAILS CLOSED (refused) instead
 * of sailing past the one guard that exists to stop the rig pointing at a
 * house. The negated form would admit it. test/floor.test.ts pins this.
 */
export function aboveFloor(elDeg: number, floor: TrackFloor): boolean {
  if (!floor.enabled) return true;
  return elDeg >= floor.minElevationDeg;
}

/**
 * Elevation (degrees above the horizon) of an ENU unit vector. The twin of
 * session.ts's enuAzimuthDeg, and lives here for the same reason the azimuth
 * helper lives next to its gate: the floor check and any status reporting must
 * derive elevation identically or they can drift apart.
 *
 * The clamp matters. `enuUnit` is normalised upstream, but floating point can
 * leave |z| a few ULPs over 1, and Math.asin(1.0000000002) is NaN -- which,
 * combined with the fail-closed rule above, would wedge tracking permanently
 * for a target that is merely pointing straight up.
 */
export function enuElevationDeg(enuUnit: Vec3): number {
  const z = Math.max(-1, Math.min(1, enuUnit[2]));
  return (Math.asin(z) * 180) / Math.PI;
}
