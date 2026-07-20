import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { resultText } from "../agent/mcp-client.js";
import { DeviceStatus, TrackingRaw, TrackedRaw, CalibrationRaw, SunRaw, AircraftRow } from "./state.js";

// Each schema below is intentionally non-strict (no `.strict()`): the tool
// handlers (src/tools.ts, track-tools.ts, geo-tools.ts, adsb-tools.ts,
// sun-tools.ts) emit extra fields this dashboard doesn't consume (e.g.
// aux_steps, program_engaged, sta_ip on get_status; reason/target_pan_deg/etc.
// on get_tracking_status; reachable/sun_safe/slew_ok/required_slew_dps on
// scan_aircraft rows). Zod's default z.object().parse() strips unknown keys
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
});

// get_sun (src/sun-tools.ts) has no field literally named "state",
// "locked", or "separationDeg" — its wire shape is
// {..., guard_state, guard_reason, guard_enabled, ..., boresight_separation_deg, locked}.
// Mapped below: SunRaw.state <- guard_state, SunRaw.separationDeg <- boresight_separation_deg.
const SunRawZ = z.object({
  guard_state: z.string(),
  locked: z.boolean(),
  boresight_separation_deg: z.number().nullable(),
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
  est_track_sec: z.number(),
});
const ScanBodyZ = z.object({ aircraft: z.array(AircraftRowZ) });

export class McpDashboardClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = new Client({ name: "tb3-dashboard", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const opts = this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url), opts));
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    return resultText(name, await this.client.callTool({ name, arguments: args }));
  }

  async getDeviceStatus(): Promise<DeviceStatus> {
    return DeviceStatusZ.parse(JSON.parse(await this.call("get_status", {})));
  }

  async getTrackingStatus(): Promise<TrackingRaw> {
    return TrackingRawZ.parse(JSON.parse(await this.call("get_tracking_status", {})));
  }

  async getTracked(): Promise<TrackedRaw> {
    return TrackedRawZ.parse(JSON.parse(await this.call("get_tracked_aircraft", {})));
  }

  async getCalibration(): Promise<CalibrationRaw> {
    const b = CalibrationRawZ.parse(JSON.parse(await this.call("get_calibration", {})));
    return { calibrated: b.calibrated, rig: b.rig ?? null, sightings: b.sightings, solved_at: b.solved_at };
  }

  async getSun(): Promise<SunRaw> {
    const b = SunRawZ.parse(JSON.parse(await this.call("get_sun", {})));
    return { state: b.guard_state, locked: b.locked, separationDeg: b.boresight_separation_deg };
  }

  async scanTrackable(): Promise<AircraftRow[]> {
    const body = ScanBodyZ.parse(JSON.parse(await this.call("scan_aircraft", {})));
    return body.aircraft;
  }

  async track(hex: string): Promise<void> { await this.call("track_aircraft", { hex }); }
  async stopTracking(): Promise<void> { await this.call("stop_tracking", {}); }

  async jog(panDps: number, tiltDps: number, durationMs: number): Promise<void> {
    await this.call("jog", { pan_dps: panDps, tilt_dps: tiltDps, duration_ms: durationMs });
  }

  async setRigLocation(lat: number, lon: number, heightM: number): Promise<void> {
    await this.call("set_rig_location", { lat, lon, height_m: heightM });
  }

  async sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void> {
    await this.call("sight_landmark", { lat, lon, height_m: heightM, label });
  }

  async solveCalibration(): Promise<string> { return this.call("solve_calibration", {}); }
  async clearCalibration(): Promise<void> { await this.call("clear_calibration", {}); }
}
