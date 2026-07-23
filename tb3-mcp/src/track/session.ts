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

export type TrackState = "stopped" | "acquiring" | "tracking" | "waiting";
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "program_engaged" | "not_calibrated"
  | "device_busy" | "goto_failed";

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

export class TrackingSession {
  private state: TrackState = "stopped";
  private reason: WaitReason | null = null;
  private est: EstimatorState = emptyEstimator();
  private label: string | null = null;
  private timer: { cancel(): void } | null = null;
  private lastActivityMs = 0;
  private acquireGen = 0;
  private gotoInFlight = false;
  private lastStatus: Partial<TrackStatus> = {};

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  isActive(): boolean { return this.state !== "stopped"; }

  start(g: Geodetic, statedVel: Vec3 | null, label: string | null): string | null {
    const rig = this.rigLocation();
    if (!rig) return "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";
    if (!this.store.getOrientation()) return "not calibrated — run solve_calibration first";

    this.stopMotion();
    this.est = withFix(emptyEstimator(), rig, g, this.now(), statedVel);
    this.label = label;
    this.lastActivityMs = this.now();
    this.state = "acquiring";
    this.reason = null;
    this.timer?.cancel();
    this.timer = this.scheduler.every(Math.round(1000 / this.cfg.trackTickHz), () => this.safeTick());
    this.beginAcquire();
    return null;
  }

  updateTarget(g: Geodetic, statedVel: Vec3 | null): string | null {
    if (this.state === "stopped") return "not tracking — call start_tracking first";
    const rig = this.rigLocation();
    if (!rig) return "not calibrated";
    this.est = withFix(this.est, rig, g, this.now(), statedVel);
    this.lastActivityMs = this.now();
    return null;
  }

  stop(): void {
    this.state = "stopped";
    this.reason = null;
    this.timer?.cancel();
    this.timer = null;
    this.stopMotion();
  }

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

  private limits(): GuardLimits {
    return {
      panMin: this.cfg.panMin, panMax: this.cfg.panMax,
      tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax,
    };
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
    this.state = "waiting";
    this.reason = reason;
    this.stopMotion();
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

    const aim = targetAimAt(this.est, R, t + this.cfg.trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }

    const reach = reachablePanTilt(
      aim.panDeg, aim.tiltDeg,
      this.cfg.panMin, this.cfg.panMax, this.cfg.tiltMin, this.cfg.tiltMax,
    );
    if ("error" in reach) {
      this.recordAim(aim);
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }

    const rig = this.rigPanTilt();
    const errDeg = angleBetweenDeg(boresightEnu(R, rig.panDeg, rig.tiltDeg, this.cHead(), this.cfg.geoPanSign), aim.enuUnit);
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
      this.state = "acquiring";
      this.reason = null;
      this.stopMotion();
      this.beginAcquire();
      return;
    }

    // state === tracking
    const raw = controlRate(
      { ...aim, panDeg: reach.pan }, rig.panDeg, rig.tiltDeg,
      this.cfg.trackKp, this.cfg.maxJogDps,
    );
    // Bounded by the staleness gate above (telemetry older than
    // trackStaleTelemetryMs already sent us to `waiting`), so the horizon
    // cannot be inflated by an arbitrarily old reading.
    const tickPeriodMs = 1000 / this.cfg.trackTickHz;
    const telemetryAgeMs = t - dev.lastUpdateMs;
    const guarded = limitGuard(raw, rig.panDeg, rig.tiltDeg, {
      panMin: this.cfg.panMin, panMax: this.cfg.panMax,
      tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax,
    }, {
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
    let azimuth = (Math.atan2(aim.enuUnit[0], aim.enuUnit[1]) * 180) / Math.PI;
    if (azimuth < 0) azimuth += 360;
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
    const aim = targetAimAt(this.est, R, this.now() + this.cfg.trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }
    const reach = reachablePanTilt(
      aim.panDeg, aim.tiltDeg,
      this.cfg.panMin, this.cfg.panMax, this.cfg.tiltMin, this.cfg.tiltMax,
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
    void moveToUserAngle(this.device, this.cfg, reach.pan, reach.tilt)
      .then(() => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        if (this.state === "acquiring") this.state = "tracking";
      })
      .catch((e: unknown) => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        if (this.state === "acquiring") this.wait(acquireFailureReason(e));
      });
  }

  /** Test seam: force a state without waiting for a real goto to complete. */
  forceStateForTest(s: TrackState): void { this.state = s; }
}
