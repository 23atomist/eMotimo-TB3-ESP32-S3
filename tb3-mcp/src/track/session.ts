import { Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { Geodetic } from "../geo/wgs84.js";
import { Device } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { stepsToDeg, applySign } from "../angles.js";
import { moveToUserAngle } from "../move.js";
import { reachablePanTilt } from "../geo-tools.js";
import { EstimatorState, emptyEstimator, withFix, lastFixMs } from "./estimator.js";
import {
  TargetAim, targetAimAt, controlRate, limitGuard, boresightEnu, rateToDeflection,
} from "./control.js";

export type TrackState = "stopped" | "acquiring" | "tracking" | "waiting";
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "program_engaged" | "not_calibrated";

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

// How far ahead the limit guard predicts: a few ticks of margin, so the rig is
// stopped before it reaches a limit rather than after.
const LIMIT_HORIZON_TICKS = 3;

export class TrackingSession {
  private state: TrackState = "stopped";
  private reason: WaitReason | null = null;
  private est: EstimatorState = emptyEstimator();
  private label: string | null = null;
  private timer: { cancel(): void } | null = null;
  private lastActivityMs = 0;
  private acquireGen = 0;
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
      targetAgeMs: fixMs === null ? null : this.now() - fixMs,
      telemetryAgeMs: dev.lastUpdateMs === 0 ? null : this.now() - dev.lastUpdateMs,
    };
  }

  private rigLocation(): Geodetic | null {
    const p = this.store.get();
    return p.rig ? { lat: p.rig.lat, lon: p.rig.lon, height: p.rig.height } : null;
  }

  private rigPanTilt(): { panDeg: number; tiltDeg: number } {
    const d = this.device.getState();
    return {
      panDeg: applySign(stepsToDeg(d.panSteps), this.cfg.panSign),
      tiltDeg: applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign),
    };
  }

  private stopMotion(): void {
    this.device.clearJog();
    this.lastStatus = { ...this.lastStatus, commandedPanDps: null, commandedTiltDps: null };
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

    const aim = targetAimAt(this.est, R, t + this.cfg.trackLeadMs);
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
    const errDeg = angleBetweenDeg(boresightEnu(R, rig.panDeg, rig.tiltDeg), aim.enuUnit);
    this.recordAim(aim, errDeg);

    if (this.state === "acquiring") return;   // a goto is in flight; let it finish

    if (this.state === "waiting" || errDeg > this.cfg.trackReacquireDeg) {
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
    const horizonMs = (1000 / this.cfg.trackTickHz) * LIMIT_HORIZON_TICKS;
    const guarded = limitGuard(raw, rig.panDeg, rig.tiltDeg, {
      panMin: this.cfg.panMin, panMax: this.cfg.panMax,
      tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax,
    }, horizonMs);

    // NOT the linear mapping layer 1's jog tool uses -- the firmware curve is
    // cubic (measured on hardware). See rateToDeflection.
    const x = rateToDeflection(guarded.out.panDps * this.cfg.panSign, this.cfg.maxJogDps);
    const y = rateToDeflection(guarded.out.tiltDps * this.cfg.tiltSign, this.cfg.maxJogDps);
    this.device.setJogVector(x, y, 0, this.cfg.jogVectorTtlMs);
    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: guarded.out.panDps,
      commandedTiltDps: guarded.out.tiltDps,
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
    const aim = targetAimAt(this.est, R, this.now() + this.cfg.trackLeadMs);
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
    void moveToUserAngle(this.device, this.cfg, reach.pan, reach.tilt)
      .then(() => { if (gen === this.acquireGen && this.state === "acquiring") this.state = "tracking"; })
      .catch(() => { if (gen === this.acquireGen && this.state === "acquiring") this.wait("telemetry_stale"); });
  }

  /** Test seam: force a state without waiting for a real goto to complete. */
  forceStateForTest(s: TrackState): void { this.state = s; }
}
