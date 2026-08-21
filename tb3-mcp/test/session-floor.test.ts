import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { DISABLED_SECTOR, TrackSector } from "../src/track/sector.js";
import { TrackFloor, DISABLED_FLOOR } from "../src/track/floor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same harness as test/session-sector.test.ts -- the floor is that gate's
// sibling, so it is observed the same way rather than through a new rig.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

// A target due south at distM, at the height that puts it near elDeg above the
// horizon. Flat-earth plus a curvature nudge; the tests below only ever place
// targets far from the floor (tens of degrees), so the approximation cannot
// flip which side of the gate a target lands on.
function elevationTarget(elDeg: number, distM = 10000): typeof RIG {
  const drop = (distM * distM) / (2 * 6_371_000);
  const height = distM * Math.tan((elDeg * Math.PI) / 180) + drop;
  const dLat = -distM / 111320;   // due south
  return { lat: RIG.lat + dLat, lon: RIG.lon, height };
}

function manualScheduler(): Scheduler & { fire(): void } {
  let fn: (() => void) | null = null;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; } }; },
    fire() { fn?.(); },
  };
}

class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  jogVec: { x: number; y: number; aux: number } | null = null;
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
  clearJog() { this.jogVec = null; }
  async gotoAngle(pan: number, tilt: number) {
    this.gotos.push({ pan, tilt });
    return new Promise<void>(() => {});   // never settles; goto resolution is out of scope
  }
  async waitForArrival() { return this.getState(); }
  async stop() { this.stopCalls++; }
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

const session = (floor: TrackFloor, sector: TrackSector = DISABLED_SECTOR): TrackingSession =>
  new TrackingSession(
    dev as never, cfg, store, () => clockMs, sched,
    () => sector, () => ({}), () => ({ panDeg: 0, tiltDeg: 0 }), () => floor,
  );

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-floor-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("initial-acquire elevation floor", () => {
  // The whole point: beginAcquire() dispatches the first goto synchronously
  // inside start(). If only tick() gated elevation, start_tracking on a
  // low target would command one slew straight down into a neighbour's
  // window before the tick gate caught up. It must never leave.
  it("refuses to dispatch the initial goto toward a below-floor target", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(3), [0, 0, 0], null)).toBeNull();

    expect(dev.gotos.length).toBe(0);
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_min_elevation");
    expect(dev.jogVec).toBeNull();
  });

  it("dispatches normally for a target above the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();

    expect(dev.gotos.length).toBe(1);
    expect(s.status().reason).not.toBe("below_min_elevation");
  });

  // A disabled floor must behave exactly as before the feature existed --
  // including for a target below the horizon, which is what the taught tilt
  // limit (not this gate) is there to catch.
  it("admits a below-horizon target when the floor is disabled", () => {
    const s = session(DISABLED_FLOOR);

    expect(s.start(elevationTarget(-5), [0, 0, 0], null)).toBeNull();

    expect(s.status().reason).not.toBe("below_min_elevation");
  });
});

describe("in-track elevation floor", () => {
  it("holds with reason 'below_min_elevation' when a tracked target descends below the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");

    s.updateTarget(elevationTarget(3), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_min_elevation");
    expect(dev.jogVec).toBeNull();
  });

  it("releases the hold when the target climbs back above the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");

    s.updateTarget(elevationTarget(3), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().reason).toBe("below_min_elevation");

    s.updateTarget(elevationTarget(40), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().reason).not.toBe("below_min_elevation");
  });

  // Read fresh every tick, like sectorProvider and limitsProvider: raising the
  // floor mid-pass must take effect on the next tick, not need a restart.
  it("picks up a floor change mid-pass without a restart", () => {
    let floor: TrackFloor = DISABLED_FLOOR;
    const s = new TrackingSession(
      dev as never, cfg, store, () => clockMs, sched,
      () => DISABLED_SECTOR, () => ({}), () => ({ panDeg: 0, tiltDeg: 0 }), () => floor,
    );

    expect(s.start(elevationTarget(10), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");
    sched.fire();
    expect(s.status().reason).not.toBe("below_min_elevation");

    floor = { enabled: true, minElevationDeg: 25 };
    s.updateTarget(elevationTarget(10), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().reason).toBe("below_min_elevation");
  });
});
