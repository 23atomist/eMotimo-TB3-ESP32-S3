import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { STEPS_PER_DEG } from "../src/angles.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level: pan 0 / tilt ~0 under identity R.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

// A hand-driven scheduler: tests call fire() instead of waiting.
function manualScheduler(): Scheduler & { fire(): void; cancelled(): boolean } {
  let fn: (() => void) | null = null;
  let cancelledFlag = false;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; cancelledFlag = true; } }; },
    fire() { fn?.(); },
    cancelled() { return cancelledFlag; },
  };
}

interface Deferred {
  resolve: () => void;
  reject: (err: Error) => void;
}

class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  jogVec: { x: number; y: number; aux: number } | null = null;
  cleared = 0;
  gotos: { pan: number; tilt: number }[] = [];
  // Each gotoAngle() call parks a deferred here instead of resolving
  // immediately, so tests can drive the goto's settlement (and its timing
  // relative to gate trips / re-start()) by hand.
  gotoDeferreds: Deferred[] = [];
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
    return new Promise<void>((resolve, reject) => {
      this.gotoDeferreds.push({ resolve, reject });
    });
  }
  async waitForArrival() { return this.getState(); }
  async stop() { this.stopCalls++; }
}

// Drains the microtask queue (and any already-due macrotasks) so a resolved
// gotoDeferred's continuation -- moveToUserAngle's remaining awaits, then
// beginAcquire's .then()/.catch() -- has actually run before assertions.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

function newSession(): TrackingSession {
  return new TrackingSession(dev as never, cfg, store, () => clockMs, sched);
}

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sess-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("TrackingSession lifecycle", () => {
  it("starts stopped", () => {
    expect(newSession().status().state).toBe("stopped");
  });

  it("refuses to start without a calibration", () => {
    store.clear();
    const s = newSession();
    expect(s.start(NORTH, null, null)).toMatch(/calibrat/i);
    expect(s.status().state).toBe("stopped");
  });

  it("start enters acquiring and issues a goto", () => {
    const s = newSession();
    expect(s.start(NORTH, null, null)).toBeNull();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(1);
    expect(dev.gotos[0].pan).toBeCloseTo(0, 1);
  });

  it("stop clears the jog vector and cancels the tick", () => {
    const s = newSession();
    s.start(NORTH, null, null);
    s.stop();
    expect(s.status().state).toBe("stopped");
    expect(dev.cleared).toBeGreaterThan(0);
    expect(sched.cancelled()).toBe(true);
  });
});

describe("TrackingSession safety gates", () => {
  // Put the session in `tracking` with a stationary target due north.
  // Signature is start(target, statedVelocity, label).
  function tracking(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    return s;
  }

  it("commands a jog vector while tracking", () => {
    const s = tracking();
    dev.panSteps = 5 * STEPS_PER_DEG;   // 5 deg of error
    sched.fire();
    expect(dev.jogVec).not.toBeNull();
    expect(dev.jogVec!.x).toBeLessThan(0);   // drive back toward pan 0
  });

  it("stops and waits on stale telemetry", () => {
    const s = tracking();
    dev.lastUpdateMs = clockMs - (cfg.trackStaleTelemetryMs + 1);
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("telemetry_stale");
    expect(dev.jogVec).toBeNull();
  });

  it("stops and waits on a stale target fix", () => {
    const s = tracking();
    clockMs += cfg.trackMaxTargetAgeMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("target_stale");
    expect(dev.jogVec).toBeNull();
  });

  it("yields when a built-in program is engaged", () => {
    const s = tracking();
    dev.programEngaged = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("program_engaged");
    expect(dev.jogVec).toBeNull();
  });

  it("waits when the target is below the tilt limit", () => {
    // A target 10km north but 5km BELOW the rig sits at elevation ~ -26deg,
    // outside a tiltMin of -5.
    const tightCfg = { ...cfg, tiltMin: -5 };
    const s = new TrackingSession(dev as never, tightCfg, store, () => clockMs, sched);
    s.start({ lat: 45 + 10 / 111.32, lon: 10, height: -5000 }, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_tilt_limit");
    expect(dev.jogVec).toBeNull();
  });

  it("the deadman ends the session outright", () => {
    const s = tracking();
    clockMs += cfg.trackDeadmanMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("stopped");
    expect(dev.cleared).toBeGreaterThan(0);
  });

  it("auto-reacquires when a waiting target becomes reachable again", () => {
    const s = tracking();
    dev.programEngaged = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");

    dev.programEngaged = false;
    dev.lastUpdateMs = clockMs;
    s.updateTarget(NORTH, null);   // refresh the fix
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });

  it("drops back to acquiring when the pointing error is large", () => {
    const s = tracking();
    dev.panSteps = 90 * STEPS_PER_DEG;    // 90 deg off target
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
    expect(dev.jogVec).toBeNull();
  });

  it("reports pointing error in status", () => {
    const s = tracking();
    dev.panSteps = 3 * STEPS_PER_DEG;
    sched.fire();
    expect(s.status().pointingErrorDeg).toBeCloseTo(3, 0);
  });
});

describe("TrackingSession goto cancellation (generation stamp)", () => {
  it("promotes to tracking when the in-flight goto genuinely resolves", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotoDeferreds.length).toBe(1);

    dev.gotoDeferreds[0].resolve();
    await flush();

    expect(s.status().state).toBe("tracking");
  });

  it("ignores a stale goto's late resolution once a re-start() has superseded it", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(dev.gotoDeferreds.length).toBe(1);
    const stale = dev.gotoDeferreds[0];

    // A second start() arrives while the first goto is still in flight. It
    // must cancel the stale attempt (device.stop(), generation bump) and
    // issue a fresh one rather than let two gotos race on the firmware.
    s.start(NORTH, null, null);
    expect(dev.stopCalls).toBe(1);
    expect(dev.gotoDeferreds.length).toBe(2);
    expect(s.status().state).toBe("acquiring");

    stale.resolve();
    await flush();

    // The stale resolution belongs to a superseded generation: it must not
    // have promoted the session (the fresh goto is still unresolved).
    expect(s.status().state).toBe("acquiring");
  });

  it("cancels the in-flight goto (device.stop() exactly once) when a gate trips during acquire", () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");
    expect(dev.stopCalls).toBe(0);

    dev.programEngaged = true;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("program_engaged");
    expect(dev.stopCalls).toBe(1);
  });

  it("does not call device.stop() on a gate trip once genuinely tracking (no goto in flight)", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].resolve();
    await flush();
    expect(s.status().state).toBe("tracking");

    dev.programEngaged = true;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(dev.stopCalls).toBe(0);
  });
});
