// Bench probe: does POST /api/stop actually halt a JOG in Track (Web) mode?
//
// Why this exists: /api/stop sets hardStopRequested, which
// updateMotorVelocities() consumes -- but Track (Web) drives the motors through
// updateMotorVelocities2(), which never reads that flag. So stop may be a no-op
// against a jog, and the only things that stop it are the daemon's TTL watchdog
// and the firmware's 750ms joystick deadman. Layer 3's `stop` tool calls both
// session.stop() (clears the jog vector) and device.stop(), so a no-op here is
// survivable -- but we should know which mechanism is doing the work.
//
// Usage (from tb3-mcp/):  node scripts/stop-probe.mjs <RIG_IP> [deflection=50]
// RUN WITH THE CAMERA REMOVED.

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
const marks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on("error", (e) => { console.error(`websocket error: ${e.message}`); process.exit(1); });
ws.on("message", (buf) => {
  let d; try { d = JSON.parse(buf.toString()); } catch { return; }
  if (d.type === "tick" && Array.isArray(d.pos)) last = d;
});

ws.on("open", async () => {
  while (last === null) await sleep(50);
  console.log(`LCD: ${JSON.stringify(last.lcd ?? "(none)")}`);
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(2);
  const pan = () => last.pos[0] / STEPS_PER_DEG;

  // Keep the jog vector alive at 10Hz, exactly like the daemon does.
  const pump = setInterval(() => ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 })), 100);
  ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 }));
  console.log(`t=${at()}s  jog ${deflection}% started, pan=${pan().toFixed(2)}°`);

  await sleep(2000);
  const panBeforeStop = pan();
  console.log(`t=${at()}s  pan=${panBeforeStop.toFixed(2)}°  -> POST /api/stop (jog frames KEEP flowing)`);

  const r = await fetch(`http://${host}/api/stop`, { method: "POST" });
  console.log(`t=${at()}s  /api/stop -> ${r.status} ${(await r.text()).trim()}`);

  // Critical: we deliberately KEEP pumping jog frames. If motion continues, stop
  // did not halt the jog -- the deadman never gets a chance to fire.
  await sleep(1500);
  const panAfterStop = pan();
  const movedAfterStop = Math.abs(panAfterStop - panBeforeStop);
  console.log(`t=${at()}s  pan=${panAfterStop.toFixed(2)}°  moved ${movedAfterStop.toFixed(2)}° since stop  moving=${last.moving}`);

  // Now stop pumping and let the firmware's 750ms joystick deadman act.
  clearInterval(pump);
  const panAtSilence = pan();
  console.log(`t=${at()}s  stopped sending jog frames (deadman should fire in ~750ms)`);
  await sleep(1500);
  const panAfterDeadman = pan();
  console.log(`t=${at()}s  pan=${panAfterDeadman.toFixed(2)}°  moved ${Math.abs(panAfterDeadman - panAtSilence).toFixed(2)}° since silence  moving=${last.moving}`);

  // Judge the deadman against what 750ms at THIS rate actually predicts -- not a
  // fixed distance. At deflection 50 the rig runs ~2.02 °/s, so a correctly
  // working 750ms deadman still travels ~1.5° before it even starts decelerating.
  // A fixed "< 0.35°" threshold calls that a failure, which is how this script
  // first mis-scored a deadman that was behaving exactly as designed.
  const rate = deflection >= 6 ? 19.0 * Math.pow((Math.abs(deflection) - 5) / 95, 3) : 0;
  const deadmanPredictedDeg = rate * 0.75;
  const dm = Math.abs(panAfterDeadman - panAtSilence);

  console.log(`\n--- verdict ---`);
  if (movedAfterStop < 0.15) {
    console.log(`/api/stop HALTED the jog (moved ${movedAfterStop.toFixed(2)}° after stop, while frames still flowing).`);
  } else {
    console.log(`/api/stop did NOT halt the jog: it kept moving ${movedAfterStop.toFixed(2)}° while frames flowed.`);
    console.log(`  => updateMotorVelocities2() does not consume hardStopRequested.`);
  }
  console.log(`deadman: moved ${dm.toFixed(2)}° after frames ceased; a correct 750ms deadman at`);
  console.log(`  ${rate.toFixed(2)} °/s predicts ~${deadmanPredictedDeg.toFixed(2)}° + decel. Final moving=${last.moving}.`);
  console.log(`  => deadman ${last.moving === 0 && dm < deadmanPredictedDeg * 2.5 ? "OK" : "SUSPECT — investigate"}.`);
  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));
  await sleep(200);
  ws.close();
  process.exit(0);
});
