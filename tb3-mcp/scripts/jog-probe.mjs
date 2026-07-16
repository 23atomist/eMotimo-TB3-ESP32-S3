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

setTimeout(() => fail("no websocket connection after 8s — wrong IP, or the rig is not on this network?"), 8000).unref();

ws.on("error", (e) => fail(`websocket error: ${e.message}`));

ws.on("message", (buf) => {
  let d;
  try { d = JSON.parse(buf.toString()); } catch { return; }
  if (d.type !== "tick" || !Array.isArray(d.pos)) return;
  last = d;
  if (jogging) samples.push({ tMs: Date.now(), panSteps: d.pos[0], tiltSteps: d.pos[1], moving: d.moving });
});

ws.on("open", async () => {
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

  if (Math.abs(deltaDeg) < 0.5) {
    console.log(`\n>>> VERDICT: NO MOTION. The jog path is broken from this screen.`);
    console.log(`    This is very likely the same root cause as the /api/goto hang:`);
    console.log(`    uninitialized motor motion params (DFSetup never ran from the boot menu).`);
    console.log(`    -> Layer 3 needs the firmware fix (plan Task 0, Step 4) before the servo can work.`);
  } else {
    console.log(`\n>>> VERDICT: JOG WORKS from this screen.`);
    console.log(`    Measured ${Math.abs(dps).toFixed(2)} °/s at ${deflection}% deflection.`);
    console.log(`    Implied full-deflection rate: ${(Math.abs(dps) * 100 / deflection).toFixed(2)} °/s`);
    console.log(`    -> Set config maxJogDps to about ${(Math.abs(dps) * 100 / deflection).toFixed(1)} (TB3_MAX_JOG_DPS).`);
    console.log(`       The servo's feedforward is only as accurate as this number.`);
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
