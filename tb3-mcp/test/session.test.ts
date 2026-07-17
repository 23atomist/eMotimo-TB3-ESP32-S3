import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { DeviceHttpError } from "../src/device.js";
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

// A point ~distM from the rig at compass bearing bearingDeg (flat-earth
// approx, same one NORTH above already relies on -- fine at this range).
// Under identity R, pan == azimuth, so this gives direct control over the
// target's pan angle without hand-solving geodesy.
function bearingTarget(bearingDeg: number, distM = 10000): typeof RIG {
  const brg = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(brg)) / 111320;
  const dLon = (distM * Math.sin(brg)) / (111320 * Math.cos((RIG.lat * Math.PI) / 180));
  return { lat: RIG.lat + dLat, lon: RIG.lon + dLon, height: 0 };
}

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
  // Set to make the arrival wait fail, which is where a real goto TIMEOUT comes
  // from. It matters that this is separate from a gotoAngle rejection:
  // moveToUserAngle only wraps the latter, so the two arrive at the session's
  // .catch() in genuinely different shapes.
  arrivalError: Error | null = null;
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
  async waitForArrival() {
    if (this.arrivalError) throw this.arrivalError;
    return this.getState();
  }
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

// The rig's goto endpoint is gated on tb3_goto_safe() == !Program_Engaged &&
// motorMoving == 0, and updateMotorVelocities2() sets motorMoving for a JOG
// just as it does for a goto. So a rig that is tracking is, by definition,
// "moving" -- and every reacquire is issued from exactly that state.
describe("TrackingSession reacquire vs. the rig's deceleration", () => {
  function trackingWithError(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    dev.panSteps = 90 * STEPS_PER_DEG;   // 90 deg off: well past trackReacquireDeg
    return s;
  }

  it("waits for the rig to stop instead of POSTing a goto that can only 409", () => {
    const s = trackingWithError();
    dev.moving = true;                   // still decelerating out of the jog
    const before = dev.gotos.length;

    sched.fire();

    // No doomed POST, and the rate is dropped so the rig can actually stop.
    expect(dev.gotos.length).toBe(before);
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("device_busy");
    expect(dev.jogVec).toBeNull();
  });

  it("acquires as soon as the rig has come to rest", () => {
    const s = trackingWithError();
    dev.moving = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");

    dev.moving = false;                  // decel complete
    const before = dev.gotos.length;
    sched.fire();

    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });

  // The bug: a 409 is routine and self-healing, but it was reported as
  // "telemetry_stale" -- blaming a perfectly healthy subsystem, on the most
  // common catch-up path there is. Covers the .catch() branch's gotoInFlight
  // clearing too, which previously had no test at all.
  it("REGRESSION: a 409 from the rig reports device_busy, not telemetry_stale", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");

    // Exactly what Device.gotoAngle throws when the firmware refuses because
    // motorMoving is still set. moveToUserAngle re-wraps this for the operator
    // ("device rejected goto: ...") but carries it through as `cause`, which is
    // the only reason the session can still tell a 409 from a real fault.
    dev.gotoDeferreds[0].reject(new DeviceHttpError("busy - motors still moving", 409));
    await flush();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("device_busy");
    // Telemetry is perfectly healthy here; saying otherwise sends the operator
    // hunting a network fault that does not exist.
    expect(s.status().reason).not.toBe("telemetry_stale");
    expect(s.status().telemetryAgeMs).toBe(0);
  });

  it("a goto that times out reports goto_failed, still not telemetry_stale", async () => {
    const s = newSession();
    s.start(NORTH, null, null);

    // A real timeout surfaces from waitForArrival, not from the POST: the rig
    // accepted the goto and then never arrived. Distinct cause, distinct reason.
    dev.arrivalError = new Error("goto timed out after 5000ms at pan=1.00° tilt=0.00°");
    dev.gotoDeferreds[0].resolve();
    await flush();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("goto_failed");
    expect(s.status().reason).not.toBe("telemetry_stale");
  });

  it("recovers on the next tick after a 409 (the churn is bounded, not a wedge)", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].reject(new DeviceHttpError("busy - motors still moving", 409));
    await flush();
    expect(s.status().reason).toBe("device_busy");

    // Rig has now stopped: the waiting session must retry rather than sit there.
    dev.moving = false;
    s.updateTarget(NORTH, null);
    const before = dev.gotos.length;
    sched.fire();

    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });
});

// limitGuard() (src/track/control.ts) already zeroes a blocked axis and
// returns panBlocked/tiltBlocked -- the session discarded both, so a held
// axis looked identical to "the servo is happy": state stays "tracking",
// reason stays null, only commanded_*_dps quietly drops to zero. With the
// horizon rework this fires more often, and it can self-perpetuate: an
// aggressive trackKp (>= ~2.0) near a legal-but-close-to-limit target
// produces a commanded rate whose predicted stopping point overshoots the
// limit, the guard zeroes it, the rig never moves, and the frozen error
// reproduces the exact same block next tick, forever.
describe("TrackingSession limit guard visibility", () => {
  it("REGRESSION: a guard-blocked axis is surfaced in status(), not discarded", () => {
    // Target at pan ~179deg (legal -- inside the default [-180,180] range).
    // Rig sits at pan 170, 9deg of legal room short of the limit. trackKp=2.0
    // turns that into a ~18deg/s commanded rate; with 200ms of telemetry lag
    // (realistic 5Hz) the guard's horizon predicts overshooting panMax, so it
    // must zero pan -- verified against control.ts's own model before writing
    // this (raw.panDps ~= 17.99, guard.panBlocked === true).
    const aggressiveCfg = { ...cfg, trackKp: 2.0 };
    const s = new TrackingSession(dev as never, aggressiveCfg, store, () => clockMs, sched);
    s.start(bearingTarget(179), [0, 0, 0], null);
    s.forceStateForTest("tracking");
    dev.panSteps = 170 * STEPS_PER_DEG;
    dev.lastUpdateMs = clockMs - 200;   // realistic 5Hz telemetry lag, not stale

    sched.fire();

    // Not an error, not a wait reason -- exactly the silent-looking state the
    // operator cannot currently tell apart from a converging servo.
    expect(s.status().state).toBe("tracking");
    expect(s.status().reason).toBeNull();
    expect(s.status().commandedPanDps).toBe(0);
    expect(s.status().panLimited).toBe(true);
    // The tilt axis is nowhere near its limit and must not be swept in.
    expect(s.status().tiltLimited).toBe(false);
  });

  it("panLimited/tiltLimited reset once motion stops", () => {
    const aggressiveCfg = { ...cfg, trackKp: 2.0 };
    const s = new TrackingSession(dev as never, aggressiveCfg, store, () => clockMs, sched);
    s.start(bearingTarget(179), [0, 0, 0], null);
    s.forceStateForTest("tracking");
    dev.panSteps = 170 * STEPS_PER_DEG;
    dev.lastUpdateMs = clockMs - 200;
    sched.fire();
    expect(s.status().panLimited).toBe(true);

    s.stop();

    expect(s.status().panLimited).toBe(false);
    expect(s.status().tiltLimited).toBe(false);
  });
});
