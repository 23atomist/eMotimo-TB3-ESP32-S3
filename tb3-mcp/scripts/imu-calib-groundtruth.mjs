// Ground-truth cross-check using the repo's OWN compiled helpers (dist/geo/*).
// Purpose: (a) print the exact ENU unit vectors + az/el the daemon would compute
// for the two landmarks, so the Python validation can be proven to MATCH the repo;
// (b) reproduce the "bad solve" (base_tilt ~144) via the current solveOrientation.
import { enuDirection, azElRange } from "../dist/geo/wgs84.js";
import { panTiltToMount } from "../dist/geo/boresight.js";
import { solveOrientation, separationDeg } from "../dist/geo/orientation.js";

const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 331 };
const A = { lat: 33.3335, lon: -112.0632, height: 931, panDeg: -26.0, tiltDeg: -31.0 };
const B = { lat: 33.2742, lon: -112.2763, height: 1375, panDeg: -125.2, tiltDeg: -27.3 };

for (const [name, L] of [["A_towers", A], ["B_peak", B]]) {
  const { unit, range } = enuDirection(rig, L);
  const azel = azElRange(rig, L);
  console.log(`${name}: enu=[${unit.map((x) => x.toFixed(8)).join(", ")}] range=${range.toFixed(1)}m az=${azel.azimuth.toFixed(4)} el=${azel.elevation.toFixed(4)}`);
}

// Reproduce the current (broken) TRIAD solve.
const enuA = enuDirection(rig, A).unit;
const enuB = enuDirection(rig, B).unit;
const mountA = panTiltToMount(A.panDeg, A.tiltDeg);
const mountB = panTiltToMount(B.panDeg, B.tiltDeg);
const R = solveOrientation(mountA, enuA, mountB, enuB);
const up = [R[0][2], R[1][2], R[2][2]];               // mount +Z in world
const fwd = [R[0][1], R[1][1], R[2][1]];              // mount +Y in world
let heading = (Math.atan2(fwd[0], fwd[1]) * 180) / Math.PI; if (heading < 0) heading += 360;
const baseTilt = 90 - (Math.asin(Math.max(-1, Math.min(1, up[2]))) * 180) / Math.PI;
console.log(`\ncurrent solveOrientation: heading=${heading.toFixed(2)} base_tilt=${baseTilt.toFixed(2)} sep=${separationDeg(enuA, enuB).toFixed(1)}`);
console.log(`mountA(panTiltToMount)=[${mountA.map((x)=>x.toFixed(5)).join(", ")}]  z=sin(tiltA)=${Math.sin(-31*Math.PI/180).toFixed(5)}`);
