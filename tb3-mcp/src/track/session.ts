import { Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { Geodetic } from "../geo/wgs84.js";
import { Device, DeviceHttpError } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { stepsToDeg, applySign } from "../angles.js";
import { moveToUserAngle } from "../move.js";
import { reachablePanTilt } from "../geo-tools.js";
import { EstimatorState, emptyEstimator, withFix, lastFixMs } from "./estimator.js";
import {
  TargetAim, targetAimAt, controlRate, limitGuard, boresightEnu, rateToDeflection, limitHorizonMs,
  GuardLimits,
} from "./control.js";
import { TrackSector, DISABLED_SECTOR, inArc } from "./sector.js";
import { AimOffset, NudgeResult, ZERO_OFFSET, applyOffset, nudgeOffset as nudgeOffsetValue } from "./offset.js";
import { TaughtEdges, effectiveLimits } from "../limits-store.js";
import { TuningStore } from "../tuning-store.js";
import { resolveTuning } from "../tuning-resolve.js";

export type TrackState = "stopped" | "acquiring" | "tracking" | "waiting";
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "program_engaged" | "not_calibrated"
  | "device_busy" | "goto_failed" | "outside_sector";

export interface TrackStatus {
  state: TrackState;
  reason: WaitReason | null;
  label: string | null;
  targetAzimuthDeg: number | null;
  targetElevationDeg: number | null;
  targetRangeM: number | null;
  targetPanDeg: number | null;
  targetTiltDeg: number | null;
  rigPanDeg: number | null;
  rigTiltDeg: number | null;
  pointingErrorDeg: number | null;
  commandedPanDps: number | null;
  commandedTiltDps: number | null;
  panLimited: boolean;
  tiltLimited: boolean;
  targetAgeMs: number | null;
  telemetryAgeMs: number | null;
  // The operator aim-offset applied to the setpoint (see track/offset.ts).
  // This IS the measurement the drift-calibration pass is taking -- shown
  // separately from targetPanDeg/targetTiltDeg (which stay the raw,
  // unshifted geometric target) so the operator watches it converge.
  offsetPanDeg: number;
  offsetTiltDeg: number;
}

export interface Scheduler {
  every(ms: number, fn: () => void): { cancel(): void };
}

export const realScheduler: Scheduler = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    return { cancel() { clearInterval(t); } };
  },
};

/**
 * Why an acquire goto failed. A 409 means tb3_goto_safe() was false -- a
 * program is engaged, or (far more often) the rig is still decelerating out of
 * a jog and motorMoving is still set. It is routine, self-healing, and above
 * all NOT a telemetry fault: reporting it as one blames a healthy subsystem on
 * the single most common catch-up path there is.
 */
function acquireFailureReason(e: unknown): WaitReason {
  const cause = e instanceof Error ? e.cause : undefined;
  if (cause instanceof DeviceHttpError && cause.status === 409) return "device_busy";
  // Defence in depth: beginAcquire() pre-checks reachability, so moveToUserAngle's
  // own limit check should never be the thing that throws here. If it ever is,
  // say which limit rather than inventing a fault.
  const msg = e instanceof Error ? e.message : "";
  if (/outside the (allowed|reachable)/.test(msg)) {
    return /tilt/.test(msg) ? "below_tilt_limit" : "pan_limit";
  }
  // Arrival timeout, transport error, or any other device rejection.
  return "goto_failed";
}

// Compass azimuth (0-360, clockwise from north) of an ENU unit vector. Shared
// by the sector gate in tick() and recordAim()'s status reporting so the two
// derivations can never drift apart.
function enuAzimuthDeg(enuUnit: Vec3): number {
  let az = (Math.atan2(enuUnit[0], enuUnit[1]) * 180) / Math.PI;
  if (az < 0) az += 360;
  return az;
}

export class TrackingSession {
  private state: TrackState = "stopped";
  private reason: WaitReason | null = null;
  private est: EstimatorState = emptyEstimator();
  private label: string | null = null;
  // The ICAO 24-bit hex, set alongside `label` by start(). Kept separate
  // because it is the stable dedup identity for capture: unlike `label`
  // (callsign-or-hex, see AdsbFollower.onSnapshot), it cannot change
  // mid-pass or differ between two passes of the same physical airframe
  // just because a callsign arrived late.
  private hex: string | null = null;
  private timer: { cancel(): void } | null = null;
  private lastActivityMs = 0;
  private acquireGen = 0;
  private gotoInFlight = false;
  private lastStatus: Partial<TrackStatus> = {};
  private stateListeners: ((s: TrackState, icao: string | null) => void)[] = [];
  // The standing aim-offset (see track/offset.ts). Reset to zero on every
  // start() so each pass measures fresh -- an old correction left over from a
  // previous aircraft would corrupt the next pass's measurement.
  private offset: AimOffset = ZERO_OFFSET;

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly sectorProvider: () => TrackSector = () => DISABLED_SECTOR,
    // Operator-taught travel limits (limits-store.ts), read fresh on every
    // tick — a teach_limit/clear_taught_limits call must take effect on the
    // very next tick, not require a session restart. Defaults to "nothing
    // taught" so every existing caller/test that predates this feature keeps
    // its exact prior (config-ceiling-only) behavior.
    private readonly limitsProvider: () => TaughtEdges = () => ({}),
    // Operator-adjustable runtime tuning (tuning-store.ts) -- maxAimOffsetDeg
    // and trackLeadMs both come from here (via resolveTuning(), called fresh
    // at each point of use below), falling through to cfg when a value was
    // never tuned or the store was never wired in. Optional, like the two
    // providers above, so every pre-existing caller/test keeps working
    // unchanged with config-only behavior.
    private readonly tuningStore?: TuningStore,
  ) {}

  isActive(): boolean { return this.state !== "stopped"; }

  // Registers a listener that fires on every state transition (see
  // setState()). Used to wire tracking-state changes into capture, without
  // TrackingSession knowing anything about capture itself.
  onStateChange(cb: (s: TrackState, icao: string | null) => void): void {
    this.stateListeners.push(cb);
  }

  // `hex` is optional and defaults to null so every existing caller (manual
  // start_tracking, tests) that has no ICAO concept keeps working unchanged;
  // only the ADS-B follower supplies it.
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null, hex: string | null = null, fixAgeSec = 0): string | null {
    const rig = this.rigLocation();
    if (!rig) return "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";
    if (!this.store.getOrientation()) return "not calibrated — run solve_calibration first";

    this.stopMotion();
    this.est = withFix(emptyEstimator(), rig, g, this.fixTimeMs(fixAgeSec), statedVel);
    this.label = label;
    this.hex = hex;
    this.offset = ZERO_OFFSET; // fresh pass, fresh measurement
    this.lastActivityMs = this.now();
    this.setState("acquiring");
    this.reason = null;
    this.timer?.cancel();
    this.timer = this.scheduler.every(Math.round(1000 / this.cfg.trackTickHz), () => this.safeTick());
    this.beginAcquire();
    return null;
  }

  // fixAgeSec: how old the POSITION REPORT already was when it arrived (ADS-B
  // seen_pos). Defaults to 0 for callers who genuinely have a live fix
  // (start_tracking/update_target driven by an external client).
  //
  // Stamping every fix with now() was the 2026-07-30 field bug: the rig
  // pointed where the aircraft HAD been, the miss grew with speed and report
  // age, and it looked like a fixed calibration bias until a target turned
  // and the whole thing fell apart. Measured on this rig's feed the same day:
  // median seen_pos 2.8s, p90 37.8s -- 7.4km of lag at 255kt on the worst.
  //
  // Feeding the fix's TRUE time also makes the EXISTING staleness guard
  // honest: lastFixMs now reflects when the aircraft was actually there, so
  // trackMaxTargetAgeMs finally measures what it always claimed to.
  updateTarget(g: Geodetic, statedVel: Vec3 | null, fixAgeSec = 0): string | null {
    if (this.state === "stopped") return "not tracking — call start_tracking first";
    const rig = this.rigLocation();
    if (!rig) return "not calibrated";
    this.est = withFix(this.est, rig, g, this.fixTimeMs(fixAgeSec), statedVel);
    this.lastActivityMs = this.now();
    return null;
  }

  // Clamped at now(): a report claiming to be from the future is a clock
  // problem, and leading BACKWARD from it would point the rig behind the
  // target rather than merely failing to lead it far enough.
  private fixTimeMs(fixAgeSec: number): number {
    const age = Number.isFinite(fixAgeSec) && fixAgeSec > 0 ? fixAgeSec : 0;
    return this.now() - age * 1000;
  }

  stop(): void {
    this.setState("stopped");
    this.reason = null;
    this.timer?.cancel();
    this.timer = null;
    this.stopMotion();
  }

  // -- operator aim-offset (see track/offset.ts) ---------------------------
  // Mechanical on purpose: apply a delta, return the resulting (clamped)
  // offset. This is the exact interface a future automatic (vision-based)
  // corrector will drive instead of a human nudging buttons.

  getOffset(): AimOffset { return this.offset; }

  nudgeOffset(deltaPanDeg: number, deltaTiltDeg: number): NudgeResult {
    const maxAimOffsetDeg = resolveTuning(this.tuningStore, this.cfg).maxAimOffsetDeg;
    const r = nudgeOffsetValue(this.offset, deltaPanDeg, deltaTiltDeg, maxAimOffsetDeg);
    this.offset = { panDeg: r.panDeg, tiltDeg: r.tiltDeg };
    return r;
  }

  clearOffset(): void { this.offset = ZERO_OFFSET; }

  status(): TrackStatus {
    const dev = this.device.getState();
    const fixMs = lastFixMs(this.est);
    return {
      state: this.state,
      reason: this.reason,
      label: this.label,
      targetAzimuthDeg: this.lastStatus.targetAzimuthDeg ?? null,
      targetElevationDeg: this.lastStatus.targetElevationDeg ?? null,
      targetRangeM: this.lastStatus.targetRangeM ?? null,
      targetPanDeg: this.lastStatus.targetPanDeg ?? null,
      targetTiltDeg: this.lastStatus.targetTiltDeg ?? null,
      rigPanDeg: this.state === "stopped" ? null : this.rigPanTilt().panDeg,
      rigTiltDeg: this.state === "stopped" ? null : this.rigPanTilt().tiltDeg,
      pointingErrorDeg: this.lastStatus.pointingErrorDeg ?? null,
      commandedPanDps: this.lastStatus.commandedPanDps ?? null,
      commandedTiltDps: this.lastStatus.commandedTiltDps ?? null,
      panLimited: this.lastStatus.panLimited ?? false,
      tiltLimited: this.lastStatus.tiltLimited ?? false,
      targetAgeMs: fixMs === null ? null : this.now() - fixMs,
      telemetryAgeMs: dev.lastUpdateMs === 0 ? null : this.now() - dev.lastUpdateMs,
      offsetPanDeg: this.offset.panDeg,
      offsetTiltDeg: this.offset.tiltDeg,
    };
  }

  private rigLocation(): Geodetic | null {
    const p = this.store.get();
    return p.rig ? { lat: p.rig.lat, lon: p.rig.lon, height: p.rig.height } : null;
  }

  // Camera-offset model, sourced the same way as point_at/point_at_azel: no
  // gravity calibration yet -> forward-only cHead, which is the no-op default
  // that reduces every offset-aware call below to its legacy mapping.
  private cHead(): Vec3 {
    return this.store.getCHead() ?? [0, 1, 0];
  }

  // The effective (taught-or-config) range — every reachability/guard check
  // in tick()/beginAcquire() below must use this, not cfg.panMin/panMax/
  // tiltMin/tiltMax directly, or a taught limit would stop rate jog earlier
  // than tracking/acquire, reopening the exact "enforced in some paths, not
  // others" gap Part 1 exists to close.
  private limits(): GuardLimits {
    return effectiveLimits(
      { panMin: this.cfg.panMin, panMax: this.cfg.panMax, tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax },
      this.limitsProvider(),
    );
  }

  private rigPanTilt(): { panDeg: number; tiltDeg: number } {
    const d = this.device.getState();
    return {
      panDeg: applySign(stepsToDeg(d.panSteps), this.cfg.panSign),
      tiltDeg: applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign),
    };
  }

  // Abandon any outstanding acquire: break the firmware out of its blocking
  // goto loop, and bump the generation so the orphaned promise's late
  // resolution cannot flip state on a session that has moved on.
  private cancelGoto(): void {
    if (!this.gotoInFlight) return;
    this.gotoInFlight = false;
    this.acquireGen++;
    void this.device.stop().catch(() => {});
  }

  private stopMotion(): void {
    this.cancelGoto();
    this.device.clearJog();
    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: null, commandedTiltDps: null,
      panLimited: false, tiltLimited: false,
    };
  }

  private wait(reason: WaitReason): void {
    this.setState("waiting");
    this.reason = reason;
    this.stopMotion();
  }

  // The dedup identity for capture: the ICAO 24-bit hex, or null if the
  // current/last target has none (non-ADS-B tracking). Deliberately NOT
  // `label` — a callsign that arrives late or changes between two passes of
  // the same airframe must not look like two different identities. Public
  // so a caller correlating a snapshot request against the currently
  // tracked target (see server.ts's CaptureDeps.snapshot) can ask without
  // duplicating tracking state.
  currentIcao(): string | null {
    return this.hex;
  }

  // Call INSTEAD of assigning this.state directly, so every transition is
  // observable. Emits only on an actual change to avoid a per-tick storm.
  private setState(next: TrackState): void {
    if (this.state === next) return;
    this.state = next;
    const icao = this.currentIcao();
    for (const cb of this.stateListeners) {
      try { cb(next, icao); } catch { /* a listener must never break tracking */ }
    }
  }

  // Any throw inside a tick must not leave a rate running. The Device TTL is
  // the real backstop (it survives an event-loop stall, which this cannot).
  private safeTick(): void {
    try { this.tick(); }
    catch { this.stopMotion(); }
  }

  private tick(): void {
    if (this.state === "stopped") return;
    const t = this.now();

    if (t - this.lastActivityMs > this.cfg.trackDeadmanMs) { this.stop(); return; }

    const dev = this.device.getState();
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    if (dev.programEngaged) { this.wait("program_engaged"); return; }
    if (dev.lastUpdateMs === 0 || t - dev.lastUpdateMs > this.cfg.trackStaleTelemetryMs) {
      this.wait("telemetry_stale"); return;
    }
    const fixMs = lastFixMs(this.est);
    if (fixMs === null || t - fixMs > this.cfg.trackMaxTargetAgeMs) { this.wait("target_stale"); return; }

    const trackLeadMs = resolveTuning(this.tuningStore, this.cfg).trackLeadMs;
    const aim = targetAimAt(this.est, R, t + trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }

    // Azimuth-sector filter: if the target's bearing has left the open arc,
    // stop chasing it and hold (do not park). Reuses wait()'s stop path.
    if (!inArc(enuAzimuthDeg(aim.enuUnit), this.sectorProvider())) {
      this.recordAim(aim);
      this.wait("outside_sector");
      return;
    }

    // Shift the setpoint by the standing operator aim-offset BEFORE the
    // reachability check, so an offset that would push the corrected target
    // outside the pan/tilt limits is caught by the exact same gate an
    // unshifted target goes through -- the offset must not bypass this.
    const limits = this.limits();
    const offsetAim = applyOffset(aim.panDeg, aim.tiltDeg, this.offset);
    const reach = reachablePanTilt(
      offsetAim.panDeg, offsetAim.tiltDeg,
      limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax,
    );
    if ("error" in reach) {
      this.recordAim(aim);
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }

    const rig = this.rigPanTilt();
    // Measured against the OFFSET-SHIFTED aim point (target + operator trim,
    // resolved to reach.pan/reach.tilt above -- the exact setpoint
    // controlRate() below commands the servo toward), NOT the raw,
    // unshifted target. The aim offset is a deliberate, operator-commanded
    // bias (see track/offset.ts): once it has converged, the boresight sits
    // `offset` degrees away from the true target ON PURPOSE, and comparing
    // against the true target would misclassify that convergence as lost
    // track -- exactly what let maxAimOffsetDeg's 20° default collide with
    // trackReacquireDeg's 10° default (a converged 15° trim used to
    // self-trigger a reacquire, and thus a stopMotion()+goto, every single
    // tick, so the P-control loop never ran at all). Comparing against the
    // commanded setpoint instead makes this genuinely "has the servo fallen
    // behind (or been disturbed away from) where we're telling it to go" --
    // independent of maxAimOffsetDeg's value, so raising that ceiling can
    // never reopen this. A GENUINE loss of track (the target itself moving
    // away from the commanded setpoint, or the rig getting physically
    // knocked off it) still trips this exactly as before -- only the
    // reference point moved from "the raw target" to "the raw target plus
    // the trim we're intentionally holding".
    const commandedEnu = boresightEnu(R, reach.pan, reach.tilt, this.cHead(), this.cfg.geoPanSign);
    const errDeg = angleBetweenDeg(boresightEnu(R, rig.panDeg, rig.tiltDeg, this.cHead(), this.cfg.geoPanSign), commandedEnu);
    this.recordAim(aim, errDeg);

    if (this.state === "acquiring") return;   // a goto is in flight; let it finish

    if (this.state === "waiting" || errDeg > this.cfg.trackReacquireDeg) {
      // Drop the standing rate first, then let the rig actually come to rest.
      // tb3_goto_safe() is `!Program_Engaged && motorMoving == 0`, and a jog
      // sets motorMoving just as a goto does, so a goto POSTed during the
      // ~450ms ramp-down is refused with a 409. Reacquire fires at
      // trackReacquireDeg of error, which means the servo was saturated -- so
      // without this gate the worst case is also the common case, and every
      // catch-up sprays doomed POSTs.
      //
      // This is a best-effort damper, not a guarantee: `moving` is telemetry
      // and is up to 200ms stale, so a 409 can still slip through. That is
      // what acquireFailureReason() is for -- it reports device_busy and the
      // next tick simply tries again.
      //
      // wait() stops motion itself, which is what starts the deceleration this
      // is waiting on; each subsequent tick re-enters here and re-checks.
      if (dev.moving) { this.wait("device_busy"); return; }
      this.setState("acquiring");
      this.reason = null;
      this.stopMotion();
      this.beginAcquire();
      return;
    }

    // state === tracking. panDeg/tiltDeg come from `reach` (the offset-shifted,
    // range-resolved setpoint) -- NOT `aim` -- so the servo drives toward
    // target+offset. ratePanDps/rateTiltDps stay aim's own feedforward: the
    // offset is a constant correction, so it contributes zero rate of its own.
    const raw = controlRate(
      { ...aim, panDeg: reach.pan, tiltDeg: reach.tilt }, rig.panDeg, rig.tiltDeg,
      this.cfg.trackKp, this.cfg.maxJogDps,
    );
    // Bounded by the staleness gate above (telemetry older than
    // trackStaleTelemetryMs already sent us to `waiting`), so the horizon
    // cannot be inflated by an arbitrarily old reading.
    const tickPeriodMs = 1000 / this.cfg.trackTickHz;
    const telemetryAgeMs = t - dev.lastUpdateMs;
    const guarded = limitGuard(raw, rig.panDeg, rig.tiltDeg, limits, {
      panMs: limitHorizonMs(raw.panDps, telemetryAgeMs, tickPeriodMs, this.cfg.maxJogDps),
      tiltMs: limitHorizonMs(raw.tiltDps, telemetryAgeMs, tickPeriodMs, this.cfg.maxJogDps),
    });

    // NOT the linear mapping layer 1's jog tool uses -- the firmware curve is
    // cubic (measured on hardware). See rateToDeflection.
    const x = rateToDeflection(guarded.out.panDps * this.cfg.panSign, this.cfg.maxJogDps);
    const y = rateToDeflection(guarded.out.tiltDps * this.cfg.tiltSign, this.cfg.maxJogDps);
    this.device.setJogVector(x, y, 0, this.cfg.jogVectorTtlMs);
    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: guarded.out.panDps,
      commandedTiltDps: guarded.out.tiltDps,
      // Surfaced so a guard-held axis (commanded rate zeroed, state still
      // "tracking", no wait reason) is diagnosable instead of looking
      // identical to "the servo is happy". See the README's Safety section --
      // an aggressive trackKp can make this self-perpetuate near a limit.
      panLimited: guarded.panBlocked,
      tiltLimited: guarded.tiltBlocked,
    };
  }

  private recordAim(aim: TargetAim, errDeg?: number): void {
    let azimuth = enuAzimuthDeg(aim.enuUnit);
    if (azimuth >= 360 - 1e-6) azimuth = 0;
    this.lastStatus = {
      ...this.lastStatus,
      targetAzimuthDeg: azimuth,
      targetElevationDeg: (Math.asin(Math.max(-1, Math.min(1, aim.enuUnit[2]))) * 180) / Math.PI,
      targetRangeM: aim.rangeM,
      targetPanDeg: aim.panDeg,
      targetTiltDeg: aim.tiltDeg,
      pointingErrorDeg: errDeg ?? this.lastStatus.pointingErrorDeg ?? null,
    };
  }

  private beginAcquire(): void {
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    const trackLeadMs = resolveTuning(this.tuningStore, this.cfg).trackLeadMs;
    const aim = targetAimAt(this.est, R, this.now() + trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }
    // Azimuth-sector filter: refuse to dispatch the initial goto toward an
    // out-of-sector target. Without this, start() -> beginAcquire() fires the
    // slew synchronously, before tick()'s own gate ever runs -- the tick
    // check alone only protects an already-tracking target from drifting
    // out, it does nothing for the very first acquire. (The tick reacquire
    // branch also calls beginAcquire(), but only after tick() has already
    // gated the same `aim` this call recomputes -- redundant there, but
    // load-bearing for the start() path.)
    if (!inArc(enuAzimuthDeg(aim.enuUnit), this.sectorProvider())) {
      this.wait("outside_sector");
      return;
    }
    // Same offset shift as tick(), applied before the SAME reachability gate
    // -- the initial/reacquire goto slews to target+offset too, so the
    // correction never disappears (and reappears) across an acquire cycle.
    const limits = this.limits();
    const offsetAim = applyOffset(aim.panDeg, aim.tiltDeg, this.offset);
    const reach = reachablePanTilt(
      offsetAim.panDeg, offsetAim.tiltDeg,
      limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax,
    );
    if ("error" in reach) {
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }
    // Fire-and-forget, deliberately not awaited (start()/the reacquire branch
    // return immediately; tracking is a background loop). A goto in flight
    // can be superseded before it settles -- e.g. an interruption sends the
    // session to "waiting" and a later tick starts a fresh acquire while the
    // old moveToUserAngle promise is still pending. The generation stamp lets
    // a superseded attempt's resolution recognize it is stale and do nothing,
    // instead of overwriting whatever the session has moved on to.
    const gen = ++this.acquireGen;
    this.gotoInFlight = true;
    void moveToUserAngle(this.device, this.cfg, reach.pan, reach.tilt, undefined, limits)
      .then(() => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        if (this.state === "acquiring") this.setState("tracking");
      })
      .catch((e: unknown) => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        if (this.state === "acquiring") this.wait(acquireFailureReason(e));
      });
  }

  /** Test seam: force a state without waiting for a real goto to complete. */
  forceStateForTest(s: TrackState): void { this.setState(s); }
}
