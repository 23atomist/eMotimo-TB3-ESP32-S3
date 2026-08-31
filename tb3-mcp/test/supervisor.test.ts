import { describe, it, expect, afterEach, vi } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { sunAzEl, sunEnu } from "../src/geo/sun.js";
import { boresightEnu } from "../src/track/control.js";
import { angleBetweenDeg } from "../src/geo/vec3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8802;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

// A manual scheduler: tests fire ticks explicitly, no wall clock.
function manualScheduler(): { sched: Scheduler; fire: () => void } {
  let fn: (() => void) | null = null;
  return { sched: { every: (_ms, f) => { fn = f; return { cancel() { fn = null; } }; } }, fire: () => fn?.() };
}

// Identity R so pan==azimuth, tilt==elevation. Calibrate the store to a known rig.
function calibratedStore(): CalibrationStore {
  const dir = mkdtempSync(join(tmpdir(), "tb3-sun-"));
  const store = new CalibrationStore(join(dir, "cal.json"));
  store.load();
  store.setRigLocation(33.4484, -112.074, 0);
  store.addSighting({ lat: 33.5, lon: -112.074, height: 0, panDeg: 0, tiltDeg: 0 });
  store.addSighting({ lat: 33.4484, lon: -112.0, height: 1000, panDeg: 90, tiltDeg: 45 });
  store.setOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], new Date(0).toISOString());
  return store;
}

// A set_north_zero seed: rig location + an orientation, but NOT a solved
// calibration (isCalibrated() excludes a provisional orientation on purpose
// -- see calibration.ts). This is exactly the state the drift-calibration
// workflow tracks aircraft in, BEFORE solve_calibration ever runs.
function provisionalStore(): CalibrationStore {
  const dir = mkdtempSync(join(tmpdir(), "tb3-sun-prov-"));
  const store = new CalibrationStore(join(dir, "cal.json"));
  store.load();
  store.setRigLocation(33.4484, -112.074, 0);
  store.setProvisionalOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], new Date(0).toISOString());
  return store;
}

// Optionally freeze the DEVICE clock too. The supervisor compares its injected
// `now` against the device's telemetry timestamp (lastUpdateMs, stamped with the
// Device's own `now`). A test that freezes only the supervisor's `now` at a sun
// fixture would see a huge telemetry age and wrongly fault. Freeze both to the
// same instant and the age is ~0.
async function harness(coneDeg = 25, fixedNowMs?: number) {
  mock = new MockTb3(); await mock.start(PORT);
  // sunGuardEnabled is explicit, not inherited: the config default is `false` (the rig's
  // current site has no direct sun), and these cases exercise the guard itself.
  const cfg = { ...loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` }), sunConeDeg: coneDeg, sunGuardEnabled: true };
  dev = new Device(cfg, fixedNowMs !== undefined ? () => fixedNowMs : undefined); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  return { cfg, store: calibratedStore() };
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });

describe("SunSupervisor", () => {
  it("is disabled when uncalibrated", async () => {
    const { cfg } = await harness();
    const empty = new CalibrationStore("/tmp/tb3-none-DOES-NOT-EXIST.json"); empty.load();
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, empty);
    const sup = new SunSupervisor(dev!, cfg, empty, session, () => 1_000_000, sched);
    sup.start(); sup.tickForTest();
    const s = sup.status();
    expect(s.state).toBe("disabled");
    expect(s.reason).toBe("uncalibrated");
    expect(sup.isSunLocked()).toBe(false);
  });

  it("faults and locks on stale telemetry — and does NOT move", async () => {
    const { cfg, store } = await harness();
    const { sched } = manualScheduler();
    // now() far ahead of the device's lastUpdateMs → telemetry looks stale.
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => Date.now() + 10_000, sched);
    sup.start(); sup.tickForTest();
    const s = sup.status();
    expect(s.state).toBe("fault");
    expect(sup.isSunLocked()).toBe(true);
    expect(mock!.lastGoto).toBeNull(); // never parked on unknown position
  });

  it("fault is sticky: a later tick does not silently clear it or move", async () => {
    const { cfg, store } = await harness();
    const { sched } = manualScheduler();
    // First tick faults on stale telemetry (now far ahead of the device stamp).
    let nowMs = Date.now() + 10_000;
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start(); sup.tickForTest();
    expect(sup.status().state).toBe("fault");
    // "Telemetry recovers": align now with a fresh device stamp so it is no longer
    // stale. Without the sticky-fault guard the next tick would fall through and
    // leave fault (to monitoring or sun_below_horizon); with it, fault persists.
    nowMs = dev!.getState().lastUpdateMs + 100;
    sup.tickForTest();
    expect(sup.status().state).toBe("fault");
    expect(mock!.lastGoto).toBeNull();
    // Only a human clears it.
    sup.clearLock();
    expect(sup.status().state).toBe("monitoring");
  });

  it("flies a direct park and reaches 'parked' ONLY after the waypoint arrives", async () => {
    // Phoenix solar noon: sun high (~77.6° el, ~175° az). Boresight aimed at the
    // sun → trips → a high sun means a direct tilt-down park (one waypoint).
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start();
    sup.tickForTest(); // trip → parking, issues the park goto (fire-and-forget)
    expect(sup.status().state).toBe("parking");
    await new Promise((r) => setTimeout(r, 100)); // let the park goto's fetch reach the mock
    expect(mock!.lastGoto).not.toBeNull();
    // Waypoint has NOT arrived (still at tilt 77) → must stay parking, not parked.
    sup.tickForTest();
    expect(sup.status().state).toBe("parking");
    // Make the goto arrive: move the rig to the park target.
    mock!.setPosition(175 * 444.444, -20 * 444.444);
    await new Promise((r) => setTimeout(r, 400)); // waitForArrival resolves + .then runs
    sup.tickForTest(); // parkStep advanced on arrival → parked
    expect(sup.status().state).toBe("parked");
    expect(sup.isSunLocked()).toBe(true);
  });

  it("locks out manual motion once tripped, and re-drives after clearLock", async () => {
    // Phoenix solar-noon fixture. Freeze BOTH clocks to it (harness freezes the
    // device) so telemetry age ≈ 0 while the sun sits at the fixture position.
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    // Aim the boresight AT the sun (identity R → pan=az≈175°, tilt=el≈77.6°).
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start(); sup.tickForTest();
    expect(sup.isSunLocked()).toBe(true);
    expect(["parking", "parked", "fault"]).toContain(sup.status().state);
    sup.clearLock();
    expect(sup.isSunLocked()).toBe(false);
  });

  // SAFETY REGRESSION: the drift-calibration workflow (characterize_imu ->
  // set_north_zero -> track an aircraft -> nudge -> sight_aircraft) tracks
  // and slews the rig BEFORE a real solve_calibration exists. If the sun
  // guard only armed on isCalibrated() (which deliberately excludes a
  // provisional orientation, see calibration.ts), the guard would sit
  // permanently disabled("uncalibrated") for the ENTIRE provisional-tracking
  // window -- real-time sun protection off exactly when the rig is being
  // slewed manually/via ADS-B the most. Pins that a provisional-only store
  // arms the guard (reaches the sun-elevation check), not just a fully
  // solved one.
  it("arms with only a PROVISIONAL (set_north_zero) orientation — sun protection is not silently off during drift calibration", async () => {
    const nowMs = Date.UTC(2026, 6, 17, 19, 30); // same Phoenix solar-noon fixture as the park tests
    const { cfg } = await harness(25, nowMs);
    // Let at least one telemetry tick land (matches every other test in this
    // file that pairs harness() with a real-time wait) -- otherwise
    // lastUpdateMs is still 0 and the guard faults on telemetry_stale before
    // ever reaching the calibration check this test is about.
    await new Promise((r) => setTimeout(r, 200));
    const store = provisionalStore();
    expect(store.isCalibrated()).toBe(false); // confirm it's genuinely provisional-only
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start();
    sup.tickForTest();
    const s = sup.status();
    // Rig at its default pan/tilt (0,0 -- north, level) is nowhere near the
    // sun (az~175, el~77 at this fixture) -> monitoring, not disabled at all.
    expect(s.state).toBe("monitoring");
    expect(s.reason).not.toBe("uncalibrated");
  });

  it("set_home invalidates R, dropping the guard to disabled(uncalibrated)", async () => {
    const { store } = await harness();
    expect(store.isCalibrated()).toBe(true);
    store.invalidateCalibration();
    expect(store.isCalibrated()).toBe(false);
    expect(store.get().rig).toBeDefined(); // rig location preserved
  });

  // C-1 suspenders: start_tracking/update_target are gated by isSunLocked() at
  // the tool layer (the belt), but a session that becomes active anyway — e.g.
  // a call that raced the trip — must not be left running. The supervisor
  // itself must re-stop it every tick while locked, because the goto reacquire
  // path (session.ts) is NOT covered by the jog latch (setJogVector only).
  it("suspenders: a locked tick stops an active tracking session even though it was never gated", async () => {
    // Trip the guard exactly as "locks out manual motion once tripped" does.
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start(); sup.tickForTest(); // trip -> parking/parked/fault, locked=true
    expect(sup.isSunLocked()).toBe(true);

    // Simulate a session that started despite the lock (the belt failing, or a
    // race between the tool's check and the trip). Bypasses the tool gate on
    // purpose — this test is for the supervisor's own suspenders, not the tool.
    const err = session.start({ lat: 33.5, lon: -112.074, height: 0 }, null, "race");
    expect(err).toBeNull();
    expect(session.isActive()).toBe(true);

    // The very next tick must stop it. Pre-fix (no suspenders line in tick())
    // this assertion fails: the session stays active.
    sup.tickForTest();
    expect(session.isActive()).toBe(false);
    session.stop();
  });

  it("escalates a persistently-rejected park to fault after PARK_MAX_RETRIES, commanding no successful motion", async () => {
    // Same trip fixture as the direct-park test (high sun -> single-waypoint
    // tilt-down park), but force every /api/goto to 409 so the waypoint can
    // never land — deterministic rejection, no timing games.
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    mock!.setProgramEngaged(true); // tb3_goto_safe() is now permanently false
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start();
    sup.tickForTest(); // trip -> parking, issues (and will reject) waypoint 1
    expect(sup.status().state).toBe("parking");

    // Drive ticks until the retry count escalates to fault, or give up after a
    // generous bound (each rejected fetch to localhost resolves in a few ms;
    // 20ms between ticks gives it ample room to settle before the next one).
    let i = 0;
    while (sup.status().state === "parking" && i < 150) {
      await new Promise((r) => setTimeout(r, 20));
      sup.tickForTest();
      i++;
    }

    expect(sup.status().state).toBe("fault");
    expect(sup.status().reason).toBe("park_unreachable");
    expect(sup.isSunLocked()).toBe(true);
    // Every /api/goto was rejected before the mock ever recorded one — the
    // waypoint never actually landed, i.e. no successful motion was commanded.
    expect(mock!.lastGoto).toBeNull();

    // Sticky: further ticks command no more motion either.
    await new Promise((r) => setTimeout(r, 20));
    sup.tickForTest();
    expect(sup.status().state).toBe("fault");
    expect(mock!.lastGoto).toBeNull();
  });
});

// The sun park points DOWN at -20 to get the lens off the sun; the idle park
// points UP (idleParkTiltDeg, default 45) to get it off the neighbours. They
// share SunSupervisor's park machinery but must never share a posture, and
// the sun always wins.
describe("idle park", () => {
  const RIG = { lat: 33.4484, lon: -112.074, height: 0 };
  // A nighttime fixture (sun far below the horizon at RIG) for tests that are
  // not themselves ABOUT sun geometry -- keeps them deterministic regardless
  // of real wall-clock time, since a bare tilt-up sweep from a north-pointing
  // pan (the mock's default position) is trivially sun-safe at night.
  const NIGHT_MS = Date.UTC(2026, 0, 1, 8, 0);

  it("parks up at idleParkTiltDeg when the agent has nothing to track", async () => {
    const { cfg, store } = await harness(25, NIGHT_MS);
    await new Promise((r) => setTimeout(r, 200)); // let at least one telemetry tick land
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => NIGHT_MS, sched);
    const r = await sup.parkIdle();
    expect(r).toEqual({ parked: true, reason: "parked" });
    expect(mock!.lastGoto?.tilt_deg).toBeCloseTo(cfg.idleParkTiltDeg, 1);
  });

  // C3: deleting the guard line in parkIdle() must fail THIS test. Ticking
  // only to "parking" and calling parkIdle() while the sun park's own goto is
  // still in flight is not a real test of the guard -- gotoCount is
  // unchanged in that window purely because the mock 409s a goto while the
  // motors are moving (busy), regardless of whether parkIdle's own lock check
  // ever ran. Drive the sun park all the way to "parked" first so the rig is
  // idle and only the guard itself can be what stops parkIdle from moving it.
  it("refuses to idle-park while sun-locked, leaving the sun park in force", async () => {
    // Phoenix solar-noon fixture (sun high, ~175°az/~77°el): boresight aimed
    // AT the sun -> tick() trips for real, no fake lock.
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start(); sup.tickForTest(); // trip -> parking, issues the sun park's own goto
    expect(sup.isSunLocked()).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // let the park goto's fetch reach the mock
    // Drive it to arrival, exactly like "flies a direct park" above.
    mock!.setPosition(175 * 444.444, -20 * 444.444);
    await new Promise((r) => setTimeout(r, 400));
    sup.tickForTest();
    expect(sup.status().state).toBe("parked"); // idle, not mid-flight -- the real test condition

    const before = mock!.gotoCount;
    const r = await sup.parkIdle();
    expect(r).toEqual({ parked: false, reason: "sun_locked" });
    // No additional goto from parkIdle, and the sun park's own outcome holds.
    expect(mock!.gotoCount).toBe(before);
    expect(sup.status().state).toBe("parked");
  });

  it("refuses to idle-park while a tracking session is active", async () => {
    const { cfg, store } = await harness(25, NIGHT_MS);
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => NIGHT_MS, sched);
    const err = session.start({ lat: 33.5, lon: -112.074, height: 0 }, null, "test");
    expect(err).toBeNull();
    expect(session.isActive()).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // let the acquire goto's fetch settle
    const before = mock!.gotoCount;
    const r = await sup.parkIdle();
    expect(r).toEqual({ parked: false, reason: "tracking_active" });
    expect(mock!.gotoCount).toBe(before);
    session.stop();
  });

  it("does not re-issue a park it has already completed (dwell derived from telemetry)", async () => {
    const { cfg, store } = await harness(25, NIGHT_MS);
    await new Promise((r) => setTimeout(r, 200)); // let at least one telemetry tick land
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => NIGHT_MS, sched);
    const first = await sup.parkIdle();
    expect(first.parked).toBe(true);
    const gotoCountAfterFirst = mock!.gotoCount;
    const second = await sup.parkIdle();
    expect(second).toEqual({ parked: false, reason: "already_parked" });
    expect(mock!.gotoCount).toBe(gotoCountAfterFirst);
  });

  // C1 regression: idleParked used to be a boolean only ever cleared inside
  // parkIdle()'s OWN session-active branch -- a branch no production caller
  // reaches, since loop.ts calls parkIdle() only when NOTHING is tracked.
  // Reproduced in the field: park -> +45 works; run one tracking pass; call
  // parkIdle() again -> no goto at all, rig left wherever the pass ended.
  // The fix derives the dwell from live telemetry instead, so it has no flag
  // left un-cleared by a track ending (or a jog, goto_angle, point_at, home,
  // or a sighting -- anything that moves the rig without going through
  // parkIdle() itself).
  it("re-parks after a tracking pass moves the rig off the idle pose", async () => {
    const { cfg, store } = await harness(25, NIGHT_MS);
    await new Promise((r) => setTimeout(r, 200)); // let at least one telemetry tick land
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => NIGHT_MS, sched);

    const first = await sup.parkIdle();
    expect(first.parked).toBe(true);
    expect(mock!.lastGoto?.tilt_deg).toBeCloseTo(cfg.idleParkTiltDeg, 1);

    // A tracking pass moves the rig away from the idle pose (a ~level target
    // due north of RIG -- far from idleParkTiltDeg's 45°).
    const err = session.start({ lat: 33.5, lon: -112.074, height: 0 }, null, "test");
    expect(err).toBeNull();
    await new Promise((r) => setTimeout(r, 600)); // let the acquire goto actually land
    session.stop();
    await new Promise((r) => setTimeout(r, 50));

    // Confirm the premise: the rig genuinely left the idle tilt (otherwise
    // this test would pass for the wrong reason).
    const midTiltDeg = dev!.getState().tiltSteps / 444.444;
    expect(Math.abs(midTiltDeg - cfg.idleParkTiltDeg)).toBeGreaterThan(1);

    // Pre-fix: idleParked was still `true` from the very first call and
    // nothing on this path ever cleared it -- parkIdle would silently no-op
    // here, leaving the rig at midTiltDeg (the field symptom). Post-fix, the
    // telemetry-derived dwell sees the mismatch and re-parks for real.
    const before = mock!.gotoCount;
    const second = await sup.parkIdle();
    expect(second.parked).toBe(true);
    expect(mock!.gotoCount).toBeGreaterThan(before);
    expect(mock!.lastGoto?.tilt_deg).toBeCloseTo(cfg.idleParkTiltDeg, 1);
  });

  // C2 regression: parkIdle() used to command a bare tilt sweep with no path
  // or destination sun check. Mirrors the reviewer's field repro almost
  // exactly (rig pan 92.9°/tilt 0°, sun az 92.92°/el 45.08°, ending 0.079°
  // from the sun): mid-morning at RIG, the sun sits close to due-east, just
  // above idleParkTiltDeg's target elevation -- a bare tilt-up sweep at the
  // SAME pan as the sun's azimuth would end a couple of degrees short of
  // sitting right on it. Separation at the STARTING pose is outside the cone
  // (tick() does not trip -- exactly the state that let the pre-fix bug
  // through unnoticed), so only the path validation inside parkIdle() itself
  // can catch this.
  it("never drives the boresight near the sun -- routes the idle park through the same path validation the sun park uses", async () => {
    const nowMs = Date.UTC(2026, 6, 17, 16, 30); // ~09:30 local Phoenix time
    const { cfg, store } = await harness(25, nowMs);
    const sunAz = sunAzEl(RIG, nowMs).azDeg;
    const { sched } = manualScheduler();
    mock!.setPosition(sunAz * 444.444, 0); // pan aimed at the sun's azimuth, level
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);

    // Confirm the precondition the field repro describes: the CURRENT pose is
    // outside the cone, so the sun guard itself does not trip or lock.
    sup.tickForTest();
    expect(sup.isSunLocked()).toBe(false);

    const r = await sup.parkIdle();
    expect(r.parked).toBe(true); // a validated detour exists, so it still parks

    // The actual regression check: wherever it ended up, it must not be
    // anywhere near the sun.
    const R = store.getOrientation()!;
    const sEnu = sunEnu(RIG, nowMs);
    const final = dev!.getState();
    const finalPanDeg = final.panSteps / 444.444;
    const finalTiltDeg = final.tiltSteps / 444.444;
    const sepDeg = angleBetweenDeg(boresightEnu(R, finalPanDeg, finalTiltDeg, [0, 1, 0], 1), sEnu);
    expect(sepDeg).toBeGreaterThanOrEqual(cfg.sunConeDeg);
    // And it actually reached the idle tilt via the detour, not a
    // half-executed plan.
    expect(finalTiltDeg).toBeCloseTo(cfg.idleParkTiltDeg, 0);
  });

  // Round-2 review finding: the waypoint loop awaited each leg to completion
  // without re-checking locked/session.isActive()/programEngaged in between,
  // so a multi-second multi-leg detour (like the pan-detour above) could fly
  // its remaining legs on top of a since-started sun park -- desyncing the
  // guard's state model (it believes "parked" at parkTiltDeg while the rig
  // is actually mid-flight to idleParkTiltDeg; tick() returns early for the
  // entire "parked" state, so it never notices). Reuses the exact pan-detour
  // fixture above (guaranteed 2 waypoints) and interrupts between leg 1 and
  // leg 2 with a REAL tracking session start -- the honest way to flip
  // session.isActive() true mid-flight, no test-only seam needed.
  it("aborts mid-flight if an abort condition changes between legs, and never flies the remaining waypoints", async () => {
    const nowMs = Date.UTC(2026, 6, 17, 16, 30);
    const { cfg, store } = await harness(25, nowMs);
    const sunAz = sunAzEl(RIG, nowMs).azDeg;
    mock!.setPosition(sunAz * 444.444, 0);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs);

    const parkPromise = sup.parkIdle();

    // Wait for leg 1's goto to actually be ACCEPTED by the mock -- confirms
    // both that a real multi-leg plan was chosen and that we are genuinely
    // interrupting mid-flight, not racing parkIdle's own entry checks.
    const t0 = Date.now();
    while (mock!.gotoCount < 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(mock!.gotoCount).toBe(1);

    // A real tracking session starting mid-flight (bypasses the tool-layer
    // gate on purpose, same as the "suspenders" test above -- this test is
    // for parkIdle's own mid-flight guard, not the tool gate).
    const err = session.start({ lat: 33.5, lon: -112.074, height: 0 }, null, "race");
    expect(err).toBeNull();
    expect(session.isActive()).toBe(true);

    const r = await parkPromise;
    expect(r).toEqual({ parked: false, reason: "aborted_mid_flight: tracking_active" });
    // Leg 2 (the tilt-up leg) must NEVER have been issued.
    expect(mock!.gotoCount).toBe(1);
    const finalTiltDeg = dev!.getState().tiltSteps / 444.444;
    expect(finalTiltDeg).not.toBeCloseTo(cfg.idleParkTiltDeg, 0);

    session.stop();
  });

  // I2: parkIdle() must fail closed on stale telemetry exactly like tick()
  // does -- an unknown pose must never be moved from.
  it("refuses to idle-park on stale telemetry, leaving the rig where it is", async () => {
    const { cfg, store } = await harness();
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    // now() far ahead of the device's actual lastUpdateMs -> telemetry reads
    // stale, the same condition tick() itself refuses to move from.
    const sup = new SunSupervisor(dev!, cfg, store, session, () => Date.now() + 10_000, sched);
    const r = await sup.parkIdle();
    expect(r).toEqual({ parked: false, reason: "telemetry_stale" });
    expect(mock!.lastGoto).toBeNull();
  });

  // I4: a rejected idle-park goto must be visible (logged), not silently
  // swallowed, and must be reported back rather than claimed as a success.
  it("reports (does not silently swallow) a rejected idle-park goto", async () => {
    const { cfg, store } = await harness(25, NIGHT_MS);
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => NIGHT_MS, sched);
    // Force a 409 the same way an idle park racing stop()'s ~450ms
    // deceleration would in the field: motors still moving, NOT E-STOP/
    // program-engaged (that has its own distinct guard/reason, "estop").
    dev!.setJogVector(50, 0, 0, 500);
    await new Promise((r) => setTimeout(r, 100)); // let the mock start moving
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await sup.parkIdle();
      expect(r.parked).toBe(false);
      expect(r.reason).toMatch(/^goto_failed:/);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      dev!.clearJog();
    }
  });
});
