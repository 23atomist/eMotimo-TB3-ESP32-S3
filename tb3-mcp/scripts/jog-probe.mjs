// Task 0 hardware check for layer 3 (target tracking).
//
// Why this exists: layer 1's /api/goto hung on real hardware because DFSetup()
// never runs from the boot menu, leaving the motor motion params at 0 so the
// move planner produced NaN. The joystick/jog path may carry the SAME
// exposure -- and the entire layer-3 rate servo rides that path. Verify it
// moves before building a controller on top of it.
//
// It also measures the rig's true deg/s at a given deflection, which is what
// the servo's feedforward accuracy depends on and what maxJogDps should be set
// from.
//
// Usage (from tb3-mcp/):   node scripts/jog-probe.mjs <RIG_IP> [deflection] [seconds]
//   e.g. node scripts/jog-probe.mjs 192.168.4.87 50 3
//
// RUN WITH THE CAMERA REMOVED. At 50% for 3s expect roughly 30-35 deg of pan.

import WebSocket from "ws";

const STEPS_PER_DEG = 444.444;
const host = process.argv[2];
const deflection = Number(process.argv[3] ?? 50);
const seconds = Number(process.argv[4] ?? 3);

if (!host) {
  console.error("usage: node scripts/jog-probe.mjs <RIG_IP> [deflection=50] [seconds=3]");
  process.exit(1);
}

const url = `ws://${host}/ws`;
console.log(`connecting to ${url} ...`);

const ws = new WebSocket(url);
let last = null;         // latest tick
const samples = [];      // { tMs, panSteps, tiltSteps, moving }
let jogging = false;

const fail = (msg) => { console.error(`\nFAIL: ${msg}`); process.exit(1); };

// Guards the CONNECT phase only — cleared on open, so a long `seconds` arg
// cannot trip it mid-jog.
const connectTimer = setTimeout(
  () => fail("no websocket connection after 8s — wrong IP, or the rig is not on this network?"), 8000,
);

ws.on("error", (e) => fail(`websocket error: ${e.message}`));

ws.on("message", (buf) => {
  let d;
  try { d = JSON.parse(buf.toString()); } catch { return; }
  if (d.type !== "tick" || !Array.isArray(d.pos)) return;
  last = d;
  if (jogging) samples.push({ tMs: Date.now(), panSteps: d.pos[0], tiltSteps: d.pos[1], moving: d.moving });
});

ws.on("open", async () => {
  clearTimeout(connectTimer);
  console.log("connected. waiting for telemetry ...");
  await waitFor(() => last !== null, 5000, "no 'tick' telemetry received — is this really a TB3?");

  console.log(`LCD now reads: ${JSON.stringify(last.lcd ?? "(none)")}`);
  console.log(`  ^ confirm this is the BOOT MENU screen (not Dragonframe/jog) — that is the state that broke goto.`);
  console.log(`start pos: pan=${last.pos[0]} steps (${(last.pos[0] / STEPS_PER_DEG).toFixed(2)}°)  moving=${last.moving}`);

  const startSteps = last.pos[0];
  const t0 = Date.now();
  jogging = true;

  console.log(`\njogging pan at ${deflection}% for ${seconds}s ...`);
  const timer = setInterval(() => ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 })), 100);
  ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 }));

  await sleep(seconds * 1000);

  clearInterval(timer);
  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));
  jogging = false;
  await sleep(400);            // let it settle + one more tick land

  const endSteps = last.pos[0];
  const elapsedSec = (Date.now() - t0) / 1000;
  const deltaSteps = endSteps - startSteps;
  const deltaDeg = deltaSteps / STEPS_PER_DEG;
  const dps = deltaDeg / elapsedSec;
  const everMoved = samples.some((s) => s.moving);

  console.log(`\n--- result ---`);
  console.log(`end pos:    pan=${endSteps} steps (${(endSteps / STEPS_PER_DEG).toFixed(2)}°)`);
  console.log(`moved:      ${deltaSteps} steps = ${deltaDeg.toFixed(2)}° over ${elapsedSec.toFixed(2)}s`);
  console.log(`ticks seen: ${samples.length}, any moving=1: ${everMoved}`);

  // Tick-to-tick instantaneous rate. The firmware ramps the jog accumulator
  // (updateMotorVelocities2: (65535/20)/1.0 per 20Hz cycle), so the average
  // above UNDER-reports the steady-state ceiling. The plateau is the number
  // that actually sets maxJogDps and scales the servo's feedforward.
  if (samples.length >= 4) {
    const rates = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].tMs - samples[i - 1].tMs) / 1000;
      if (dt <= 0) continue;
      rates.push({
        tSec: (samples[i].tMs - t0) / 1000,
        dps: ((samples[i].panSteps - samples[i - 1].panSteps) / STEPS_PER_DEG) / dt,
      });
    }
    console.log(`\n--- instantaneous rate profile (watch the ramp, then the plateau) ---`);
    for (const r of rates) console.log(`  t=${r.tSec.toFixed(2)}s   ${r.dps.toFixed(2)} °/s`);

    // Plateau = the back half, once the ramp has settled.
    //
    // MEDIAN, not mean. Telemetry is 5Hz, and when two ticks land close together
    // the tick-to-tick dt is tiny, so dps explodes -- a 6s run at full deflection
    // threw 36.5 and 44.0 °/s aliasing spikes against a true 19.0. A mean of that
    // reported 21.0 and told the operator to set TB3_MAX_JOG_DPS=21.0, which would
    // over-scale the layer-3 servo's feedforward by ~10%. The spikes are one-sided
    // (dt can shrink but not stretch below the true tick period), so they drag a
    // mean up and a median not at all.
    const back = rates.slice(Math.floor(rates.length / 2))
      .map((r) => Math.abs(r.dps))
      .sort((a, b) => a - b);
    const mid = Math.floor(back.length / 2);
    const plateau = back.length % 2 ? back[mid] : (back[mid - 1] + back[mid]) / 2;
    console.log(`\n  PLATEAU (median of back half): ${plateau.toFixed(2)} °/s at ${deflection}% deflection`);
    console.log(`    (back-half spread: ${back[0].toFixed(2)} .. ${back[back.length - 1].toFixed(2)} °/s —`);
    console.log(`     a wide spread is 5Hz telemetry aliasing, not real rate variation)`);
    if (deflection === 100) {
      console.log(`  => this IS maxJogDps. Set TB3_MAX_JOG_DPS=${plateau.toFixed(1)}`);
      console.log(`     (goto's firmware ceiling is 22.5 °/s = 10000 steps/s; a close match is a good sign)`);
    } else {
      const implied = plateau / Math.pow((Math.abs(deflection) - 5) / 95, 3);
      console.log(`  => implied full-deflection max via the CUBIC curve: ${implied.toFixed(2)} °/s`);
    }
  }

  if (Math.abs(deltaDeg) < 0.5) {
    console.log(`\n>>> VERDICT: NO MOTION from this screen.`);
    console.log(`    Web jog is MODE-GATED: motion needs DFSetup() + NunChuckQuerywithEC() +`);
    console.log(`    updateMotorVelocities2() to all coincide, which happens on a program's`);
    console.log(`    point-setting screen ("Move to Start Pt"), NOT on a menu (where the`);
    console.log(`    joystick drives menu navigation instead).`);
    console.log(`    -> Put the rig on "Move to Start Pt" and retry before concluding anything.`);
  } else {
    console.log(`\n>>> VERDICT: JOG WORKS from this screen.`);
    console.log(`    Average over the whole hold: ${Math.abs(dps).toFixed(2)} °/s at ${deflection}% deflection.`);
    console.log(`    NOTE: deflection->rate is CUBIC, not linear -- do NOT extrapolate linearly.`);
    console.log(`          rate ~= MAX * ((|x|-5)/95)^3   (see the plateau figure above for MAX)`);
    if (deltaDeg < 0) {
      console.log(`    NOTE: pan moved NEGATIVE for a positive deflection — you likely want TB3_PAN_SIGN=-1.`);
    }
  }

  ws.close();
  process.exit(0);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond, timeoutMs, msg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return;
    await sleep(50);
  }
  fail(msg);
}
