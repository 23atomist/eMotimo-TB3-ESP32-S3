import { Geodetic } from "./wgs84.js";
import { Vec3, deg2rad, rad2deg } from "./vec3.js";

// NOAA solar-position algorithm (the one the NOAA Solar Calculator uses).
// Input tMs is Unix epoch milliseconds; output azimuth is from true north,
// clockwise, [0,360); elevation is refraction-corrected degrees.
export function sunAzEl(rig: Geodetic, tMs: number): { azDeg: number; elDeg: number } {
  const jd = tMs / 86400000 + 2440587.5;      // Julian Day from Unix ms
  const jc = (jd - 2451545.0) / 36525.0;      // Julian centuries since J2000.0

  const gml = mod360(280.46646 + jc * (36000.76983 + jc * 0.0003032)); // geom mean long (deg)
  const gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);          // geom mean anomaly (deg)
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);     // eccentricity

  const gmaR = deg2rad(gma);
  const ctr =
    Math.sin(gmaR) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * gmaR) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * gmaR) * 0.000289;            // equation of centre (deg)
  const trueLong = gml + ctr;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega)); // apparent long (deg)

  const seconds = 21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813));
  const obl = 23.0 + (26.0 + seconds / 60.0) / 60.0;
  const oblCorr = obl + 0.00256 * Math.cos(deg2rad(omega));               // corrected obliquity (deg)

  const declR = Math.asin(Math.sin(deg2rad(oblCorr)) * Math.sin(deg2rad(appLong)));

  const y = Math.tan(deg2rad(oblCorr / 2)) ** 2;
  const gmlR = deg2rad(gml);
  const eot =
    4 *
    rad2deg(
      y * Math.sin(2 * gmlR) -
        2 * ecc * Math.sin(gmaR) +
        4 * ecc * y * Math.sin(gmaR) * Math.cos(2 * gmlR) -
        0.5 * y * y * Math.sin(4 * gmlR) -
        1.25 * ecc * ecc * Math.sin(2 * gmaR),
    ); // equation of time (minutes)

  // Minutes past UTC midnight for this instant.
  const dayMs = ((tMs % 86400000) + 86400000) % 86400000;
  const minutes = dayMs / 60000;
  const tst = mod(minutes + eot + 4 * rig.lon, 1440); // true solar time (min)
  let ha = tst / 4 - 180;                             // hour angle (deg)
  if (ha < -180) ha += 360;

  const latR = deg2rad(rig.lat);
  const haR = deg2rad(ha);
  const zenith = Math.acos(
    Math.min(1, Math.max(-1, Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR))),
  );
  let elDeg = 90 - rad2deg(zenith);
  elDeg += refractionDeg(elDeg);

  // Azimuth from north, clockwise.
  const den = Math.cos(latR) * Math.sin(zenith);
  let azDeg: number;
  if (Math.abs(den) < 1e-9) {
    azDeg = 180;
  } else {
    const c = Math.min(1, Math.max(-1, (Math.sin(latR) * Math.cos(zenith) - Math.sin(declR)) / den));
    const acc = rad2deg(Math.acos(c));
    azDeg = ha > 0 ? mod360(acc + 180) : mod360(540 - acc);
  }
  return { azDeg, elDeg };
}

export function sunEnu(rig: Geodetic, tMs: number): Vec3 {
  const { azDeg, elDeg } = sunAzEl(rig, tMs);
  const az = deg2rad(azDeg);
  const el = deg2rad(elDeg);
  const ce = Math.cos(el);
  return [ce * Math.sin(az), ce * Math.cos(az), Math.sin(el)];
}

// Atmospheric refraction (deg), significant only near the horizon.
function refractionDeg(elDeg: number): number {
  if (elDeg > 85) return 0;
  const te = Math.tan(deg2rad(elDeg));
  let sec: number;
  if (elDeg > 5) sec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elDeg > -0.575) sec = 1735 + elDeg * (-518.2 + elDeg * (103.4 + elDeg * (-12.79 + elDeg * 0.711)));
  else sec = -20.772 / te;
  return sec / 3600;
}

function mod(a: number, n: number): number { return ((a % n) + n) % n; }
function mod360(a: number): number { return mod(a, 360); }
