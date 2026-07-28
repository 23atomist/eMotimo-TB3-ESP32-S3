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
  target_azimuth_deg: number | null; target_elevation_deg: number | null; target_range_m: number | null;
  pointing_error_deg: number | null; pan_limited: boolean; tilt_limited: boolean;
  // The standing drift-calibration aim-offset (see track/offset.ts) -- always
  // a number (defaults to 0), never null: an idle/stopped session still has
  // a well-defined (zero) offset.
  offset_pan_deg: number; offset_tilt_deg: number;
}
export interface TrackedRaw { hex: string | null; }
export interface Geo { lat: number; lon: number; height: number; }
export interface CalibrationRaw {
  calibrated: boolean; rig: Geo | null; sightings: unknown[]; solved_at: string | null;
  // True for a set_north_zero seed -- a provisional orientation is NOT a
  // solved calibration (see calibration.ts's isCalibrated()/isProvisional()),
  // and must read as clearly distinct from one everywhere it's shown.
  provisional: boolean;
}
export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; enabled: boolean; }
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
    state: string; hex: string | null; callsign: string | null;
    targetAzDeg: number | null; targetElDeg: number | null; targetRangeM: number | null;
    pointingErrorDeg: number | null; panLimited: boolean; tiltLimited: boolean;
    offsetPanDeg: number; offsetTiltDeg: number;
  };
  calibration: { calibrated: boolean; rig: Geo | null; sightings: unknown[]; solvedAt: string | null; provisional: boolean; };
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
}

// Mirrors config.ts's own defaults (maxJogDps/jogRampSeconds/jogMinDps).
// Only used when SourceInputs.jog is omitted -- collect()/emptySources()
// (server.ts) always supply the real cfg values, so this is purely a
// fixture/test convenience, never what a running dashboard actually serves.
const JOG_CONFIG_DEFAULTS: JogConfig = { maxJogDps: 19, jogRampSeconds: 4, jogMinDps: 1 };

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
      hex: tracked?.hex ?? null,
      callsign: trk?.label ?? null,
      targetAzDeg: trk?.target_azimuth_deg ?? null,
      targetElDeg: trk?.target_elevation_deg ?? null,
      targetRangeM: trk?.target_range_m ?? null,
      pointingErrorDeg: trk?.pointing_error_deg ?? null,
      panLimited: trk?.pan_limited ?? false,
      tiltLimited: trk?.tilt_limited ?? false,
      offsetPanDeg: trk?.offset_pan_deg ?? 0,
      offsetTiltDeg: trk?.offset_tilt_deg ?? 0,
    },
    calibration: {
      calibrated: cal?.calibrated ?? false,
      rig: cal?.rig ?? null,
      sightings: cal?.sightings ?? [],
      solvedAt: cal?.solved_at ?? null,
      provisional: cal?.provisional ?? false,
    },
    adsb: { rawCount: adsb?.rawCount ?? null, aircraft: adsb?.aircraft ?? [], trackable: adsb?.trackable ?? [] },
    sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null, enabled: sun?.enabled ?? false },
    camera: s.camera,
    capture: s.capture.ok ? s.capture.value : null,
    errors,
    jog: s.jog ?? JOG_CONFIG_DEFAULTS,
  };
}
