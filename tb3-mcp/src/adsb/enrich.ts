import { Aircraft, EnrichedAircraft } from "./types.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";
import { Mat3, Vec3, angleBetweenDeg, add, sub, scale, dot, norm, normalize } from "../geo/vec3.js";
import { enuToPanTiltOffset } from "../geo/imu-orientation.js";
import { reachablePanTilt } from "../geo-tools.js";
import { sunEnu } from "../geo/sun.js";
import { Config } from "../config.js";
import { aircraftGeodetic, aircraftVelocity } from "./convert.js";

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
function limitsOf(cfg: Config): { panMin: number; panMax: number; tiltMin: number; tiltMax: number } {
  return { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax };
}

function isTrackableAt(
  enu: Vec3, R: Mat3, cfg: Config, sEnu: Vec3, cHead: Vec3,
): boolean {
  const range = norm(enu);
  if (range < 1) return false;
  const unit = normalize(enu);
  const { panDeg, tiltDeg } = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limitsOf(cfg));
  const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
  if ("error" in reach) return false;
  return angleBetweenDeg(unit, sEnu) >= cfg.sunConeDeg;
}

// Seconds the aircraft stays trackable (reachable ∧ sun-safe) from now, stepping
// ENU position forward at constant velocity. Sun motion over ≤120 s is negligible,
// so a single sun vector is used. Returns 0 if not trackable now.
function estimateTrackSec(
  enu0: Vec3, vel: Vec3 | null, R: Mat3, cfg: Config, sEnu: Vec3, slewOkNow: boolean, cHead: Vec3,
): number {
  if (!isTrackableAt(enu0, R, cfg, sEnu, cHead) || !slewOkNow) return 0;
  if (!vel) return EST_CAP_SEC;   // stationary/unknown: assume it stays put
  for (let t = EST_STEP_SEC; t <= EST_CAP_SEC; t += EST_STEP_SEC) {
    if (!isTrackableAt(add(enu0, scale(vel, t)), R, cfg, sEnu, cHead)) return t - EST_STEP_SEC;
  }
  return EST_CAP_SEC;
}

// cHead defaults to the no-offset identity, so every existing caller (and
// test) that doesn't pass it keeps getting exactly the legacy enuToPanTilt
// mapping. geoPanSign is not a separate parameter here -- cfg already carries
// it (cfg.geoPanSign), and production callers source cfg the normal way.
export function enrichAircraft(
  ac: Aircraft, rig: Geodetic, R: Mat3, cfg: Config, nowMs: number, cHead: Vec3 = [0, 1, 0],
): EnrichedAircraft | null {
  const g = aircraftGeodetic(ac, cfg.adsbAltSource);
  if (!g) return null;

  const enu = enuPosition(rig, g);
  const range = norm(enu);
  const unit = range > 0 ? normalize(enu) : ([0, 0, 1] as Vec3);
  const { azimuthDeg, elevationDeg } = azElOfUnit(unit);

  const { panDeg, tiltDeg } = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limitsOf(cfg));
  const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
  const reachable = !("error" in reach);

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

  const estTrackSec = estimateTrackSec(enu, vel, R, cfg, sEnu, slewOk, cHead);

  return {
    ...ac,
    azimuthDeg, elevationDeg, rangeM: range,
    reachable, sunSafe, slewOk, requiredSlewDps, estTrackSec,
  };
}
