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
import { TaughtEdges, effectiveLimits } from "../limits-store.js";

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

export interface IdleParkResult {
  // True iff this call actually issued and completed a park move.
  readonly parked: boolean;
  // Why not (or, on success, "parked") -- an LLM/operator caller must be able
  // to tell a real park apart from a silent no-op.
  readonly reason: string;
}

// A park goto rejected this many ticks running (~5s at 10Hz) escalates to a
// fault+alarm rather than retrying forever in silence.
const PARK_MAX_RETRIES = 50;

// How close the current tilt must be to idleParkTiltDeg to count as "already
// parked" for parkIdle()'s dwell check -- see parkIdle() for why this is
// derived from live telemetry rather than a boolean flag.
const IDLE_PARK_DWELL_EPSILON_DEG = 0.5;

export class SunSupervisor {
  private state: SunState = "disabled";
  private reason: string | null = "uncalibrated";
  private locked = false;
  private enabled: boolean;
  private coneDeg: number;
  private parkTiltDeg: number;
  private idleParkTiltDeg: number;
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
    // Operator-taught travel limits (limits-store.ts) — the park path must
    // respect the same effective range as jog/goto_angle/tracking, or a
    // taught limit tighter than parkTiltDeg's config default could still
    // grind the sun-guard's own park move into a hard stop. Defaults to
    // "nothing taught" so every existing caller/test keeps its exact prior
    // (config-ceiling-only) behavior.
    private readonly limitsProvider: () => TaughtEdges = () => ({}),
  ) {
    this.enabled = cfg.sunGuardEnabled;
    this.coneDeg = cfg.sunConeDeg;
    this.parkTiltDeg = cfg.parkTiltDeg;
    this.idleParkTiltDeg = cfg.idleParkTiltDeg;
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
    // Fail-closed: command a hard stop so a fault always commands *something*
    // toward the actuator, not just jog/session bookkeeping. abortPark() below
    // only fires device.stop() when a park goto happens to be in flight (e.g.
    // NOT on the 50th park_unreachable retry, where it just rejected) — this is
    // unconditional. Its efficacy against a RUNNING FIRMWARE PROGRAM (vs. a
    // goto/jog) is hardware-unverified; deferred to the bench.
    void this.device.stop().catch(() => {});
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

  // Camera-offset model, sourced the same way as point_at/point_at_azel: no
  // gravity calibration yet -> forward-only cHead, the no-op default that
  // reduces every offset-aware call below to its legacy mapping.
  private cHead(): Vec3 {
    return this.store.getCHead() ?? [0, 1, 0];
  }

  // The effective (taught-or-config) range — see TrackingSession.limits()'s
  // identical rationale; the park path must not be the one place still
  // reading the config ceiling directly.
  private limits() {
    return effectiveLimits(
      { panMin: this.cfg.panMin, panMax: this.cfg.panMax, tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax },
      this.limitsProvider(),
    );
  }

  private currentBoresight(): Boresight | null {
    // The attitude seam: the one place attitude is read. A future IMU source
    // would provide or correct this, without touching guard logic.
    const R = this.store.getOrientation();
    if (!R) return null;
    const d = this.device.getState();
    const panDeg = applySign(stepsToDeg(d.panSteps), this.cfg.panSign);
    const tiltDeg = applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign);
    return { panDeg, tiltDeg, enu: boresightEnu(R, panDeg, tiltDeg, this.cHead(), this.cfg.geoPanSign) };
  }

  private tick(): void {
    const nowMs = this.now();

    // While locked, no tracking session may be running — a track started after a
    // trip (or racing the tool gate) would slew the rig via gotos the jog latch
    // does not cover. Keep it stopped every tick.
    if (this.locked && this.session.isActive()) this.session.stop();

    // Fault is terminal until a human clears it (clearLock). It must NOT silently
    // re-evaluate and resume autonomous motion when the triggering condition lifts
    // — a flaky telemetry link would otherwise bounce fault→park→fault with no
    // durable, operator-visible alarm.
    if (this.state === "fault") return;

    if (!this.enabled) { this.lastSun = { az: null, el: null, sep: null }; this.disable("manually_disabled"); return; }
    const p = this.store.get();
    // Armed whenever a boresight can be computed at all -- rig location plus
    // ANY orientation, provisional (set_north_zero) or fully solved -- NOT
    // gated on isCalibrated(), which deliberately excludes a provisional
    // orientation. The drift-calibration workflow tracks aircraft BEFORE a
    // real solve exists specifically so the sun guard must already be live
    // during that phase: gating this on isCalibrated() would silently
    // disable real-time sun protection for the entire provisional-tracking
    // window, which is exactly when the rig is being slewed manually/via
    // ADS-B the most. Matches TrackingSession's own gate (rigLocation() +
    // getOrientation(), not isCalibrated()) -- a strict widening, since
    // isCalibrated()==true always implies getOrientation() is set too.
    if (!p.rig || !this.store.getOrientation()) { this.lastSun = { az: null, el: null, sep: null }; this.disable("uncalibrated"); return; }

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
    const chk = checkSun(
      this.store.getOrientation()!, bore.panDeg, bore.tiltDeg, ratePan, rateTilt, horizon, sEnu, this.coneDeg,
      this.cHead(), this.cfg.geoPanSign,
    );
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
        this.limits(), this.cHead(), this.cfg.geoPanSign);
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
    void moveToUserAngle(this.device, this.cfg, wp.panDeg, wp.tiltDeg, undefined, this.limits())
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

  // The three conditions under which parkIdle() must never command motion:
  // E-STOP/any engaged firmware program, the sun park (which always wins),
  // and an active tracking session. Factored out so the SAME check runs both
  // at entry and again on every leg of a multi-waypoint flight (see
  // parkIdle()) -- a pan-detour is several seconds of real motion, and any of
  // these three can become true partway through it.
  private idleParkAbortReason(): "estop" | "sun_locked" | "tracking_active" | null {
    // NOTE: device.getState() returns the last CACHED WebSocket telemetry
    // snapshot, not a live read of the device -- that is exactly why
    // parkIdle()'s own staleness check exists, rather than trusting this
    // snapshot no matter how old it is.
    if (this.device.getState().programEngaged) return "estop";
    // `locked` is true for the entire parking/parked/fault span (set by
    // setLocked at the exact instant tick() commits to a sun park), so this
    // one check covers all three without needing to know the guard's
    // internal state names.
    if (this.locked) return "sun_locked";
    // A tracking session in progress owns the rig -- idle-parking over an
    // active pass would fight TrackingSession's own motion every tick.
    if (this.session.isActive()) return "tracking_active";
    return null;
  }

  /**
   * Point the rig UP between passes so an idle autonomous rig does not rest
   * on the horizon -- which is where the neighbours' windows are.
   *
   * Deliberately NOT inside TrackingSession.stop(): that method sits on the
   * E-STOP and sun-lock paths, and "stop moving" must never become "now
   * execute a slew".
   *
   * OPPOSITE posture from the sun park (parkTiltDeg, default -20, points down
   * and away from the sun) -- idleParkTiltDeg points UP, into the hemisphere
   * the sun occupies. Because of that, "share the machinery, never the
   * posture" has to include the PATH VALIDATION, not just the retry
   * machinery: this routes the move through the exact same planPark/
   * sweepClear the sun park itself uses (src/track/sunguard.ts), so an idle
   * park can never be the thing that puts the boresight on the sun. If no
   * validated path exists, it refuses and leaves the rig where it is --
   * exactly like the sun park's own "no-safe-path" outcome.
   */
  async parkIdle(): Promise<IdleParkResult> {
    const entryAbort = this.idleParkAbortReason();
    if (entryAbort) return { parked: false, reason: entryAbort };

    // Fail-closed exactly like tick()'s own telemetry guard (see the
    // telAge check above): an unknown/stale pose must never be moved from,
    // whether or not the sun guard itself is enabled -- reading the current
    // pose and computing where the sun is does not depend on `enabled`.
    const nowMs = this.now();
    const d = this.device.getState();
    const telAge = d.lastUpdateMs === 0 ? Infinity : nowMs - d.lastUpdateMs;
    if (!(telAge <= this.cfg.trackStaleTelemetryMs)) return { parked: false, reason: "telemetry_stale" };

    // Current pose. `panDeg` is only the SWEEP'S STARTING pan, fed to
    // planPark below as the current position -- it is NOT a promise the rig
    // ends up at this pan. planPark may return a pan-detour, in which case
    // the rig is parked at whatever pan the detour needed, not this one, and
    // stays there indefinitely (the dwell check just below compares TILT
    // ONLY, on purpose -- tilt is what keeps the lens off the neighbours,
    // pan is not, and walking the detour pan back afterwards is not this
    // feature's job). The detour pan was itself sun-path-validated by
    // planPark, so parking there is safe, just worth writing down rather
    // than discovering later.
    const panDeg = applySign(stepsToDeg(d.panSteps), this.cfg.panSign);
    const curTiltDeg = applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign);
    const lim = this.limits();
    const targetTiltDeg = Math.min(lim.tiltMax, Math.max(lim.tiltMin, this.idleParkTiltDeg));

    // Dwell, derived from live telemetry rather than a boolean flag: a flag
    // can only be cleared by parkIdle() itself, so it would wedge permanently
    // after ANY other motion that moved the rig off the idle pose without
    // going through this method -- a manual jog, goto_angle, point_at, home,
    // or a sighting. Comparing the actual tilt to the target on every call
    // has no such blind spot, and also means a rejected goto below is
    // retried for free on the next call rather than needing its own flag.
    if (Math.abs(curTiltDeg - targetTiltDeg) <= IDLE_PARK_DWELL_EPSILON_DEG) {
      return { parked: false, reason: "already_parked" };
    }

    // About to command real motion: validate the path is clear of the sun
    // FIRST, using the same check the sun park itself relies on. Fail
    // closed -- an idle park with no sun position to check against (no rig
    // location, no orientation) or a sun-calc failure refuses rather than
    // guesses a bare move.
    const p = this.store.get();
    const R = this.store.getOrientation();
    if (!p.rig || !R) return { parked: false, reason: "uncalibrated" };
    const { azDeg, elDeg } = sunAzEl(p.rig, nowMs);
    if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg)) return { parked: false, reason: "sun_calc_failed" };
    const sEnu = sunEnu(p.rig, nowMs);
    const plan = planPark(
      R, panDeg, curTiltDeg, sEnu, this.coneDeg, targetTiltDeg, lim, this.cHead(), this.cfg.geoPanSign,
    );
    if (plan.kind === "no-safe-path") return { parked: false, reason: "no_safe_path" };

    try {
      // Fly the validated waypoints in order, exactly as driveParkTick() does
      // for the sun park -- a single combined goto to the last point would
      // cut a diagonal that planPark never checked.
      //
      // A pan-detour is multiple seconds of real motion (each leg is
      // individually awaited to arrival), during which the sun guard's own
      // tick() keeps running on its own timer -- locked/session/programEngaged
      // can all change mid-flight. Re-check before EVERY leg, not just once
      // at entry: flying a later leg on top of a since-started sun park would
      // desync the guard's state model (it believes it commanded a park to
      // parkTiltDeg while the rig is actually mid-flight toward
      // idleParkTiltDeg) with no reconciliation, since tick() returns early
      // for the entire "parked" state. Each already-flown leg was itself
      // sun-path-validated by planPark above, so stopping here never risks
      // the boresight -- only the state-desync this closes.
      for (const wp of plan.waypoints) {
        const midFlightAbort = this.idleParkAbortReason();
        if (midFlightAbort) return { parked: false, reason: `aborted_mid_flight: ${midFlightAbort}` };
        await moveToUserAngle(this.device, this.cfg, wp.panDeg, wp.tiltDeg, undefined, lim);
      }
      return { parked: true, reason: "parked" };
    } catch (e) {
      // Not a fault: nothing time-critical rides on an idle park landing on
      // any one call (unlike the sun park's PARK_MAX_RETRIES escalation).
      // Logged rather than swallowed -- e.g. a park issued immediately after
      // stop() races the rig's ~450ms deceleration and 409s, and that must
      // be visible somewhere. The telemetry-derived dwell above means the
      // NEXT call simply retries; there is no flag left un-set to cause a
      // permanent miss.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[sun-supervisor] idle park goto failed: ${msg}`);
      return { parked: false, reason: `goto_failed: ${msg}` };
    }
  }
}
