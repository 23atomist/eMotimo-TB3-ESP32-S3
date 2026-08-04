import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type TrackState } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verifies the fix for Finding 1 (task-11 fix round): the identity passed to
// onStateChange listeners -- and therefore the dedup key CaptureController
// keys a "pass" on -- is the ICAO hex, not the callsign-or-hex label. A
// callsign that arrives late (or changes) between two passes of the SAME
// physical airframe must not look like two different identities.
//
// This is a standalone file (not an addition to session.test.ts /
// tracking-sim.test.ts) because those two files must stay byte-identical
// regression guards for the setState() refactor.

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level -- the exact fixture session.test.ts uses to reach
// "acquiring" (issues a real goto) without hitting any wait() gate.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

// Minimal device double: only what start() -> beginAcquire() -> a
// fire-and-forget moveToUserAngle() touches synchronously. Never resolved --
// these tests only assert on the synchronous setState() notification fired
// before the goto is dispatched, so the goto's outcome is irrelevant here.
class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  getState() {
    return {
      connected: true, panSteps: this.panSteps, tiltSteps: this.tiltSteps, auxSteps: 0,
      moving: this.moving, programEngaged: this.programEngaged, batteryV: 12,
      staIp: "1.2.3.4", lastUpdateMs: this.lastUpdateMs,
    };
  }
  setJogVector() {}
  clearJog() {}
  async gotoAngle() { return new Promise<void>(() => { /* never resolves; unused here */ }); }
  async waitForArrival() { return this.getState(); }
  async stop() {}
}

let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;

function newSession(): TrackingSession {
  return new TrackingSession(dev as never, cfg, store);
}

beforeEach(() => {
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sess-id-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString(), 1);
  dev = new FakeDevice();
});

describe("TrackingSession capture identity", () => {
  it("onStateChange carries the hex, not the label, as the icao", () => {
    const seen: { state: TrackState; icao: string | null }[] = [];
    const s = newSession();
    s.onStateChange((state, icao) => seen.push({ state, icao }));

    s.start(NORTH, [0, 0, 0], "United 123", "ABC123");

    const acquiring = seen.filter((e) => e.state === "acquiring");
    expect(acquiring.length).toBe(1);
    expect(acquiring[0].icao).toBe("ABC123");   // the hex, not "United 123"
  });

  it("dedup identity stays the hex across two passes even when the callsign changes", () => {
    const seen: { state: TrackState; icao: string | null }[] = [];
    const s = newSession();
    s.onStateChange((state, icao) => seen.push({ state, icao }));

    // Pass 1: no callsign known yet (mirrors AdsbFollower's ac.callsign ??
    // ac.hex fallback -- label defaults to the hex itself).
    s.start(NORTH, [0, 0, 0], "ABC123", "ABC123");
    s.stop();

    // Pass 2: the SAME airframe, reacquired, callsign now broadcast.
    s.start(NORTH, [0, 0, 0], "United 123", "ABC123");

    const acquiring = seen.filter((e) => e.state === "acquiring");
    expect(acquiring.length).toBe(2);
    expect(acquiring[0].icao).toBe("ABC123");
    expect(acquiring[1].icao).toBe("ABC123");   // identity unchanged...
    expect(acquiring[0].icao).toBe(acquiring[1].icao);
  });

  it("icao is null when no hex is supplied (manual/non-ADS-B tracking)", () => {
    const seen: { state: TrackState; icao: string | null }[] = [];
    const s = newSession();
    s.onStateChange((state, icao) => seen.push({ state, icao }));

    s.start(NORTH, [0, 0, 0], "manual target");   // 4th arg omitted

    const acquiring = seen.filter((e) => e.state === "acquiring");
    expect(acquiring.length).toBe(1);
    expect(acquiring[0].icao).toBeNull();
  });

  it("currentIcao() reports the hex directly", () => {
    const s = newSession();
    expect(s.currentIcao()).toBeNull();
    s.start(NORTH, [0, 0, 0], "United 123", "ABC123");
    expect(s.currentIcao()).toBe("ABC123");
  });
});
