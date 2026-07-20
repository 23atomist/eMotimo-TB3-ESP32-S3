import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { Geodetic } from "./geo/wgs84.js";
import { Mat3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { enrichAircraft } from "./adsb/enrich.js";
import { AdsbSnapshot, EnrichedAircraft } from "./adsb/types.js";
import { aircraftAltitudeM } from "./adsb/convert.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

const NOT_CALIBRATED = "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";

export interface ScanParams { maxRangeKm: number; onlyTrackable: boolean; limit: number; }

export function isTrackable(e: EnrichedAircraft): boolean {
  return e.reachable && e.sunSafe && e.slewOk;
}

export function scanAircraft(
  snap: AdsbSnapshot, rig: Geodetic | null, R: Mat3 | null,
  cfg: Config, nowMs: number, p: ScanParams,
): { error: string } | { aircraft: EnrichedAircraft[] } {
  if (!rig || !R) return { error: NOT_CALIBRATED };
  const maxRangeM = p.maxRangeKm * 1000;
  const enriched = snap.aircraft
    .map((a) => enrichAircraft(a, rig, R, cfg, nowMs))
    .filter((e): e is EnrichedAircraft => e !== null)
    .filter((e) => e.rangeM <= maxRangeM)
    .filter((e) => !p.onlyTrackable || isTrackable(e))
    .sort((a, b) => a.rangeM - b.rangeM);
  return { aircraft: enriched.slice(0, p.limit) };
}

// Compact per-aircraft view for tool output and the LLM prompt.
function view(e: EnrichedAircraft) {
  return {
    hex: e.hex, callsign: e.callsign, category: e.category, squawk: e.squawk,
    altitude_m: null as number | null,   // filled below to keep field order stable
    ground_speed_kt: e.gsKt,
    azimuth_deg: Number(e.azimuthDeg.toFixed(1)),
    elevation_deg: Number(e.elevationDeg.toFixed(1)),
    range_km: Number((e.rangeM / 1000).toFixed(1)),
    required_slew_dps: Number(e.requiredSlewDps.toFixed(2)),
    est_track_sec: e.estTrackSec,
    reachable: e.reachable, sun_safe: e.sunSafe, slew_ok: e.slewOk,
  };
}

export function registerAdsbTools(
  server: McpServer, source: AdsbSource, follower: AdsbFollower,
  store: CalibrationStore, cfg: Config, session: TrackingSession, supervisor: SunSupervisor,
): void {
  const rigR = (): { rig: Geodetic | null; R: Mat3 | null } => {
    const p = store.get();
    return { rig: p.rig ?? null, R: store.getOrientation() ?? null };
  };

  server.registerTool(
    "scan_aircraft",
    {
      description:
        "List aircraft seen via ADS-B, enriched with rig-relative azimuth/elevation/range and the " +
        "objective trackable flags (reachable, sun_safe, slew_ok). Defaults to only the trackable ones, " +
        "sorted nearest-first. Interestingness is the caller's judgement.",
      inputSchema: {
        max_range_km: z.number().positive().optional().describe(`max slant range in km (default ${cfg.adsbMaxRangeKm})`),
        only_trackable: z.boolean().optional().describe("only aircraft that are reachable, sun-safe, and within slew rate (default true)"),
        limit: z.number().int().positive().max(100).optional().describe("max rows (default 20)"),
      },
    },
    async ({ max_range_km, only_trackable, limit }) => {
      const { rig, R } = rigR();
      const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(), {
        maxRangeKm: max_range_km ?? cfg.adsbMaxRangeKm,
        onlyTrackable: only_trackable ?? true,
        limit: limit ?? 20,
      });
      if ("error" in res) return errText(res.error);
      const rows = res.aircraft.map((e) => {
        const v = view(e);
        // Recompute using cfg.adsbAltSource (not a fixed geom-first preference) so
        // the number shown to the LLM matches the altitude the rig actually points
        // at. enrichAircraft only returns entries with a usable altitude under
        // adsbAltSource, so this is never null for a scanned aircraft.
        v.altitude_m = Math.round(aircraftAltitudeM(e, cfg.adsbAltSource) ?? 0);
        return v;
      });
      return text(JSON.stringify({ ok: source.getSnapshot().ok, count: rows.length, aircraft: rows }, null, 2));
    },
  );

  server.registerTool(
    "track_aircraft",
    {
      description: "Begin tracking a specific aircraft by ICAO hex. The hex must currently be trackable (see scan_aircraft).",
      inputSchema: { hex: z.string().min(1).describe("ICAO 24-bit hex, e.g. a1b2c3") },
    },
    async ({ hex }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const { rig, R } = rigR();
      const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(),
        { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 });
      if ("error" in res) return errText(res.error);
      const wanted = hex.toLowerCase();
      const found = res.aircraft.find((e) => e.hex === wanted);
      if (!found) return errText(`aircraft ${wanted} is not currently trackable (not seen, out of range, unreachable, in the sun, or too fast)`);
      follower.bind(wanted);
      follower.onSnapshot(source.getSnapshot());   // push the first fix now (session.start)
      return text(JSON.stringify({
        tracking: wanted, callsign: found.callsign,
        azimuth_deg: Number(found.azimuthDeg.toFixed(1)),
        elevation_deg: Number(found.elevationDeg.toFixed(1)),
        range_km: Number((found.rangeM / 1000).toFixed(1)),
      }, null, 2));
    },
  );

  server.registerTool(
    "get_tracked_aircraft",
    { description: "Report which aircraft hex the follower is currently bound to (or null), and how long since its last fix.", inputSchema: {} },
    async () => {
      const s = follower.status();
      // The follower self-heals its binding on the next onSnapshot (see
      // AdsbFollower's self-heal check), which leaves a ≤1-poll window after
      // stop_tracking where the follower still reports its old hex. Gate on
      // session.isActive() here so this tool's reported state is immediately
      // consistent with a stop_tracking, without the tool reaching into the
      // follower to unbind it (that would invert the deliberate L3/L4 layering).
      const hex = session.isActive() ? s.hex : null;
      return text(JSON.stringify({
        hex, lost_ms: s.lostMs, session_active: session.isActive(), last_error: s.lastError,
      }, null, 2));
    },
  );
}
