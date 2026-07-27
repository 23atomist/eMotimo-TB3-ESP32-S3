import { Vec3, sub, norm, normalize, deg2rad, rad2deg } from "./vec3.js";

const A = 6378137.0;                 // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;         // flattening
const E2 = F * (2 - F);              // first eccentricity squared

export interface Geodetic {
  lat: number;    // degrees
  lon: number;    // degrees
  height: number; // meters (ellipsoidal; MSL is fine — see plan Global Constraints)
}

export function geodeticToEcef(g: Geodetic): Vec3 {
  const lat = deg2rad(g.lat);
  const lon = deg2rad(g.lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const x = (n + g.height) * cosLat * Math.cos(lon);
  const y = (n + g.height) * cosLat * Math.sin(lon);
  const z = (n * (1 - E2) + g.height) * sinLat;
  return [x, y, z];
}

// Rotate an ECEF delta into the local ENU frame at `origin`.
function ecefDeltaToEnu(origin: Geodetic, delta: Vec3): Vec3 {
  const lat = deg2rad(origin.lat);
  const lon = deg2rad(origin.lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const [dx, dy, dz] = delta;
  const e = -sinLon * dx + cosLon * dy;
  const n = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const u = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  return [e, n, u];
}

// The unnormalized ENU position of `target` relative to `rig`, in meters.
export function enuPosition(rig: Geodetic, target: Geodetic): Vec3 {
  const delta = sub(geodeticToEcef(target), geodeticToEcef(rig));
  return ecefDeltaToEnu(rig, delta);
}

// The inverse direction: apply a local ENU offset (meters) to `origin` and
// return the resulting geodetic position. A linearization at `origin` (using
// its local meridional/prime-vertical radii of curvature), not an iterative
// ECEF->geodetic solve -- but that is more than accurate enough for offsets
// up to several km (see track/estimator.ts's own note: flat-earth error at
// ~1.3km is ~0.13m, far below any achievable pointing accuracy), which is the
// only regime this is used in (ADS-B aircraft-sighting position
// extrapolation -- see adsb/extrapolate.ts). Nothing else in the codebase
// needs this direction of the conversion: rig-relative ENU (enuPosition
// above) is only ever turned into an az/el/pan/tilt, never back into a
// Geodetic -- a Sighting is the one place a real lat/lon/height fix must come
// back out of an ENU delta.
export function geodeticPlusEnu(origin: Geodetic, enuOffsetM: Vec3): Geodetic {
  const lat = deg2rad(origin.lat);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const s2 = E2 * sinLat * sinLat;
  const n = A / Math.sqrt(1 - s2);                    // prime-vertical radius of curvature
  const m = (A * (1 - E2)) / Math.pow(1 - s2, 1.5);    // meridional radius of curvature
  const [de, dn, du] = enuOffsetM;
  return {
    lat: origin.lat + rad2deg(dn / m),
    lon: origin.lon + rad2deg(de / (n * cosLat)),
    height: origin.height + du,
  };
}

export function enuDirection(rig: Geodetic, target: Geodetic): { unit: Vec3; range: number } {
  const enu = enuPosition(rig, target);
  const range = norm(enu);
  return { unit: normalize(enu), range };
}

export interface AzElRange {
  azimuth: number;   // degrees, [0,360)
  elevation: number; // degrees, [-90,90]
  range: number;     // meters
}

// Floating-point noise can push a due-north azimuth to ~359.99999999999994°
// (a hair below 360, which rounds up to "360.00" for display) instead of the
// mathematically equivalent 0°. Snap anything within this epsilon of 360 down
// to 0 so the documented [0,360) invariant actually holds.
const AZIMUTH_SNAP_EPSILON_DEG = 1e-6;

export function azElRange(rig: Geodetic, target: Geodetic): AzElRange {
  const { unit, range } = enuDirection(rig, target);
  let azimuth = rad2deg(Math.atan2(unit[0], unit[1]));
  if (azimuth < 0) azimuth += 360;
  if (azimuth >= 360 - AZIMUTH_SNAP_EPSILON_DEG) azimuth = 0;
  const elevation = rad2deg(Math.asin(Math.max(-1, Math.min(1, unit[2]))));
  return { azimuth, elevation, range };
}
