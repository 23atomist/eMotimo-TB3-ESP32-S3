import { Device } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { TrackingSession, Scheduler, realScheduler } from "./session.js";
import { sunEnu, sunAzEl } from "../geo/sun.js";
import { checkSun, planPark, ParkPlan } from "./sunguard.js";
import { boresightEnu, limitHorizonMs } from "./control.js";
import { Vec3 } from "../geo/vec3.js";
import { moveToUserAngle } from "../move.js";
import { stepsToDeg, applySign } from "../angles.js";

export type SunState = "disabled" | "monitoring" | "parking" | "parked" | "fault";

export interface SunStatus {
  readonly state: SunState;
  readonly reason: string | null;
  readonly enabled: boolean;
  readonly coneDeg: number;
  readonly parkTiltDeg: number;
  readonly sunAzDeg: number | null;
  readonly sunElDeg: number | null;
  readonly separationDeg: number | null;
  readonly locked: boolean;
}

interface Boresight { readonly panDeg: number; readonly tiltDeg: number; readonly enu: Vec3 }

// A park goto rejected this many ticks running (~5s at 10Hz) escalates to a
// fault+alarm rather than retrying forever in silence.
const PARK_MAX_RETRIES = 50;

export class SunSupervisor {
  private state: SunState = "disabled";
  private reason: string | null = "uncalibrated";
  private locked = false;
  private enabled: boolean;
  private coneDeg: number;
  private parkTiltDeg: number;
  private timer: { cancel(): void } | null = null;
  private parkInFlight = false;
  private parkPlan: ParkPlan | null = null;
  private parkStep = 0; // index of the next waypoint to fly
  private parkGen = 0;  // epoch; a superseded park's late promise can't mutate state
  private parkRetries = 0;
  private prev: { pan: number; tilt: number; tMs: number } | null = null;
  private lastSun: { az: number | null; el: number | null; sep: number | null } = { az: null, el: null, sep: null };

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly session: TrackingSession,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
  ) {
    this.enabled = cfg.sunGuardEnabled;
    this.coneDeg = cfg.sunConeDeg;
    this.parkTiltDeg = cfg.parkTiltDeg;
  }

  start(): void {
    if (this.timer) return;
    const ms = Math.max(20, Math.round(1000 / this.cfg.sunGuardTickHz));
    this.timer = this.scheduler.every(ms, () => this.safeTick());
  }
  stop(): void { this.timer?.cancel(); this.timer = null; }

  isSunLocked(): boolean { return this.locked; }

  // Mirrors the supervisor's lock flag onto the device's jog latch: engaging
  // the lock must stop an in-flight manual jog from re-arming after
  // device.clearJog() runs (see device.ts lockJog), not just prevent new jogs
  // from starting via isSunLocked(). Every place this.locked is assigned goes
  // through here so the two can never drift apart.
  private setLocked(v: boolean): void {
    this.locked = v;
    if (v) this.device.lockJog(); else this.device.unlockJog();
  }

  clearLock(): void {
    this.setLocked(false);
    // Leaving parked/fault/parking all go back to monitoring; abortPark halts any
    // park goto still in flight so releasing the lock can't let another tool
    // command motion that fights the supervisor's own outstanding move.
    if (this.state === "parked" || this.state === "fault" || this.state === "parking") {
      this.abortPark();
      this.state = "monitoring";
    }
  }

  setConfig(p: { enabled?: boolean; coneDeg?: number; parkTiltDeg?: number }): void {
    if (p.enabled !== undefined) this.enabled = p.enabled;
    if (p.coneDeg !== undefined) this.coneDeg = p.coneDeg;
    if (p.parkTiltDeg !== undefined) this.parkTiltDeg = p.parkTiltDeg;
  }

  status(): SunStatus {
    return {
      state: this.state, reason: this.reason, enabled: this.enabled,
      coneDeg: this.coneDeg, parkTiltDeg: this.parkTiltDeg,
      sunAzDeg: this.lastSun.az, sunElDeg: this.lastSun.el,
      separationDeg: this.lastSun.sep, locked: this.locked,
    };
  }

  tickForTest(): void { this.tick(); }

  private safeTick(): void {
    // A throw must never leave motion running. Stop and lock; never guess a move.
    try { this.tick(); }
    catch { this.enterFault("internal_error"); }
  }

  private disable(reason: string): void {
    this.state = "disabled"; this.reason = reason; this.setLocked(false);
    this.abortPark(); this.prev = null;
  }

  private enterFault(reason: string): void {
    this.state = "fault"; this.reason = reason; this.setLocked(true);
    this.session.stop(); this.device.clearJog();
    this.abortPark();
  }

  // Abandon any in-flight park: halt the outstanding goto and bump the epoch so
  // its late resolution can neither advance parkStep nor declare "parked" on a
  // park cycle that no longer exists. Same orphaned-promise guard as
  // TrackingSession.cancelGoto. device.stop() fires only when a goto is actually
  // outstanding, so calling this every idle tick is cheap.
  private abortPark(): void {
    if (this.parkInFlight) void this.device.stop().catch(() => {});
    this.parkGen++;
    this.parkPlan = null; this.parkStep = 0; this.parkRetries = 0; this.parkInFlight = false;
  }

  private currentBoresight(): Boresight | null {
    // The attitude seam: the one place attitude is read. A future IMU source
    // would provide or correct this, without touching guard logic.
    const R = this.store.getOrientation();
    if (!R) return null;
    const d = this.device.getState();
    const panDeg = applySign(stepsToDeg(d.panSteps), this.cfg.panSign);
    const tiltDeg = applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign);
    return { panDeg, tiltDeg, enu: boresightEnu(R, panDeg, tiltDeg) };
  }

  private tick(): void {
    const nowMs = this.now();

    // Fault is terminal until a human clears it (clearLock). It must NOT silently
    // re-evaluate and resume autonomous motion when the triggering condition lifts
    // — a flaky telemetry link would otherwise bounce fault→park→fault with no
    // durable, operator-visible alarm.
    if (this.state === "fault") return;

    if (!this.enabled) { this.lastSun = { az: null, el: null, sep: null }; this.disable("manually_disabled"); return; }
    const p = this.store.get();
    if (!p.rig || !this.store.isCalibrated()) { this.lastSun = { az: null, el: null, sep: null }; this.disable("uncalibrated"); return; }

    // Fail-closed: a stale reading means we don't know where the boresight is.
    // Stop and lock, but never compute a park from an unknown position.
    const d = this.device.getState();
    const telAge = d.lastUpdateMs === 0 ? Infinity : nowMs - d.lastUpdateMs;
    if (!(telAge <= this.cfg.trackStaleTelemetryMs)) { this.enterFault("telemetry_stale"); return; }

    const { azDeg, elDeg } = sunAzEl(p.rig, nowMs);
    if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg)) { this.enterFault("sun_calc_failed"); return; }
    if (elDeg <= 0) { this.lastSun = { az: azDeg, el: elDeg, sep: null }; this.disable("sun_below_horizon"); return; }

    const sEnu = sunEnu(p.rig, nowMs);
    const bore = this.currentBoresight();
    if (!bore) { this.lastSun = { az: null, el: null, sep: null }; this.disable("uncalibrated"); return; }

    // Observed angular rate of the boresight, per axis, from consecutive samples.
    let ratePan = 0, rateTilt = 0;
    if (this.prev && nowMs > this.prev.tMs) {
      const dt = (nowMs - this.prev.tMs) / 1000;
      ratePan = (bore.panDeg - this.prev.pan) / dt;
      rateTilt = (bore.tiltDeg - this.prev.tilt) / dt;
    }
    this.prev = { pan: bore.panDeg, tilt: bore.tiltDeg, tMs: nowMs };

    const rate = Math.max(Math.abs(ratePan), Math.abs(rateTilt));
    const horizon = limitHorizonMs(rate, telAge, 1000 / this.cfg.sunGuardTickHz, this.cfg.maxJogDps);
    const chk = checkSun(this.store.getOrientation()!, bore.panDeg, bore.tiltDeg, ratePan, rateTilt, horizon, sEnu, this.coneDeg);
    this.lastSun = { az: azDeg, el: elDeg, sep: Number(chk.separationDeg.toFixed(3)) };

    // Stay parked and locked until a human clears the lock (clearLock moves us
    // back to monitoring; if the sun is still in the cone the next tick re-trips).
    if (this.state === "parked") return;

    if (this.state === "parking") { this.driveParkTick(bore); return; }

    // monitoring / recover: trip on a predicted approach.
    if (chk.tripped) {
      this.session.stop(); this.device.clearJog();
      this.setLocked(true);
      const plan = planPark(this.store.getOrientation()!, bore.panDeg, bore.tiltDeg, sEnu, this.coneDeg, this.parkTiltDeg,
        { panMin: this.cfg.panMin, panMax: this.cfg.panMax, tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax });
      if (plan.kind === "no-safe-path") { this.enterFault("no_safe_park_path"); return; }
      this.parkPlan = plan; this.parkStep = 0; this.parkRetries = 0;
      this.state = "parking"; this.reason = "sun_in_cone";
      this.driveParkTick(bore);
      return;
    }

    this.state = "monitoring"; this.reason = null; this.setLocked(false);
  }

  // Fly the park plan's waypoints IN ORDER, one single-axis goto at a time, so
  // the flown path is exactly the L-path planPark verified (a single combined
  // goto to the last point would cut a diagonal that was never checked). Each
  // moveToUserAngle resolves on arrival; advance the step then. Async, so kick
  // off one waypoint per tick and retry the same step if a goto is rejected
  // (e.g. a transient 409 while the rig decelerates out of a jog).
  private driveParkTick(_bore: Boresight): void {
    const plan = this.parkPlan;
    if (!plan || plan.waypoints.length === 0) { this.state = "monitoring"; return; }
    if (this.parkStep >= plan.waypoints.length) {
      // Every waypoint issued AND arrived (parkStep advances only on arrival).
      this.state = "parked"; this.reason = "sun_in_cone"; this.parkInFlight = false;
      return;
    }
    if (this.parkInFlight) return;
    const wp = plan.waypoints[this.parkStep];
    const gen = this.parkGen;
    this.parkInFlight = true;
    void moveToUserAngle(this.device, this.cfg, wp.panDeg, wp.tiltDeg)
      .then(() => {
        if (gen !== this.parkGen) return;              // superseded park — ignore
        this.parkStep++; this.parkRetries = 0; this.parkInFlight = false;
      })
      .catch(() => {
        if (gen !== this.parkGen) return;              // superseded park — ignore
        this.parkInFlight = false;
        // Retry the same waypoint next tick; give up (fault+alarm) if it never lands.
        if (++this.parkRetries >= PARK_MAX_RETRIES) this.enterFault("park_unreachable");
      });
  }
}
