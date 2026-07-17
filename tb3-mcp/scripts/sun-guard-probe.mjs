// tb3-mcp/scripts/sun-guard-probe.mjs
//
// Shadow test: measure the combined calibration + clock error against the sun,
// which is the number that sizes the sun-guard exclusion cone.
//
// Requires a build first (the probe imports the compiled solar-position code so
// the math is never duplicated):   npm run build
//
// Usage (from tb3-mcp/):  node scripts/sun-guard-probe.mjs <LAT> <LON> [HEIGHT_M=0]
//   e.g. node scripts/sun-guard-probe.mjs 33.4484 -112.074
//
// RUN WITH THE CAMERA REMOVED. The rig points AT the sun; a lens there burns.

import { sunAzEl } from "../dist/geo/sun.js";

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const height = Number(process.argv[4] ?? 0);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error("usage: node scripts/sun-guard-probe.mjs <LAT> <LON> [HEIGHT_M=0]");
  console.error("  (run `npm run build` first — this imports dist/geo/sun.js)");
  process.exit(1);
}

const now = Date.now();
const { azDeg, elDeg } = sunAzEl({ lat, lon, height }, now);

console.log(`\nSun right now (${new Date(now).toISOString()}):`);
console.log(`  azimuth   ${azDeg.toFixed(2)}°  (from true north, clockwise)`);
console.log(`  elevation ${elDeg.toFixed(2)}°`);
if (elDeg <= 0) {
  console.log(`\n  The sun is below the horizon — no shadow test now.`);
  process.exit(0);
}
console.log(`\n--- shadow test (CAMERA REMOVED) ---`);
console.log(`1. Confirm the daemon's clock: this UTC must match the real world.`);
console.log(`2. Point the rig at the sun via your MCP client:`);
console.log(`     point_at_azel  azimuth_deg=${azDeg.toFixed(2)}  elevation_deg=${elDeg.toFixed(2)}`);
console.log(`3. Aim a straight rod/edge along the boresight and read its shadow.`);
console.log(`   Dead-on the sun, the shadow collapses to a point.`);
console.log(`4. Any offset IS your combined R + clock error, in degrees.`);
console.log(`   A point-shadow validates BOTH R and the clock at once (a 1-hour`);
console.log(`   clock error would read as ~15° of azimuth offset).`);
console.log(`5. Size the cone:  R_error + FOV/2 + ~0.5° tracking + 0.27° sun + margin.`);
console.log(`   Set it with:  set_sun_guard cone_deg=<that>   (Phase 2)\n`);
