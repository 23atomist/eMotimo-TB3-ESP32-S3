import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3, mockJogRate, MOCK_JOG_MAX_DPS } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { Mat3 } from "../src/geo/vec3.js";
import { rateToDeflection } from "../src/track/control.js";

// Ports 8791-8799 are already taken by other test files. Do not reuse them.
const PORT = 8800;
// Identity R: the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. Keeps the expectations hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);

let mock: MockTb3; let device: Device; let session: TrackingSession;

afterEach(async () => {
  session?.stop();
  device?.close();
  await mock?.stop();
});

// The cheapest possible guard against the mock's model and the control law's
// model drifting apart: rateToDeflection (src/track/control.ts) is supposed
// to be the exact inverse of the mock's deadband+cubic curve. If either one's
// deadband/span/plateau ever changes without the other, this goes red before
// the (much slower, much fuzzier) closed-loop simulation would even notice.
describe("mock jog model matches the control law's inverse", () => {
  it("round-trips rateToDeflection -> mockJogRate back to the original rate", () => {
    for (const dps of [0.5, 1, 3, 7, 12, 19, -0.5, -5, -19]) {
      const deflection = rateToDeflection(dps, MOCK_JOG_MAX_DPS);
      const rate = mockJogRate(deflection, MOCK_JOG_MAX_DPS);
      // rateToDeflection rounds to an integer deflection, so the round trip
      // is not exact -- but it must be close, and critically it must NOT be
      // off by the ~9x a linear-vs-cubic mismatch would produce.
      expect(rate).toBeCloseTo(dps, 0);
    }
  });
});

describe("closed-loop tracking simulation", () => {
  it("holds pointing error bounded while chasing a crossing target", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    // An aircraft 8km north at 2km altitude, flying East at 120 m/s.
    // Over 4s it moves ~480m — a slow azimuth sweep the rig can hold.
    const northM = 8000, upM = 2000, speed = 120;
    const t0 = Date.now();
    const posAt = (tSec: number) => ({
      lat: RIG.lat + northM / M_PER_DEG_LAT,
      lon: RIG.lon + (speed * tSec) / M_PER_DEG_LON,
      height: upM,
    });

    session = new TrackingSession(device, cfg, store);
    expect(session.start(posAt(0), null, "sim")).toBeNull();

    // Feed fixes at 2Hz with a stated velocity (due East).
    const feeder = setInterval(() => {
      const tSec = (Date.now() - t0) / 1000;
      session.updateTarget(posAt(tSec), [speed, 0, 0]);
    }, 500);

    // Let it acquire, then sample the error while tracking.
    await sleep(2500);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const st = session.status();
      if (st.state === "tracking" && st.pointingErrorDeg !== null) samples.push(st.pointingErrorDeg);
    }
    clearInterval(feeder);

    expect(session.status().state).toBe("tracking");
    expect(samples.length).toBeGreaterThan(4);
    const worst = Math.max(...samples);
    // The controller must actually converge — not merely avoid diverging.
    // The brief's own tolerance (3deg) is loose enough that it does NOT go
    // red under either of the two failure modes this test exists to catch
    // (verified empirically, 3 runs each): a zeroed feedforward term settles
    // at ~0.82-0.87deg of steady-state lag, and a linear (rather than cubic)
    // mock jog curve oscillates up to ~1.8deg. The correct implementation
    // settles at ~0.08-0.12deg across 6+ runs. 0.5deg sits with margin above
    // that baseline and below both fault floors, so it actually catches them
    // instead of only proving the loop doesn't diverge.
    expect(worst).toBeLessThan(0.5);
  }, 15000);

  it("stops commanding motion when target updates dry up", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    const cfg = loadConfig(undefined, {
      TB3_DEVICE_HOST: `127.0.0.1:${PORT}`,
      TB3_TRACK_MAX_TARGET_AGE_MS: "400",
    });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim2-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    session = new TrackingSession(device, cfg, store);
    session.start({ lat: RIG.lat + 8000 / M_PER_DEG_LAT, lon: RIG.lon, height: 2000 }, [0, 0, 0], "stale");

    // Never call updateTarget again: the fix goes stale and motion must cease.
    await sleep(1500);
    expect(session.status().state).toBe("waiting");
    expect(session.status().reason).toBe("target_stale");
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  }, 15000);
});
