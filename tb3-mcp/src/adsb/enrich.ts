import { Aircraft, EnrichedAircraft } from "./types.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";
import { Mat3, Vec3, angleBetweenDeg, add, sub, scale, dot, norm, normalize } from "../geo/vec3.js";
import { enuToPanTiltOffset } from "../geo/imu-orientation.js";
import { reachablePanTilt } from "../geo-tools.js";
import { sunEnu } from "../geo/sun.js";
import { Config } from "../config.js";
import { aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { TrackSector, DISABLED_SECTOR, inArc } from "../track/sector.js";

const RAD2DEG = 180 / Math.PI;
const EST_STEP_SEC = 2;
const EST_CAP_SEC = 120;

function azElOfUnit(unit: Vec3): { azimuthDeg: number; elevationDeg: number } {
  let azimuthDeg = Math.atan2(unit[0], unit[1]) * RAD2DEG;
  if (azimuthDeg < 0) azimuthDeg += 360;
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, unit[2]))) * RAD2DEG;
  return { azimuthDeg, elevationDeg };
}

// cfg already carries geoPanSign, so only cHead needs threading separately.
export function limitsOf(cfg: Config): PanTiltLimits {
  return { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax };
}

// The reachability envelope this module measures against. Defaults to the cfg
// CEILING so every pre-existing caller keeps its exact behaviour, but callers
// that know the operator's TAUGHT travel limits must pass the intersection --
// see scanAircraft. Reporting an aircraft reachable against the ceiling when
// the tracker will refuse it against the taught limits is how the dashboard
// came to advertise 15 trackable targets the rig would never move for
// (field bug 2026-08-30).
export interface PanTiltLimits { panMin: number; panMax: number; tiltMin: number; tiltMax: number }

function isTrackableAt(
  enu: Vec3, R: Mat3, cfg: Config, sEnu: Vec3, cHead: Vec3, limits: PanTiltLimits,
): boolean {
  const range = norm(enu);
  if (range < 1) return false;
  const unit = normalize(enu);
  const { panDeg, tiltDeg } = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limits);
  const reach = reachablePanTilt(panDeg, tiltDeg, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
  if ("error" in reach) return false;
  return angleBetweenDeg(unit, sEnu) >= cfg.sunConeDeg;
}

// Seconds the aircraft stays trackable (reachable ∧ sun-safe) from now, stepping
// ENU position forward at constant velocity. Sun motion over ≤120 s is negligible,
// so a single sun vector is used. Returns 0 if not trackable now.
function estimateTrackSec(
  enu0: Vec3, vel: Vec3 | null, R: Mat3, cfg: Config, sEnu: Vec3, slewOkNow: boolean, cHead: Vec3,
  limits: PanTiltLimits,
): number {
  if (!isTrackableAt(enu0, R, cfg, sEnu, cHead, limits) || !slewOkNow) return 0;
  if (!vel) return EST_CAP_SEC;   // stationary/unknown: assume it stays put
  for (let t = EST_STEP_SEC; t <= EST_CAP_SEC; t += EST_STEP_SEC) {
    if (!isTrackableAt(add(enu0, scale(vel, t)), R, cfg, sEnu, cHead, limits)) return t - EST_STEP_SEC;
  }
  return EST_CAP_SEC;
}

// Both trailing parameters default to "as if absent": sector to DISABLED_SECTOR
// (no azimuth filtering) and cHead to the no-offset identity, which yields
// exactly the legacy enuToPanTilt mapping. So every existing caller (and test)
// that passes neither keeps its original behavior. geoPanSign is not a separate
// parameter here -- cfg already carries it (cfg.geoPanSign), and production
// callers source cfg the normal way.
//
// R is the solved mount orientation and is nullable: azimuth/elevation/range
// (and sunSafe/slewOk/inSector, none of which touch the mount frame) come
// straight from rig location + aircraft geodetic and stay fully computed with
// R absent -- exactly what an operator picking a plane to sight needs before
// calibration exists. reachable/estTrackSec genuinely require R (turning a
// world-frame direction into where the rig must point), so they collapse to
// null -- not false -- when it's missing, rather than lying that a plane was
// checked and found unreachable.
export function enrichAircraft(
  ac: Aircraft, rig: Geodetic, R: Mat3 | null, cfg: Config, nowMs: number,
  sector: TrackSector = DISABLED_SECTOR,
  cHead: Vec3 = [0, 1, 0],
  limits: PanTiltLimits = limitsOf(cfg),
): EnrichedAircraft | null {
  const g = aircraftGeodetic(ac, cfg.adsbAltSource);
  if (!g) return null;

  const enu = enuPosition(rig, g);
  const range = norm(enu);
  const unit = range > 0 ? normalize(enu) : ([0, 0, 1] as Vec3);
  const { azimuthDeg, elevationDeg } = azElOfUnit(unit);

  const sEnu = sunEnu(rig, nowMs);
  const sunSafe = angleBetweenDeg(unit, sEnu) >= cfg.sunConeDeg;

  const vel = aircraftVelocity(ac);
  let requiredSlewDps = 0;
  if (vel && range > 1) {
    const radial = scale(unit, dot(vel, unit));   // component along the line of sight
    const perp = sub(vel, radial);
    requiredSlewDps = (norm(perp) / range) * RAD2DEG;
  }
  const slewOk = requiredSlewDps <= cfg.maxJogDps;

  const inSector = inArc(azimuthDeg, sector);

  let reachable: boolean | null = null;
  let estTrackSec: number | null = null;
  if (R) {
    const { panDeg, tiltDeg } = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limits);
    const reach = reachablePanTilt(panDeg, tiltDeg, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    reachable = !("error" in reach);
    estTrackSec = estimateTrackSec(enu, vel, R, cfg, sEnu, slewOk, cHead, limits);
  }

  return {
    ...ac,
    azimuthDeg, elevationDeg, rangeM: range,
    reachable, sunSafe, slewOk, inSector, requiredSlewDps, estTrackSec,
    // scanAircraft overwrites these once policy is evaluated; enrichAircraft
    // itself has no ruleset to consult.
    tier: null, rule: null, ruleId: null, eligible: false, canPreempt: false,
  };
}
