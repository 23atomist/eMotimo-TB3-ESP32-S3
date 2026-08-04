import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { TrackSector } from "../src/track/sector.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same harness as test/session.test.ts (fake Device + calibrated
// CalibrationStore + manual Scheduler), reused here rather than
// reimplemented differently -- the point is to observe tick()'s new
// sector check in isolation, not to re-derive the closed-loop model.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

// A point ~distM from the rig at compass bearing bearingDeg (flat-earth
// approx). Under identity R, pan == azimuth, so this gives direct control
// over the target's bearing without hand-solving geodesy.
function bearingTarget(bearingDeg: number, distM = 10000): typeof RIG {
  const brg = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(brg)) / 111320;
  const dLon = (distM * Math.sin(brg)) / (111320 * Math.cos((RIG.lat * Math.PI) / 180));
  return { lat: RIG.lat + dLat, lon: RIG.lon + dLon, height: 0 };
}

function manualScheduler(): Scheduler & { fire(): void; cancelled(): boolean } {
  let fn: (() => void) | null = null;
  let cancelledFlag = false;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; cancelledFlag = true; } }; },
    fire() { fn?.(); },
    cancelled() { return cancelledFlag; },
  };
}

class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  jogVec: { x: number; y: number; aux: number } | null = null;
  cleared = 0;
  gotos: { pan: number; tilt: number }[] = [];
  stopCalls = 0;
  getState() {
    return {
      connected: true, panSteps: this.panSteps, tiltSteps: this.tiltSteps, auxSteps: 0,
      moving: this.moving, programEngaged: this.programEngaged, batteryV: 12,
      staIp: "1.2.3.4", lastUpdateMs: this.lastUpdateMs,
    };
  }
  setJogVector(x: number, y: number, aux: number) { this.jogVec = { x, y, aux }; }
  clearJog() { this.jogVec = null; this.cleared++; }
  async gotoAngle(pan: number, tilt: number) {
    this.gotos.push({ pan, tilt });
    // Never settles -- these tests only exercise the sector gate in tick(),
    // not goto resolution, so there is nothing to drive to completion.
    return new Promise<void>(() => {});
  }
  async waitForArrival() { return this.getState(); }
  async stop() { this.stopCalls++; }
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sect-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString(), 1);
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("initial-acquire azimuth-sector stop", () => {
  // beginAcquire() fires the very first goto SYNCHRONOUSLY inside start(),
  // before any tick ever runs. If only tick() gated the sector, a
  // start_tracking on an out-of-sector bearing would command one slew
  // toward it (e.g. into the house) before the tick gate caught up ~100ms
  // later -- undercutting the whole point of the filter. So beginAcquire()
  // must refuse to dispatch that goto in the first place.
  it("refuses to dispatch the initial goto toward an out-of-sector target", () => {
    // Arc open from 90 to 270 (east, through south, to west) -- excludes due
    // north (bearing 0).
    const arc: TrackSector = { enabled: true, startDeg: 90, endDeg: 270 };
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched, () => arc);

    expect(s.start(bearingTarget(0), [0, 0, 0], null)).toBeNull();

    // Immediately after start() returns -- before any scheduled tick fires
    // -- no goto may have been dispatched, and the session must already be
    // holding with outside_sector rather than sitting in "acquiring".
    expect(dev.gotos.length).toBe(0);
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("outside_sector");
    expect(dev.jogVec).toBeNull();
  });
});

describe("in-track azimuth-sector stop", () => {
  it("holds with reason 'outside_sector' when an already-tracking target's bearing drifts out of the arc", () => {
    // Arc open from 90 to 270 (east, through south, to west) -- excludes due
    // north (bearing 0).
    const arc: TrackSector = { enabled: true, startDeg: 90, endDeg: 270 };
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched, () => arc);

    // Start on a target INSIDE the arc (due south, bearing 180) so the
    // initial acquire is unaffected, then force straight to "tracking" --
    // this isolates tick()'s own gate from beginAcquire()'s.
    expect(s.start(bearingTarget(180), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");

    // The target drifts to due north (bearing 0), outside the arc.
    s.updateTarget(bearingTarget(0), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("outside_sector");
    expect(dev.jogVec).toBeNull();

    // Feed a fix INSIDE the arc again (due south, bearing 180) -- the hold
    // must release: the reason is no longer outside_sector.
    s.updateTarget(bearingTarget(180), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().reason).not.toBe("outside_sector");
  });
});
