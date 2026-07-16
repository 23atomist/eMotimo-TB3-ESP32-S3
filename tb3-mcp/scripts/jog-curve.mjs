// Characterize the TB3's jog deflection -> deg/s curve on real hardware.
//
// Why: the firmware does NOT map joystick deflection to rate linearly.
// TB3_Nunchuck.ino:axis_button_deadzone() subtracts a deadband, then
// updateMotorVelocities2() applies a CUBIC curve:
//
//     joy_db  = |x| - 5                       (deadband, and <6 snaps to 0)
//     joy_eff = joy_db^3 / 10000              (the "exponential curve")
//     rate   ~= joy_eff * const
//
// Layer 1's jog tool assumes a LINEAR deflection->dps mapping, which layer 3's
// control law inherited. If the real curve is cubic, the servo's feedforward
// is wrong everywhere except 0 and full scale. This script measures the truth.
//
// Usage (from tb3-mcp/):  node scripts/jog-curve.mjs <RIG_IP> [holdSeconds]
//
// PUT THE RIG ON A JOG-CAPABLE SCREEN FIRST ("Move to Start Pt." inside a
// 2 Point Move -- the menu itself routes the joystick to menu nav, not motion).
// RUN WITH THE CAMERA REMOVED. Each deflection is jogged + and then -, so the
// rig returns near its starting pan and does not walk away.

import WebSocket from "ws";

const STEPS_PER_DEG = 444.444;
const DEFLECTIONS = [25, 50, 75, 100];
const host = process.argv[2];
const hold = Number(process.argv[3] ?? 2.5);

if (!host) {
  console.error("usage: node scripts/jog-curve.mjs <RIG_IP> [holdSeconds=2.5]");
  process.exit(1);
}

const ws = new WebSocket(`ws://${host}/ws`);
let last = null;
const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };

setTimeout(() => fail("no websocket connection after 8s"), 8000).unref();
ws.on("error", (e) => fail(`websocket error: ${e.message}`));
ws.on("message", (b) => {
  let d; try { d = JSON.parse(b.toString()); } catch { return; }
  if (d.type === "tick" && Array.isArray(d.pos)) last = d;
});

// The firmware's own curve, for comparison.
function modelEff(x) {
  const db = Math.abs(x) - 5;
  if (Math.abs(x) < 6) return 0;
  return (db * db * db) / 10000;
}

async function measure(deflection) {
  // settle
  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));
  await sleep(600);
  const startSteps = last.pos[0];
  const t0 = Date.now();

  const timer = setInterval(() => ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 })), 100);
  ws.send(JSON.stringify({ x: deflection, y: 0, aux: 0 }));
  await sleep(hold * 1000);
  clearInterval(timer);
  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));
  await sleep(500);

  const elapsed = (Date.now() - t0 - 500) / 1000;
  const deg = (last.pos[0] - startSteps) / STEPS_PER_DEG;
  return { dps: deg / elapsed, deg };
}

ws.on("open", async () => {
  await waitFor(() => last !== null, 5000, "no telemetry");
  console.log(`LCD: ${JSON.stringify(last.lcd)}`);
  console.log(`>>> This MUST be a jog-capable screen ("Move to Start Pt"), not a menu.\n`);
  console.log(`sweeping deflections ${DEFLECTIONS.join(", ")} — each + then -, ${hold}s per leg\n`);

  const rows = [];
  for (const d of DEFLECTIONS) {
    const fwd = await measure(d);
    const rev = await measure(-d);
    // Average magnitude of the two directions; cancels any standing bias.
    const dps = (Math.abs(fwd.dps) + Math.abs(rev.dps)) / 2;
    rows.push({ d, dps, fwd: fwd.dps, rev: rev.dps });
    console.log(`  x=${String(d).padStart(3)}  ->  ${dps.toFixed(2)} °/s   (+${fwd.dps.toFixed(2)} / ${rev.dps.toFixed(2)})`);
  }

  ws.send(JSON.stringify({ x: 0, y: 0, aux: 0 }));

  // Fit: is rate proportional to the cubic model, or to deflection?
  const ref = rows[rows.length - 1];          // full deflection
  console.log(`\n--- curve check (normalised to x=${ref.d}) ---`);
  console.log(`  x     measured    cubic-model   linear-model`);
  for (const r of rows) {
    const meas = r.dps / ref.dps;
    const cubic = modelEff(r.d) / modelEff(ref.d);
    const linear = r.d / ref.d;
    console.log(
      `  ${String(r.d).padStart(3)}   ${meas.toFixed(3)}        ${cubic.toFixed(3)}         ${linear.toFixed(3)}`,
    );
  }

  const cubicErr = rows.reduce((a, r) => a + Math.abs(r.dps / ref.dps - modelEff(r.d) / modelEff(ref.d)), 0);
  const linearErr = rows.reduce((a, r) => a + Math.abs(r.dps / ref.dps - r.d / ref.d), 0);
  console.log(`\n  total abs error:  cubic=${cubicErr.toFixed(3)}   linear=${linearErr.toFixed(3)}`);
  console.log(cubicErr < linearErr
    ? `  => CUBIC fits. Layer 3 must invert the cubic; the linear jog mapping is wrong.`
    : `  => LINEAR fits better than expected — re-examine updateMotorVelocities2.`);

  console.log(`\n  MAX JOG RATE (full deflection): ${ref.dps.toFixed(2)} °/s`);
  console.log(`  -> this is the real ceiling for tracking; set TB3_MAX_JOG_DPS from it.`);

  ws.close();
  process.exit(0);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(c, t, m) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (c()) return; await sleep(50); }
  fail(m);
}
