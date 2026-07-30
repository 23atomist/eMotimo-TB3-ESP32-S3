import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { STEPS_PER_DEG } from "../src/angles.js";
import { MAX_OFFSET_DEG } from "../src/track/offset.js";
import { reachablePanTilt } from "../src/geo-tools.js";
import { targetAimAt, controlRate } from "../src/track/control.js";
import { emptyEstimator, withFix } from "../src/track/estimator.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same fixtures as test/session.test.ts (kept local/small rather than shared,
// so this file stands alone): identity R -> pan==azimuth, tilt==elevation.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level: pan 0 / tilt ~0 under identity R.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

function manualScheduler(): Scheduler & { fire(): void } {
  let fn: (() => void) | null = null;
  return { every(_ms, f) { fn = f; return { cancel() { fn = null; } }; }, fire() { fn?.(); } };
}

class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  jogVec: { x: number; y: number; aux: number } | null = null;
  cleared = 0;
  gotos: { pan: number; tilt: number }[] = [];
  gotoDeferreds: { resolve: () => void; reject: (e: Error) => void }[] = [];
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
    return new Promise<void>((resolve, reject) => { this.gotoDeferreds.push({ resolve, reject }); });
  }
  async waitForArrival() { return this.getState(); }
  async stop() {}
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

function newSession(overrideCfg: Partial<Config> = {}): TrackingSession {
  return new TrackingSession(dev as never, { ...cfg, ...overrideCfg }, store, () => clockMs, sched);
}

// Put the session in `tracking`, stationary target due north, rig at pan=0/tilt=0
// (i.e. zero pointing error before any offset is applied).
function tracking(overrideCfg: Partial<Config> = {}): TrackingSession {
  const s = newSession(overrideCfg);
  s.start(NORTH, [0, 0, 0], null);
  s.forceStateForTest("tracking");
  return s;
}

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-offs-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

// Independently recomputes the commanded rate the PRE-offset formula would
// produce: targetAimAt -> controlRate, with NO applyOffset/reachablePanTilt
// shift anywhere in the chain -- the literal computation session.tick() used
// to do (see git history around track/session.ts before this feature). This
// is the reference "today's behavior" the offset feature must reduce to
// exactly at offset=(0,0), and must equal baseline + kp*offset otherwise --
// NOT a hardcoded 0, since a due-north target's tilt (and even pan, via
// floating residue put through the firmware's cubic rateToDeflection curve)
// is only ever "close to" zero, never exactly zero. See NORTH's own comment.
function baselineRates(rigPanDeg = 0, rigTiltDeg = 0) {
  const est = withFix(emptyEstimator(), RIG, NORTH, clockMs, [0, 0, 0]);
  const aim = targetAimAt(est, I, clockMs + cfg.trackLeadMs, [0, 1, 0], cfg.geoPanSign, {
    panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
  })!;
  return controlRate(aim, rigPanDeg, rigTiltDeg, cfg.trackKp, cfg.maxJogDps);
}

describe("TrackingSession aim-offset — applied to the setpoint", () => {
  it("zero offset is IDENTICAL to today's behavior (strict extension, pinned)", () => {
    const s = tracking();
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    sched.fire();
    const base = baselineRates();
    expect(s.status().commandedPanDps).toBeCloseTo(base.panDps, 9);
    expect(s.status().commandedTiltDps).toBeCloseTo(base.tiltDps, 9);
  });

  it("a positive pan offset shifts the setpoint, producing a commanded rate kp*offset ABOVE the zero-offset baseline", () => {
    const base = baselineRates();
    const s = tracking();
    s.nudgeOffset(3, 0);
    expect(s.getOffset().panDeg).toBeCloseTo(3, 9);
    sched.fire();
    // errPan = (targetPan + offsetPanDeg) - rigPan, so the offset adds
    // exactly kp*3 on top of whatever the unshifted baseline already was.
    expect(s.status().commandedPanDps).toBeCloseTo(base.panDps + cfg.trackKp * 3, 6);
    expect(s.status().commandedPanDps!).toBeGreaterThan(base.panDps);
  });

  it("a negative tilt offset shifts the setpoint, producing a commanded rate kp*offset BELOW the zero-offset baseline", () => {
    const base = baselineRates();
    const s = tracking();
    s.nudgeOffset(0, -2);
    sched.fire();
    expect(s.status().commandedTiltDps).toBeCloseTo(base.tiltDps + cfg.trackKp * -2, 6);
    expect(s.status().commandedTiltDps!).toBeLessThan(base.tiltDps);
  });

  it("magnitude scales with the offset (not just direction)", () => {
    const s1 = tracking();
    s1.nudgeOffset(1, 0);
    sched.fire();
    const small = s1.status().commandedPanDps!;

    // Fresh session, same setup, bigger offset.
    dev = new FakeDevice(); dev.lastUpdateMs = clockMs;
    const s2 = tracking();
    s2.nudgeOffset(MAX_OFFSET_DEG, 0);
    sched.fire();
    const big = s2.status().commandedPanDps!;

    expect(big).toBeGreaterThan(small);
  });

  it("the offset is reported in get status separately from the (unshifted) target angle", () => {
    const s = tracking();
    s.nudgeOffset(1.5, -0.25);
    sched.fire();
    expect(s.status().offsetPanDeg).toBeCloseTo(1.5, 9);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-0.25, 9);
    // targetPanDeg/targetTiltDeg stay the TRUE geometric target (~0,~0 here),
    // not the offset-shifted one -- the offset is a separate, visible number.
    expect(s.status().targetPanDeg).toBeCloseTo(0, 0);
  });
});

describe("TrackingSession aim-offset — clamped, never an unbounded slew", () => {
  it("nudgeOffset clamps at MAX_OFFSET_DEG through the session, same as the pure helper", () => {
    const s = tracking();
    const result = s.nudgeOffset(500, -500);
    expect(result.panDeg).toBe(MAX_OFFSET_DEG);
    expect(result.tiltDeg).toBe(-MAX_OFFSET_DEG);
    // getOffset() returns the bare AimOffset; nudgeOffset() additionally
    // reports the clamp flags, so compare the two fields they share.
    expect(s.getOffset()).toEqual({ panDeg: result.panDeg, tiltDeg: result.tiltDeg });
    expect(result.panClamped).toBe(true);   // it DID ask to go further
    expect(result.tiltClamped).toBe(true);
  });

  it("an absurd nudge does not produce an absurd commanded rate — bounded by the SAME clamp a legitimate offset uses", () => {
    const base = baselineRates();
    const s = tracking();
    s.nudgeOffset(500, 0); // clamps to MAX_OFFSET_DEG internally
    sched.fire();
    // Bounded to baseline + kp*MAX_OFFSET_DEG -- nowhere near what an
    // unclamped 500° offset would have demanded (kp*500 == 500 dps at kp=1).
    expect(s.status().commandedPanDps).toBeCloseTo(base.panDps + cfg.trackKp * MAX_OFFSET_DEG, 6);
    expect(s.status().commandedPanDps!).toBeLessThan(50);
  });
});

describe("TrackingSession aim-offset — resets on a new track", () => {
  it("start() zeroes a standing offset from a previous pass", () => {
    const s = tracking();
    s.nudgeOffset(3, -1);
    expect(s.getOffset()).toEqual({ panDeg: 3, tiltDeg: -1 });

    s.start(NORTH, [0, 0, 0], null); // a fresh track (e.g. a new aircraft)
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("clear_aim_offset's underlying method resets explicitly, independent of start()", () => {
    const s = tracking();
    s.nudgeOffset(2, 2);
    s.clearOffset();
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });
});

describe("TrackingSession aim-offset — safety: cannot bypass pan/tilt limits", () => {
  it("an offset that pushes the setpoint outside the tilt limit is refused, exactly like an unshifted target would be", () => {
    // tiltMax tight enough that the true target (tilt ~0) is IN range, but
    // target + a 5° offset is OUT of range.
    const s = tracking({ tiltMax: 4 });
    s.nudgeOffset(0, MAX_OFFSET_DEG); // true tilt ~0 + 5 = ~5, past tiltMax=4
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_tilt_limit");
    expect(dev.jogVec).toBeNull();
  });

  it("REGRESSION: the offset genuinely changes the reachability verdict — the unshifted target passes the SAME gate the shifted one fails", () => {
    // Demonstrates the bug this guards against is real, not a tautology:
    // reachablePanTilt (the exact gate session.tick() calls) accepts the true
    // target but rejects target+offset under the same tiltMax=4 limits.
    const limits = { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: 4 };
    const unshifted = reachablePanTilt(0, 0, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    const shifted = reachablePanTilt(0, MAX_OFFSET_DEG, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    expect("error" in unshifted).toBe(false);
    expect("error" in shifted).toBe(true);

    // And the live session (which shifts before checking) lands on the
    // shifted (rejected) branch, not the unshifted (accepted) one.
    const s = tracking({ tiltMax: 4 });
    s.nudgeOffset(0, MAX_OFFSET_DEG);
    sched.fire();
    expect(s.status().state).toBe("waiting");
  });

  it("a reacquire's goto still includes the standing offset — the correction does not disappear across an acquire cycle", () => {
    const s = tracking();
    s.nudgeOffset(2, 0); // a small, legal correction
    // Force a reacquire via a large TRUE pointing error (unrelated to the
    // offset): rig physically far from where it should be.
    dev.panSteps = 90 * STEPS_PER_DEG;
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
    // The dispatched goto targets true-pan(0) + offset(2) = ~2, not bare 0.
    expect(dev.gotos[dev.gotos.length - 1].pan).toBeCloseTo(2, 0);
  });
});

describe("TrackingSession aim-offset — safety: E-STOP/stop() still halts motion regardless of offset", () => {
  it("stop() clears jog + cancels the tick even with a large standing offset", () => {
    const s = tracking();
    s.nudgeOffset(MAX_OFFSET_DEG, MAX_OFFSET_DEG);
    sched.fire();
    expect(dev.jogVec).not.toBeNull();

    s.stop(); // what stop_tracking (and the dashboard's E-STOP fan-out) calls

    expect(s.status().state).toBe("stopped");
    expect(dev.cleared).toBeGreaterThan(0);
    expect(dev.jogVec).toBeNull();
  });
});
