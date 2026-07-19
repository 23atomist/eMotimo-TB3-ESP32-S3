// tb3-mcp/scripts/imu-probe.mjs
//
// IMU characterization probe. Pulls a raw burst from the firmware and prints
// per-axis statistics. Run at rest and again during a jog (and with the
// steppers idle vs moving) using the label arg; comparing labeled runs is how
// we judge vibration coupling into the accel and whether the mag survives the
// stepper field.
//
// Requires a build first (imports the compiled stats fn so math is not
// duplicated):  npm run build
//
// Usage (from tb3-mcp/):  node scripts/imu-probe.mjs <IP> [n=200] [label]
//   e.g.  node scripts/imu-probe.mjs 192.168.4.56 200 rest

import { computeImuStats } from "../dist/imu-stats.js";

const ip = process.argv[2];
const n = Number(process.argv[3] ?? 200);
const label = process.argv[4] ?? "";
if (!ip) {
  console.error("usage: node scripts/imu-probe.mjs <IP> [n=200] [label]");
  console.error("  (run `npm run build` first — imports dist/imu-stats.js)");
  process.exit(1);
}

// The rig's WiFi is marginal — large bursts can stall mid-transfer. Retry with
// a per-attempt timeout that also covers the body read (a stalled stream aborts
// and retries instead of hanging forever).
async function fetchBurst(url, attempts = 5, timeoutMs = 20000) {
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      clearTimeout(timer);
      return j;
    } catch (err) {
      clearTimeout(timer);
      if (i === attempts) throw err;
      console.error(`  attempt ${i}/${attempts} failed (${err?.message ?? err}); retrying…`);
    }
  }
}

let burst;
try {
  burst = await fetchBurst(`http://${ip}/api/imu?n=${n}`);
} catch (err) {
  console.error(`GET /api/imu failed after retries: ${err?.message ?? err}`);
  console.error("  (marginal WiFi — try a smaller n, e.g. `node scripts/imu-probe.mjs <IP> 80 <label>`)");
  process.exit(1);
}

if (!burst.info?.present) {
  console.error("IMU not present:", JSON.stringify(burst.info));
  process.exit(1);
}

const s = computeImuStats(burst);
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "NaN");

console.log(`\n=== IMU burst ${label ? `[${label}] ` : ""}${new Date().toISOString()} ===`);
console.log(`chip     MPU ${burst.info.mpu_who}  MAG ${burst.info.mag_who}  BMP ${burst.info.bmp_id}` +
            `   (accel ±${burst.info.accel_fs_g}g, gyro ±${burst.info.gyro_fs_dps}dps)`);
console.log(`samples  ${s.sampleCount}   rate ${f(s.rateHz, 1)} Hz   read_errors ${s.readErrors}`);
console.log(`accel g  x ${f(s.accel.x.mean)}±${f(s.accel.x.std)}  y ${f(s.accel.y.mean)}±${f(s.accel.y.std)}  ` +
            `z ${f(s.accel.z.mean)}±${f(s.accel.z.std)}   |a| ${f(s.accel.magMean)} (expect ~1.0 at rest)`);
console.log(`gyro dps x ${f(s.gyro.x.mean)}±${f(s.gyro.x.std)}  y ${f(s.gyro.y.mean)}±${f(s.gyro.y.std)}  ` +
            `z ${f(s.gyro.z.mean)}±${f(s.gyro.z.std)}   (mean = bias)`);
console.log(`mag µT   x ${f(s.mag.x.mean, 2)}±${f(s.mag.x.std, 2)}  y ${f(s.mag.y.mean, 2)}±${f(s.mag.y.std, 2)}  ` +
            `z ${f(s.mag.z.mean, 2)}±${f(s.mag.z.std, 2)}   |m| ${f(s.mag.magMean, 2)}  valid ${s.mag.validCount}/${s.sampleCount}`);
console.log(`baro     ${f(s.baro.tempMean, 2)} °C   ${f(s.baro.pressMean, 2)} hPa`);
