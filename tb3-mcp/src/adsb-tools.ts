import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { Geodetic } from "./geo/wgs84.js";
import { Mat3, Vec3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { enrichAircraft } from "./adsb/enrich.js";
import { AdsbSnapshot, EnrichedAircraft } from "./adsb/types.js";
import { aircraftAltitudeM } from "./adsb/convert.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";
import { TrackSector, DISABLED_SECTOR } from "./track/sector.js";
import { SectorStore } from "./sector-store.js";

const NOT_CALIBRATED = "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";

export interface ScanParams { maxRangeKm: number; onlyTrackable: boolean; limit: number; }

// maxPosAgeSec: reject an aircraft whose POSITION REPORT is already older
// than the tracking session's own staleness threshold. Offering one is a
// promise the tracker cannot keep -- since fix age started reaching the
// estimator (field 2026-07-30), a report this old makes the session declare
// the target stale on its very first tick, so the row would light up [Track]
// and then immediately fall into "waiting".
//
// Measured on this rig's feed: median seen_pos 2.8s but p90 37.8s and max
// 56.7s, so this is a large fraction of the list, not a corner case. A null
// age means the report carries no position time -- treated as unusable
// rather than fresh, since the whole point is not to trust an unknown.
//
// Default Infinity keeps every existing caller/test that passes no threshold
// on exactly the old behaviour.
export function isTrackable(e: EnrichedAircraft, maxPosAgeSec: number = Infinity): boolean {
  if (!(e.reachable === true && e.sunSafe && e.slewOk && e.inSector)) return false;
  if (!Number.isFinite(maxPosAgeSec)) return true;
  return e.seenPosSec !== null && e.seenPosSec <= maxPosAgeSec;
}

// sector and cHead both default to "as if absent" (no azimuth filter, no camera
// offset), so every existing caller and test that passes neither keeps exactly
// the legacy mapping -- see enrichAircraft. geoPanSign is not threaded
// separately; it comes from cfg.
//
// rig (location) is required for ANY output -- azimuth/elevation/range are
// pure geometry from rig position, but with no rig position there's nothing
// to compute at all. R (solved mount orientation) is required only when
// p.onlyTrackable is true: trackability is a pan/tilt-reachability question,
// meaningless without R, so that path keeps erroring exactly as before. With
// onlyTrackable false, R may be null -- enrichAircraft degrades reachable/
// estTrackSec to null (unknown) rather than false, which is exactly what the
// pre-calibration aircraft picker needs: a plane list with real bearings, no
// pointing claims. This is a strict widening -- rig && R still yields the
// same result as before.
export function scanAircraft(
  snap: AdsbSnapshot, rig: Geodetic | null, R: Mat3 | null,
  cfg: Config, nowMs: number, p: ScanParams,
  sector: TrackSector = DISABLED_SECTOR,
  cHead: Vec3 = [0, 1, 0],
): { error: string } | { aircraft: EnrichedAircraft[] } {
  if (!rig) return { error: NOT_CALIBRATED };
  if (p.onlyTrackable && !R) return { error: NOT_CALIBRATED };
  const maxRangeM = p.maxRangeKm * 1000;
  const enriched = snap.aircraft
    .map((a) => enrichAircraft(a, rig, R, cfg, nowMs, sector, cHead))
    .filter((e): e is EnrichedAircraft => e !== null)
    .filter((e) => e.rangeM <= maxRangeM)
    .filter((e) => !p.onlyTrackable || isTrackable(e, cfg.trackMaxTargetAgeMs / 1000))
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
    reachable: e.reachable, sun_safe: e.sunSafe, slew_ok: e.slewOk, in_sector: e.inSector,
  };
}

export function registerAdsbTools(
  server: McpServer, source: AdsbSource, follower: AdsbFollower,
  store: CalibrationStore, cfg: Config, session: TrackingSession, supervisor: SunSupervisor,
  sectorStore: SectorStore,
  // Operator-set trackability bound (range-store.ts), read fresh per call so a
  // set_track_range takes effect immediately rather than at the next restart --
  // same contract as sectorStore above. Defaulted to cfg.trackMaxRangeKm so
  // callers/tests predating it keep their exact prior behavior.
  rangeStore: { get(): number } = { get: () => cfg.trackMaxRangeKm },
): void {
  const rigR = (): { rig: Geodetic | null; R: Mat3 | null } => {
    const p = store.get();
    return { rig: p.rig ?? null, R: store.getOrientation() ?? null };
  };
  // Camera-offset model, sourced the same way as point_at/point_at_azel: no
  // gravity calibration yet -> forward-only cHead, the no-op default.
  const cHead = (): Vec3 => store.getCHead() ?? [0, 1, 0];

  server.registerTool(
    "scan_aircraft",
    {
      description:
        "List aircraft seen via ADS-B, enriched with rig-relative azimuth/elevation/range and the " +
        "objective trackable flags (reachable, sun_safe, slew_ok, in_sector). in_sector reflects the " +
        "current tracking azimuth sector (see get_track_sector/set_track_sector); disabled means every " +
        "azimuth counts. Defaults to only the trackable ones, sorted nearest-first. Interestingness is " +
        "the caller's judgement. Before the rig's mount orientation is solved, only_trackable:true still " +
        "requires calibration and errors; only_trackable:false works with just a rig location set and " +
        "returns azimuth/elevation/range/identity for every plane seen, with reachable and est_track_sec " +
        "as null (unknown, not false) since pointing can't be evaluated yet -- use this to pick a plane " +
        "to sight for sight_aircraft.",
      inputSchema: {
        max_range_km: z.number().positive().optional().describe(`max slant range in km (default: the operator-set track range, currently ${rangeStore.get()})`),
        only_trackable: z.boolean().optional().describe("only aircraft that are reachable, sun-safe, and within slew rate (default true); requires calibration"),
        limit: z.number().int().positive().max(100).optional().describe("max rows (default 20)"),
      },
    },
    async ({ max_range_km, only_trackable, limit }) => {
      const { rig, R } = rigR();
      const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(), {
        maxRangeKm: max_range_km ?? rangeStore.get(),
        onlyTrackable: only_trackable ?? true,
        limit: limit ?? 20,
      }, sectorStore.get(), cHead());
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
        { maxRangeKm: rangeStore.get(), onlyTrackable: true, limit: 1000 }, sectorStore.get(), cHead());
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
