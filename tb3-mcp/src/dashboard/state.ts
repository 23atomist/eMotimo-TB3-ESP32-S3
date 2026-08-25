import { RigDirect, ServiceState } from "./parse.js";
import type { CameraStatus } from "./camera/index.js";
import type { Config } from "../config.js";
import type { CaptureStatus } from "../capture/controller.js";

// CameraStatus (mjpeg-streamer.ts) is shared by both capture backends and
// knows nothing of which one is active. The dashboard state layer adds
// `source` -- straight from cfg.cameraSource, fixed for the process lifetime
// -- so the frontend can pick WebRTC (WHEP) vs. the MJPEG path without a
// separate round-trip. Optional (not every fixture/test constructs one) --
// app.js treats a missing source as "not mediamtx", which is the correct
// fallback.
export type DashboardCameraStatus = CameraStatus & { source?: Config["cameraSource"] };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ServicesState { readsb: ServiceState; tb3mcp: ServiceState; tb3agent: ServiceState; llama: ServiceState; }

export interface DeviceStatus {
  connected: boolean; pan_deg: number; tilt_deg: number; moving: boolean;
  battery_v: number; stale: boolean; last_update_age_ms: number | null;
}
export interface TrackingRaw {
  state: string; label: string | null;
  // WHY the session is holding (session.ts's WaitReason), or null when it is
  // not waiting. Optional because the dashboard schema is deliberately
  // non-strict about fields an older daemon may not send.
  reason?: string | null;
  target_azimuth_deg: number | null; target_elevation_deg: number | null; target_range_m: number | null;
  pointing_error_deg: number | null; pan_limited: boolean; tilt_limited: boolean;
  // Riding the estimator's prediction (dropout coasting). Optional so an
  // older daemon's payload still parses.
  coasting?: boolean;
  // The standing drift-calibration aim-offset (see track/offset.ts) -- always
  // a number (defaults to 0), never null: an idle/stopped session still has
  // a well-defined (zero) offset.
  offset_pan_deg: number; offset_tilt_deg: number;
}
export interface TrackedRaw { hex: string | null; }
export interface Geo { lat: number; lon: number; height: number; }
// Reported by get_calibration once characterize_imu has persisted a mounting
// solve (see calibration.ts's setImuMounting/getImuMounting); null before
// that. rmsDeg is the sweep's residual RMS in degrees -- purely
// informational (the calibration step-gate shows it as the "IMU
// characterised" step's detail line) -- and can itself be null on a profile
// persisted before the RMS was tracked, even though the mounting solve
// itself exists.
export interface ImuMountingStatus { rmsDeg: number | null; }

export interface CalibrationRaw {
  calibrated: boolean; rig: Geo | null; sightings: unknown[]; solved_at: string | null;
  // True for a set_north_zero seed -- a provisional orientation is NOT a
  // solved calibration (see calibration.ts's isCalibrated()/isProvisional()),
  // and must read as clearly distinct from one everywhere it's shown.
  provisional: boolean;
  // Optional so a fixture/test built before this field existed (or an older
  // daemon pre-dating it) still compiles/parses -- same convention as
  // `provisional` above pre-drift-calibration. Collapses to null in
  // DashboardState.calibration just like a missing `rig` does.
  imuMounting?: ImuMountingStatus | null;
}
export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; enabled: boolean; }
// The effective (taught-or-config) pan/tilt range — see limits-store.ts's
// effectiveLimits() and its get_taught_limits tool. This is the ONE value
// every enforcement path (jog/goto_angle/tracking/pointing) actually uses,
// and the only one the travel-limit readout needs.
//
// (Review fix, UI-9 fix round, finding I-2: this comment used to end
// "the dashboard deliberately does not surface `taught`/`config_ceiling`
// separately" — true when only the envelope consumed this, false
// now that the Setup drawer's Travel limits procedure needs to show an
// operator which edges have actually been captured. See TaughtLimits below,
// which surfaces exactly that distinction as its OWN field rather than
// folding it into this one — `limits` keeps meaning "the one resolved
// number every enforcement path uses," unchanged.)
export interface EffectiveLimits {
  panMinDeg: number; panMaxDeg: number; tiltMinDeg: number; tiltMaxDeg: number;
}

// Per-edge operator-taught status (get_taught_limits' own `taught` object) —
// null per edge until that edge has actually been captured by teach_limit,
// unlike EffectiveLimits above which always resolves to a real number
// (taught-or-config-ceiling, never null). This is what lets the Travel
// limits procedure show real per-edge progress — "this edge IS taught, at
// this value" vs "this edge has never been taught, the number shown is just
// the config default" — rather than a value that reads identically whether
// or not the operator has done anything.
export interface TaughtLimits {
  panMinDeg: number | null; panMaxDeg: number | null; tiltMinDeg: number | null; tiltMaxDeg: number | null;
}
// get_vision_status's shape (src/vision-tools.ts's VisionStatusSnapshot,
// already camel-cased by McpDashboardClient.getVisionStatus). lastOutcome is
// the raw CorrectorOutcome/GateReject string ("applied", "read_only",
// "none_near_prediction", ...) -- kept as a plain string here rather than
// importing tb3-mcp's own union, so a future outcome the dashboard doesn't
// yet recognise still parses instead of failing zod validation; dashboard/
// public/vision-status.js is the one place that has to know the full set,
// and it already falls back to showing the raw string for anything it
// doesn't recognise (see its own doc comment).
export interface VisionRaw {
  enabled: boolean; readOnly: boolean; lastOutcome: string | null;
  lastCorrectionPanDeg: number | null; lastCorrectionTiltDeg: number | null;
  focalPx: number | null; latencyMs: number | null;
  frameSizePx: { widthPx: number; heightPx: number };
  detectorReachable: boolean | null;
}

export interface AircraftRow {
  hex: string; callsign: string | null; category: string | null; squawk: string | null;
  altitude_m: number | null; ground_speed_kt: number | null;
  azimuth_deg: number; elevation_deg: number; range_km: number; est_track_sec: number | null;
  // reachable/trackable are null (not false) when the rig has a location but
  // no solved mount orientation yet -- see scanAircraft in src/adsb-tools.ts.
  // sunSafe/slewOk/inSector never need the orientation, so they stay real
  // booleans even pre-calibration.
  reachable: boolean | null; sunSafe: boolean; slewOk: boolean; inSector: boolean; trackable: boolean | null;
}

// null propagates: reachable unknown (pre-calibration) means trackability is
// unknown too, never a false "not trackable".
export function deriveTrackable(
  f: { reachable: boolean | null; sunSafe: boolean; slewOk: boolean; inSector: boolean },
): boolean | null {
  if (f.reachable === null) return null;
  return f.reachable && f.sunSafe && f.slewOk && f.inSector;
}

export interface AdsbRaw { rawCount: number | null; aircraft: AircraftRow[]; trackable: AircraftRow[]; }

// The dashboard's press-and-hold jog ramp (dashboard/public/jog-ramp.js)
// needs these to be tunable against real hardware without a frontend code
// edit per iteration -- see config.ts's maxJogDps/jogRampSeconds/jogMinDps
// for the rationale. Straight cfg passthrough, fixed for the process
// lifetime like DashboardCameraStatus's `source`, not a polled Result.
export interface JogConfig { maxJogDps: number; jogRampSeconds: number; jogMinDps: number; }

export type Mode = "idle" | "manual" | "autonomous";

export interface DashboardState {
  ts: number;
  services: ServicesState;
  rig: {
    connected: boolean; panDeg: number | null; tiltDeg: number | null; moving: boolean;
    batteryV: number | null; telemetryAgeMs: number | null;
    imu: RigDirect["imu"];
  };
  mode: Mode;
  tracking: {
    state: string; reason: string | null; hex: string | null; callsign: string | null;
    targetAzDeg: number | null; targetElDeg: number | null; targetRangeM: number | null;
    pointingErrorDeg: number | null; panLimited: boolean; tiltLimited: boolean;
    coasting: boolean;
    offsetPanDeg: number; offsetTiltDeg: number;
  };
  calibration: {
    calibrated: boolean; rig: Geo | null; sightings: unknown[]; solvedAt: string | null; provisional: boolean;
    // Null pre-characterize_imu (and while degraded) -- dashboard/public/step-gate.js
    // gates the IMU step (and everything after it) on this being non-null.
    imuMounting: ImuMountingStatus | null;
  };
  adsb: { rawCount: number | null; aircraft: AircraftRow[]; trackable: AircraftRow[]; };
  sunGuard: { state: string; locked: boolean; separationDeg: number | null; enabled: boolean; };
  camera: DashboardCameraStatus;
  // Recording/snapshot state from the daemon's capture controller. Null both
  // when the daemon hasn't reported yet (not polled) AND when the poll leg
  // fails (degraded) -- either way the dashboard shows a dash rather than
  // guessing, same collapsing-to-null pattern as calibration.rig etc.
  capture: CaptureStatus | null;
  errors: string[];
  jog: JogConfig;
  // The effective (taught-or-config) pan/tilt range, for the travel-limit
  // travel-limit envelope. Null both pre-first-poll and on a failed poll leg
  // -- same collapsing-to-null convention as capture above; the consumer hides
  // the envelope rather than drawing a fabricated one.
  limits: EffectiveLimits | null;
  // Per-edge taught status (null per edge until actually taught) — see
  // TaughtLimits' own doc above. Independently polled and collapsed to null
  // pre-first-poll/on a failed leg, same convention as `limits`; the two are
  // deliberately separate fields (not one nested under the other) so an
  // existing `limits`-only fixture/test keeps compiling unchanged.
  taughtLimits: TaughtLimits | null;
  // Vision-lock correction loop status (get_vision_status) -- always a
  // fully-formed object (never null), same convention as `tracking`/
  // `calibration`/`sunGuard` above: a not-yet-polled/degraded leg collapses
  // to the loop's own safe-by-default shape (enabled:false, readOnly:true,
  // everything else null), not to a missing field the frontend has to
  // special-case. See VisionRaw's doc for why lastOutcome stays a plain
  // string rather than tb3-mcp's own CorrectorOutcome union.
  vision: {
    enabled: boolean; readOnly: boolean; lastOutcome: string | null;
    lastCorrectionPanDeg: number | null; lastCorrectionTiltDeg: number | null;
    focalPx: number | null; latencyMs: number | null;
    frameSizePx: { widthPx: number; heightPx: number } | null;
    detectorReachable: boolean | null;
  };
}

export interface SourceInputs {
  deviceStatus: Result<DeviceStatus>;
  rigDirect: Result<RigDirect>;
  tracking: Result<TrackingRaw>;
  tracked: Result<TrackedRaw>;
  calibration: Result<CalibrationRaw>;
  sun: Result<SunRaw>;
  services: ServicesState;
  adsb: Result<AdsbRaw>;
  capture: Result<CaptureStatus>;
  // In-process camera streamer status — always present (never a failing
  // polled source), so it's a plain value, not a Result.
  camera: DashboardCameraStatus;
  // A persistent camera CONFIG error from startup (e.g. an unusable
  // cameraFfmpegBin/cameraEncoder -- see dashboard/server.ts's main()),
  // distinct from `camera`'s live streamer status. Not a Result: it's
  // established once at startup, never re-polled, and must keep showing up
  // in `errors` on every tick regardless of how the rest of the poll goes --
  // it can't collapse away like a failed Result leg would. Optional so
  // existing fixtures/tests that build a SourceInputs literal without it
  // still compile (same convention as DashboardCameraStatus's `source`).
  cameraError?: string | null;
  // cfg.maxJogDps/jogRampSeconds/jogMinDps, threaded through so the browser
  // can pick up a feel-tuning change from config alone (see JogConfig).
  // Optional for the same reason as cameraError above -- mergeState fills in
  // config.ts's own defaults when a fixture/test omits it.
  jog?: JogConfig;
  // The effective (taught-or-config) pan/tilt range (get_taught_limits).
  // Optional so an existing SourceInputs fixture/test built before this
  // feature still compiles -- an omitted leg collapses to
  // DashboardState.limits === null, same as any other failed Result would.
  limits?: Result<EffectiveLimits>;
  // Per-edge taught status (also get_taught_limits, its `taught` object --
  // see TaughtLimits' own doc). Optional for the same fixture/test-
  // compiles-unchanged reason as `limits` above; deliberately a SEPARATE
  // polled leg rather than a field nested inside `limits`, so an existing
  // `limits`-only fixture/test needs no changes at all.
  taughtLimits?: Result<TaughtLimits>;
  // get_vision_status (see VisionRaw's doc). Optional for the same fixture/
  // test-compiles-unchanged reason as `limits`/`taughtLimits` above -- an
  // omitted leg collapses to DashboardState.vision's safe-by-default shape
  // (enabled:false, readOnly:true, everything else null), never to a
  // missing field.
  vision?: Result<VisionRaw>;
}

// Mirrors config.ts's own defaults (maxJogDps/jogRampSeconds/jogMinDps).
// Only used when SourceInputs.jog is omitted -- collect()/emptySources()
// (server.ts) always supply the real cfg values, so this is purely a
// fixture/test convenience, never what a running dashboard actually serves.
const JOG_CONFIG_DEFAULTS: JogConfig = { maxJogDps: 19, jogRampSeconds: 4, jogMinDps: 3 };

export function mergeState(s: SourceInputs, nowMs: number): DashboardState {
  const errors: string[] = [];
  const note = (name: string, r: Result<unknown>) => { if (!r.ok) errors.push(`${name}: ${r.error}`); };
  for (const [k, v] of Object.entries(s)) {
    if (k !== "services" && v && typeof v === "object" && "ok" in v) note(k, v as Result<unknown>);
  }
  if (s.cameraError) errors.push(`camera: ${s.cameraError}`);

  const dev = s.deviceStatus.ok ? s.deviceStatus.value : null;
  const rd = s.rigDirect.ok ? s.rigDirect.value : null;
  const trk = s.tracking.ok ? s.tracking.value : null;
  const tracked = s.tracked.ok ? s.tracked.value : null;
  const cal = s.calibration.ok ? s.calibration.value : null;
  const sun = s.sun.ok ? s.sun.value : null;
  const adsb = s.adsb.ok ? s.adsb.value : null;
  const limits = s.limits?.ok ? s.limits.value : null;
  const taughtLimits = s.taughtLimits?.ok ? s.taughtLimits.value : null;
  const vision = s.vision?.ok ? s.vision.value : null;

  const trackingState = trk?.state ?? "unknown";
  const mode: Mode = s.services.tb3agent === "active" ? "autonomous"
    : (trk && trk.state !== "stopped" && trk.state !== "unknown") ? "manual"
    : "idle";

  return {
    ts: nowMs,
    services: s.services,
    rig: {
      connected: (dev?.connected ?? false) || (rd?.connected ?? false),
      panDeg: dev ? dev.pan_deg : null,
      tiltDeg: dev ? dev.tilt_deg : null,
      moving: dev?.moving ?? rd?.moving ?? false,
      batteryV: dev?.battery_v ?? rd?.batteryV ?? null,
      telemetryAgeMs: dev?.last_update_age_ms ?? null,
      imu: rd?.imu ?? null,
    },
    mode,
    tracking: {
      state: trackingState,
      reason: trk?.reason ?? null,
      hex: tracked?.hex ?? null,
      callsign: trk?.label ?? null,
      targetAzDeg: trk?.target_azimuth_deg ?? null,
      targetElDeg: trk?.target_elevation_deg ?? null,
      targetRangeM: trk?.target_range_m ?? null,
      pointingErrorDeg: trk?.pointing_error_deg ?? null,
      panLimited: trk?.pan_limited ?? false,
      tiltLimited: trk?.tilt_limited ?? false,
      coasting: trk?.coasting ?? false,
      offsetPanDeg: trk?.offset_pan_deg ?? 0,
      offsetTiltDeg: trk?.offset_tilt_deg ?? 0,
    },
    calibration: {
      calibrated: cal?.calibrated ?? false,
      rig: cal?.rig ?? null,
      sightings: cal?.sightings ?? [],
      solvedAt: cal?.solved_at ?? null,
      provisional: cal?.provisional ?? false,
      imuMounting: cal?.imuMounting ?? null,
    },
    adsb: { rawCount: adsb?.rawCount ?? null, aircraft: adsb?.aircraft ?? [], trackable: adsb?.trackable ?? [] },
    sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null, enabled: sun?.enabled ?? false },
    camera: s.camera,
    capture: s.capture.ok ? s.capture.value : null,
    errors,
    jog: s.jog ?? JOG_CONFIG_DEFAULTS,
    limits,
    taughtLimits,
    vision: {
      // Same safe-by-default pair VisionRuntime itself is constructed with
      // (config.ts's visionEnabled:false/visionReadOnly:true) -- a
      // not-yet-polled/degraded leg must read as "off, and would be
      // read-only if it were on", never as "on and live" by accident.
      enabled: vision?.enabled ?? false,
      readOnly: vision?.readOnly ?? true,
      lastOutcome: vision?.lastOutcome ?? null,
      lastCorrectionPanDeg: vision?.lastCorrectionPanDeg ?? null,
      lastCorrectionTiltDeg: vision?.lastCorrectionTiltDeg ?? null,
      focalPx: vision?.focalPx ?? null,
      latencyMs: vision?.latencyMs ?? null,
      frameSizePx: vision?.frameSizePx ?? null,
      detectorReachable: vision?.detectorReachable ?? null,
    },
  };
}
