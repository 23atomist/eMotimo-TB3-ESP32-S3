import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
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

// Optionally freeze the DEVICE clock too. The supervisor compares its injected
// `now` against the device's telemetry timestamp (lastUpdateMs, stamped with the
// Device's own `now`). A test that freezes only the supervisor's `now` at a sun
// fixture would see a huge telemetry age and wrongly fault. Freeze both to the
// same instant and the age is ~0.
async function harness(coneDeg = 25, fixedNowMs?: number) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = { ...loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` }), sunConeDeg: coneDeg };
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
});
