import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { resultText, isSessionError } from "../agent/mcp-client.js";
import {
  DeviceStatus, TrackingRaw, TrackedRaw, CalibrationRaw, SunRaw, AircraftRow, deriveTrackable, EffectiveLimits,
  ImuMountingStatus, TaughtLimits, RezeroRaw,
} from "./state.js";
import type { CaptureStatus } from "../capture/controller.js";

// Each schema below is intentionally non-strict (no `.strict()`): the tool
// handlers (src/tools.ts, track-tools.ts, geo-tools.ts, adsb-tools.ts,
// sun-tools.ts) emit extra fields this dashboard doesn't consume (e.g.
// aux_steps, program_engaged, sta_ip on get_status; reason/target_pan_deg/etc.
// on get_tracking_status; required_slew_dps on scan_aircraft rows). Zod's
// default z.object().parse() strips unknown keys
// rather than rejecting them, so growing those tool outputs never breaks this
// client.

const DeviceStatusZ = z.object({
  connected: z.boolean(),
  pan_deg: z.number(),
  tilt_deg: z.number(),
  moving: z.boolean(),
  battery_v: z.number(),
  stale: z.boolean(),
  last_update_age_ms: z.number().nullable(),
});

const TrackingRawZ = z.object({
  state: z.string(),
  label: z.string().nullable(),
  target_azimuth_deg: z.number().nullable(),
  target_elevation_deg: z.number().nullable(),
  target_range_m: z.number().nullable(),
  pointing_error_deg: z.number().nullable(),
  pan_limited: z.boolean(),
  tilt_limited: z.boolean(),
  // Absent on an older daemon (pre-drift-calibration) -- default to 0 rather
  // than reject the whole payload, matching this file's non-strict-schema
  // convention (see the module comment above).
  offset_pan_deg: z.number().optional(),
  offset_tilt_deg: z.number().optional(),
});

const TrackedRawZ = z.object({
  hex: z.string().nullable(),
});

const GeoZ = z.object({ lat: z.number(), lon: z.number(), height: z.number() });

// get_calibration (src/geo-tools.ts) JSON.stringify()s `rig: p.rig`, and
// p.rig is `undefined` until set_rig_location is called — JSON.stringify
// drops undefined object properties entirely, so the "rig" key is simply
// absent from the wire payload rather than present as `null`. Hence
// `.nullable().optional()`: nullable to accept an explicit null (defensive;
// not currently emitted) and optional to accept the key being missing
// altogether. Both collapse to `null` below to match CalibrationRaw.
const CalibrationRawZ = z.object({
  calibrated: z.boolean(),
  rig: GeoZ.nullable().optional(),
  sightings: z.array(z.unknown()),
  solved_at: z.string().nullable(),
  // Absent on an older daemon (pre-drift-calibration) -- default to false
  // rather than reject the whole payload (same convention as offset_* below).
  provisional: z.boolean().optional(),
  // Null until characterize_imu has persisted a mounting solve; absent
  // entirely on an older daemon that predates this field (same
  // tolerate-missing-key convention as `provisional` above). rms_deg is
  // nullable rather than always-a-number because a profile persisted before
  // the RMS was tracked can still report a mounting solve with no RMS.
  imu_mounting: z.object({ rms_deg: z.number().nullable() }).nullable().optional(),
});

// get_sun (src/sun-tools.ts) has no field literally named "state",
// "locked", or "separationDeg" — its wire shape is
// {..., guard_state, guard_reason, guard_enabled, ..., boresight_separation_deg, locked}.
// Mapped below: SunRaw.state <- guard_state, SunRaw.separationDeg <- boresight_separation_deg.
const SunRawZ = z.object({
  guard_state: z.string(),
  locked: z.boolean(),
  boresight_separation_deg: z.number().nullable(),
  guard_enabled: z.boolean(),
});

const AircraftRowZ = z.object({
  hex: z.string(),
  callsign: z.string().nullable(),
  category: z.string().nullable(),
  squawk: z.string().nullable(),
  altitude_m: z.number().nullable(),
  ground_speed_kt: z.number().nullable(),
  azimuth_deg: z.number(),
  elevation_deg: z.number(),
  range_km: z.number(),
  // null pre-calibration (rig location set, mount orientation not yet
  // solved) -- see scanAircraft in src/adsb-tools.ts.
  est_track_sec: z.number().nullable(),
  reachable: z.boolean().nullable(),
  sun_safe: z.boolean(),
  slew_ok: z.boolean(),
  in_sector: z.boolean(),
});
const ScanBodyZ = z.object({ aircraft: z.array(AircraftRowZ) });

const TrackSectorZ = z.object({ enabled: z.boolean(), start_deg: z.number(), end_deg: z.number() });

// get_taught_limits (src/limits-tools.ts) also reports `taught`/`config_ceiling`,
// but the dashboard's 3D-view envelope (rigview.js) only ever needs the
// resolved `effective` range — the one value every enforcement path
// (jog/goto_angle/tracking/pointing) actually uses.
const EffectiveLimitsZ = z.object({
  effective: z.object({
    pan_min: z.number(), pan_max: z.number(), tilt_min: z.number(), tilt_max: z.number(),
  }),
});

// The SAME get_taught_limits response's `taught` object — per-edge, null
// until that edge has actually been captured by teach_limit (see
// limits-tools.ts's own get_taught_limits handler). Parsed by a second call
// to the same read-only-of-motion tool (getTaughtLimits below) rather than
// restructuring getLimits() above to return both in one round trip — this
// tool is cheap and already polled once per SSE tick, so a second poll is
// negligible, and it keeps EffectiveLimits/getLimits' existing shape (and
// every consumer of it) completely untouched (review fix, UI-9 fix round,
// finding I-2).
const TaughtLimitsZ = z.object({
  taught: z.object({
    pan_min: z.number().nullable(), pan_max: z.number().nullable(),
    tilt_min: z.number().nullable(), tilt_max: z.number().nullable(),
  }),
});

// get_rezero_status (src/rezero-tools.ts) reports a lot more than this (see
// RezeroRaw's own doc, state.ts) -- only the three fields the dashboard's
// re-zero-pending banner (Task 6 / I-C) actually needs are parsed here; the
// non-strict z.object() drops everything else (taught_axes, last_rezero,
// fit_residual_deg, sun_guard, boot_id) rather than rejecting them, same
// convention as every other schema in this file.
const RezeroRawZ = z.object({
  needs_rezero: z.boolean(),
  landmark_label: z.string().nullable(),
  remedy: z.string().nullable(),
});

// get_capture_status (src/tools.ts) JSON.stringify()s CaptureController.status()
// directly -- already camelCase, no snake_case remap needed (unlike get_sun
// above).
const CaptureStatusZ = z.object({
  autoEnabled: z.boolean(),
  recording: z.boolean(),
  passIcao: z.string().nullable(),
  lastSnapshot: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSkipReason: z.string().nullable(),
});

export class McpDashboardClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = this.newClient();
  }

  private newClient(): Client { return new Client({ name: "tb3-dashboard", version: "0.1.0" }); }

  private transportOpts(): { requestInit: { headers: Record<string, string> } } | undefined {
    return this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url), this.transportOpts()));
  }

  // Rebuild the client + transport to obtain a fresh session id after the
  // daemon restarts. Called from call() when a session error is seen.
  private async reconnect(): Promise<void> {
    try { await this.client.close(); } catch { /* already gone */ }
    this.client = this.newClient();
    await this.connect();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      return resultText(name, await this.client.callTool({ name, arguments: args }));
    } catch (e) {
      if (!isSessionError(e)) throw e;
      await this.reconnect();
      return resultText(name, await this.client.callTool({ name, arguments: args }));
    }
  }

  async getDeviceStatus(): Promise<DeviceStatus> {
    return DeviceStatusZ.parse(JSON.parse(await this.call("get_status", {})));
  }

  async getTrackingStatus(): Promise<TrackingRaw> {
    const b = TrackingRawZ.parse(JSON.parse(await this.call("get_tracking_status", {})));
    return { ...b, offset_pan_deg: b.offset_pan_deg ?? 0, offset_tilt_deg: b.offset_tilt_deg ?? 0 };
  }

  async getTracked(): Promise<TrackedRaw> {
    return TrackedRawZ.parse(JSON.parse(await this.call("get_tracked_aircraft", {})));
  }

  async getCalibration(): Promise<CalibrationRaw> {
    const b = CalibrationRawZ.parse(JSON.parse(await this.call("get_calibration", {})));
    const imuMounting: ImuMountingStatus | null = b.imu_mounting ? { rmsDeg: b.imu_mounting.rms_deg } : null;
    return {
      calibrated: b.calibrated, rig: b.rig ?? null, sightings: b.sightings, solved_at: b.solved_at,
      provisional: b.provisional ?? false, imuMounting,
    };
  }

  async getSun(): Promise<SunRaw> {
    const b = SunRawZ.parse(JSON.parse(await this.call("get_sun", {})));
    return { state: b.guard_state, locked: b.locked, separationDeg: b.boresight_separation_deg, enabled: b.guard_enabled };
  }

  async getCaptureStatus(): Promise<CaptureStatus> {
    return CaptureStatusZ.parse(JSON.parse(await this.call("get_capture_status", {})));
  }

  // scan_aircraft's only_trackable filter runs server-side BEFORE the
  // range-sort and slice to `limit` (see scanAircraft() in src/adsb-tools.ts).
  // With only_trackable:false (the map's call) that filter is skipped
  // entirely, so the daemon sorts ALL seen planes by range and slices to 50 —
  // filtering to trackable CLIENT-SIDE after that slice would drop farther
  // trackable planes crowded out of the nearest-50 by closer untrackable
  // ones. Hence two separate calls below — scanAircraft() (all planes, for
  // the map) and scanTrackable() (trackable only, for the list) — sharing
  // the same row mapping via rowToAircraft().
  private rowToAircraft(r: z.infer<typeof AircraftRowZ>): AircraftRow {
    return {
      hex: r.hex, callsign: r.callsign, category: r.category, squawk: r.squawk,
      altitude_m: r.altitude_m, ground_speed_kt: r.ground_speed_kt,
      azimuth_deg: r.azimuth_deg, elevation_deg: r.elevation_deg, range_km: r.range_km, est_track_sec: r.est_track_sec,
      reachable: r.reachable, sunSafe: r.sun_safe, slewOk: r.slew_ok, inSector: r.in_sector,
      trackable: deriveTrackable({ reachable: r.reachable, sunSafe: r.sun_safe, slewOk: r.slew_ok, inSector: r.in_sector }),
    };
  }

  // All planes seen (not just trackable), for the mini-map.
  async scanAircraft(): Promise<AircraftRow[]> {
    const body = ScanBodyZ.parse(JSON.parse(await this.call("scan_aircraft", { only_trackable: false, limit: 50 })));
    return body.aircraft.map((r) => this.rowToAircraft(r));
  }

  // Trackable-only, nearest-first (the tool's defaults) — for the aircraft
  // list, unaffected by how many untrackable planes are nearby.
  async scanTrackable(): Promise<AircraftRow[]> {
    const body = ScanBodyZ.parse(JSON.parse(await this.call("scan_aircraft", { only_trackable: true, limit: 20 })));
    return body.aircraft.map((r) => this.rowToAircraft(r));
  }

  async track(hex: string): Promise<void> { await this.call("track_aircraft", { hex }); }
  async stopTracking(): Promise<void> { await this.call("stop_tracking", {}); }

  async jog(panDps: number, tiltDps: number, durationMs: number): Promise<void> {
    await this.call("jog", { pan_dps: panDps, tilt_dps: tiltDps, duration_ms: durationMs });
  }

  // Returns the tool's JSON text rather than void: it carries `clamped`, and
  // the dashboard has to be able to tell the operator when the trim has run
  // out (see nudge_aim_offset in src/track-tools.ts).
  async nudgeAimOffset(deltaPanDeg: number, deltaTiltDeg: number): Promise<string> {
    return await this.call("nudge_aim_offset", { delta_pan_deg: deltaPanDeg, delta_tilt_deg: deltaTiltDeg });
  }

  async setRigLocation(lat: number, lon: number, heightM: number): Promise<void> {
    await this.call("set_rig_location", { lat, lon, height_m: heightM });
  }

  async sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void> {
    await this.call("sight_landmark", { lat, lon, height_m: heightM, label });
  }

  // Raw JSON tool response text, same convention as solveCalibration below --
  // it already carries the human-relevant bits (slot filled, extrapolation
  // applied, any separation warning) in its `note` field, so there is
  // nothing to reshape here.
  async sightAircraft(hex: string): Promise<string> {
    return this.call("sight_aircraft", { hex });
  }

  async solveCalibration(): Promise<string> { return this.call("solve_calibration", {}); }
  async clearCalibration(): Promise<void> { await this.call("clear_calibration", {}); }

  // The tools below had no dashboard transport at all until now -- each is a
  // thin passthrough to the matching MCP tool, same raw-response-text
  // convention as sightAircraft/solveCalibration above (the daemon's own
  // `note`/message text is already what the operator needs to see).
  async characterizeImu(): Promise<string> { return this.call("characterize_imu", {}); }
  async setNorthZero(): Promise<string> { return this.call("set_north_zero", {}); }
  async teachLimit(edge: string): Promise<string> { return this.call("teach_limit", { edge }); }
  async clearTaughtLimits(): Promise<string> { return this.call("clear_taught_limits", {}); }
  async setHome(): Promise<string> { return this.call("set_home", {}); }
  async captureSnapshot(icao?: string): Promise<string> {
    return this.call("capture_snapshot", icao ? { icao } : {});
  }
  async startRecording(): Promise<string> { return this.call("start_recording", {}); }
  async stopRecording(): Promise<string> { return this.call("stop_recording", {}); }
  // Review fix, finding I-3: set_capture_mode had a tool but no dashboard
  // transport at all -- same thin-passthrough convention as the three above.
  async setCaptureMode(enabled: boolean): Promise<string> { return this.call("set_capture_mode", { enabled }); }

  async getTrackSector(): Promise<{ enabled: boolean; startDeg: number; endDeg: number }> {
    const b = TrackSectorZ.parse(JSON.parse(await this.call("get_track_sector", {})));
    return { enabled: b.enabled, startDeg: b.start_deg, endDeg: b.end_deg };
  }

  async setTrackSector(startDeg: number, endDeg: number, enabled: boolean): Promise<void> {
    await this.call("set_track_sector", { start_deg: startDeg, end_deg: endDeg, enabled });
  }

  async setSunGuard(enabled: boolean): Promise<void> {
    await this.call("set_sun_guard", { enabled });
  }

  // The effective (taught-or-config) pan/tilt range, for rigview.js's
  // travel-limit envelope (see limits-tools.ts's get_taught_limits).
  async getLimits(): Promise<EffectiveLimits> {
    const b = EffectiveLimitsZ.parse(JSON.parse(await this.call("get_taught_limits", {})));
    return {
      panMinDeg: b.effective.pan_min, panMaxDeg: b.effective.pan_max,
      tiltMinDeg: b.effective.tilt_min, tiltMaxDeg: b.effective.tilt_max,
    };
  }

  // Per-edge taught status (null per edge until actually taught), for the
  // Setup drawer's Travel limits procedure -- see TaughtLimits' own doc
  // (state.ts) for why this is a second call rather than folded into
  // getLimits() above.
  async getTaughtLimits(): Promise<TaughtLimits> {
    const b = TaughtLimitsZ.parse(JSON.parse(await this.call("get_taught_limits", {})));
    return {
      panMinDeg: b.taught.pan_min, panMaxDeg: b.taught.pan_max,
      tiltMinDeg: b.taught.tilt_min, tiltMaxDeg: b.taught.tilt_max,
    };
  }

  // Re-zero pending state (get_rezero_status, Task 6 / I-C) -- had no
  // dashboard transport at all before this, same gap set_capture_mode's own
  // comment above describes for that tool.
  async getRezeroStatus(): Promise<RezeroRaw> {
    return RezeroRawZ.parse(JSON.parse(await this.call("get_rezero_status", {})));
  }
}
