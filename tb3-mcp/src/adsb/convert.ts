import { Aircraft } from "./types.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";
import { velocityFromSpeedHeading } from "../track/estimator.js";

const FT_TO_M = 0.3048;
const KT_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.3048 / 60;   // ft/min → m/s

export type AltSource = "auto" | "geom" | "baro";

// Aircraft altitude in meters using the configured source. `auto` prefers the
// GPS/geometric (WGS84 ellipsoidal) altitude, which matches the rig's height
// datum; barometric is a pressure altitude and can differ by hundreds of feet.
export function aircraftAltitudeM(ac: Aircraft, altSource: AltSource): number | null {
  let ft: number | null;
  if (altSource === "geom") ft = ac.altGeomFt;
  else if (altSource === "baro") ft = ac.altBaroFt;
  else ft = ac.altGeomFt ?? ac.altBaroFt;   // auto
  return ft === null ? null : ft * FT_TO_M;
}

export function aircraftGeodetic(ac: Aircraft, altSource: AltSource): Geodetic | null {
  if (ac.lat === null || ac.lon === null) return null;
  const height = aircraftAltitudeM(ac, altSource);
  if (height === null) return null;
  return { lat: ac.lat, lon: ac.lon, height };
}

// ENU velocity from aviation fields. Null when speed or track is missing (an
// unusable velocity — the estimator will derive one from successive fixes).
export function aircraftVelocity(ac: Aircraft): Vec3 | null {
  if (ac.gsKt === null || ac.trackDeg === null) return null;
  const climbFpm = ac.geomRateFpm ?? ac.baroRateFpm ?? 0;
  return velocityFromSpeedHeading(ac.gsKt * KT_TO_MPS, ac.trackDeg, climbFpm * FPM_TO_MPS);
}
