import { RigDirect, ServiceState } from "./parse.js";

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
}
export interface TrackedRaw { hex: string | null; }
export interface Geo { lat: number; lon: number; height: number; }
export interface CalibrationRaw { calibrated: boolean; rig: Geo | null; sightings: unknown[]; solved_at: string | null; }
export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; }
export interface AircraftRow {
  hex: string; callsign: string | null; category: string | null; squawk: string | null;
  altitude_m: number | null; ground_speed_kt: number | null;
  azimuth_deg: number; elevation_deg: number; range_km: number; est_track_sec: number;
}
export interface AdsbRaw { rawCount: number | null; trackable: AircraftRow[]; }

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
  };
  calibration: { calibrated: boolean; rig: Geo | null; sightings: unknown[]; solvedAt: string | null; };
  adsb: { rawCount: number | null; trackable: AircraftRow[]; };
  sunGuard: { state: string; locked: boolean; separationDeg: number | null; };
  errors: string[];
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
}

export function mergeState(s: SourceInputs, nowMs: number): DashboardState {
  const errors: string[] = [];
  const note = (name: string, r: Result<unknown>) => { if (!r.ok) errors.push(`${name}: ${r.error}`); };
  for (const [k, v] of Object.entries(s)) {
    if (k !== "services" && v && typeof v === "object" && "ok" in v) note(k, v as Result<unknown>);
  }

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
    },
    calibration: {
      calibrated: cal?.calibrated ?? false,
      rig: cal?.rig ?? null,
      sightings: cal?.sightings ?? [],
      solvedAt: cal?.solved_at ?? null,
    },
    adsb: { rawCount: adsb?.rawCount ?? null, trackable: adsb?.trackable ?? [] },
    sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null },
    errors,
  };
}
