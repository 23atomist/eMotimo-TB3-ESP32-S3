// Bench probe: does POST /api/stop halt a JOG, and does the stop LATCH hold
// against a client that never stops asking?
//
// Why this exists: /api/stop zeroes the rig's stored joystick vector, but a
// client streaming jog frames (which layer 3's servo does at 10Hz) re-applies
// its vector on the very next frame ~100ms later. Measured on the rig before the
// fix: /api/stop returned 200 and the pan carried on for 3.0deg and kept going.
// The firmware now latches the web joystick at centre until the client sends a
// centred frame -- you must let go before you can drive again. This verifies the
// whole contract, adversarially: we keep pumping non-zero frames throughout.
//
// Usage (from tb3-mcp/):  node scripts/stop-probe.mjs <RIG_IP> [deflection=50]
// Put the rig in Track (Web) first. RUN WITH THE CAMERA REMOVED.

import WebSocket from "ws";

const STEPS_PER_DEG = 444.444;
const host = process.argv[2];
const deflection = Number(process.argv[3] ?? 50);
if (!host) {
  console.error("usage: node scripts/stop-probe.mjs <RIG_IP> [deflection=50]");
  process.exit(1);
}

const ws = new WebSocket(`ws://${host}/ws`);
let last = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];

ws.on("error", (e) => { console.error(`websocket error: ${e.message}`); process.exit(1); });
ws.on("message", (buf) => {
  let d; try { d = JSON.parse(buf.toString()); } catch { return; }
  if (d.type === "tick" && Array.isArray(d.pos)) last = d;
});

const status = async () => (await fetch(`http://${host}/api/status`)).json();

ws.on("open", async () => {
  while (last === null) await sleep(50);
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(2);
  const pan = () => last.pos[0] / STEPS_PER_DEG;
  console.log(`LCD: ${JSON.stringify(last.lcd ?? "(none)")}\n`);

  // Pump a non-zero jog vector at 10Hz for the whole test, exactly like the
  // tracking servo does. Nothing below ever stops sending it except step 3.
  let vec = { x: deflection, y: 0, aux: 0 };
  const pump = setInterval(() => ws.send(JSON.stringify(vec)), 100);
  ws.send(JSON.stringify(vec));
  await sleep(2000);
  console.log(`1. jogging: pan=${pan().toFixed(2)}° moving=${last.moving}`);
  if (last.moving !== 1) fails.push("rig never started jogging — is it in Track (Web)?");

  // --- stop, while frames keep flowing ---
  const r = await (await fetch(`http://${host}/api/stop`, { method: "POST" })).text();
  console.log(`2. POST /api/stop -> ${r.trim()}   (still pumping x=${deflection})`);
  await sleep(2000);
  const panStopped = pan();
  console.log(`   after 2s: pan=${panStopped.toFixed(2)}° moving=${last.moving} joy_latched=${(await status()).joy_latched}`);
  if (last.moving !== 0) fails.push("STOP DID NOT HALT THE JOG while frames flowed");

  // --- latch must HOLD: keep commanding motion, rig must stay put ---
  await sleep(1500);
  const drift = Math.abs(pan() - panStopped);
  console.log(`3. latch holding? still pumping x=${deflection}: drifted ${drift.toFixed(2)}° in 1.5s, moving=${last.moving}`);
  if (drift > 0.1) fails.push(`LATCH LEAKED: rig moved ${drift.toFixed(2)}° while latched`);

  // --- release: an explicit centred frame is the only thing that clears it ---
  vec = { x: 0, y: 0, aux: 0 };
  await sleep(400);
  const relLatched = (await status()).joy_latched;
  console.log(`4. sent centred frame: joy_latched=${relLatched}`);
  if (relLatched !== false) fails.push("latch did NOT release on a centred frame");

  // --- and the rig must be drivable again afterwards ---
  const panBeforeRedrive = pan();
  vec = { x: deflection, y: 0, aux: 0 };
  await sleep(2000);
  const redrove = Math.abs(pan() - panBeforeRedrive);
  console.log(`5. re-drive after release: moved ${redrove.toFixed(2)}° moving=${last.moving}`);
  if (redrove < 0.5) fails.push("rig did NOT jog again after the latch released — LOCKED OUT");

  clearInterval(pump);
  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));
  await sleep(600);

  console.log(`\n--- verdict ---`);
  if (fails.length === 0) {
    console.log("PASS: stop halts a jog through a streaming client, the latch holds,");
    console.log("      it releases only on an explicit centred frame, and the rig drives again.");
  } else {
    for (const f of fails) console.log(`FAIL: ${f}`);
  }
  ws.close();
  process.exit(fails.length ? 1 : 0);
});
