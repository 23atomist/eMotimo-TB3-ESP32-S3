import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vec3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { velocityFromSpeedHeading } from "./track/estimator.js";
import { heightSchema } from "./geo-tools.js";
import { SunSupervisor } from "./track/supervisor.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

const latSchema = z.number().finite().min(-90).max(90).describe("target latitude, degrees");
const lonSchema = z.number().finite().min(-180).max(180).describe("target longitude, degrees");
const speedSchema = z.number().finite().nonnegative().optional()
  .describe("ground speed in meters/second (optional; derived from successive fixes if omitted)");
const headingSchema = z.number().finite().optional()
  .describe("heading in degrees, 0=North 90=East (optional; required for speed to be usable)");
const climbSchema = z.number().finite().optional()
  .describe("climb rate in meters/second, positive up (optional, default 0)");

// Null means "no velocity stated" — the estimator then derives one from
// successive fixes. A speed without a heading is not usable, so it is ignored.
function velocityFromArgs(
  speed_mps?: number, heading_deg?: number, climb_mps?: number,
): Vec3 | null {
  if (speed_mps === undefined && climb_mps === undefined) return null;
  if (speed_mps !== undefined && heading_deg === undefined) return null;
  return velocityFromSpeedHeading(speed_mps ?? 0, heading_deg ?? 0, climb_mps ?? 0);
}

export function registerTrackTools(server: McpServer, session: TrackingSession, supervisor: SunSupervisor): void {
  server.registerTool(
    "start_tracking",
    {
      description:
        "Begin continuously following a moving geographic target. Requires a solved calibration. " +
        "Returns immediately — tracking runs in the background; poll get_tracking_status.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        height_m: heightSchema("target height in meters (same datum as the rig)"),
        speed_mps: speedSchema,
        heading_deg: headingSchema,
        climb_mps: climbSchema,
        label: z.string().optional().describe("optional name for this target"),
      },
    },
    async ({ lat, lon, height_m, speed_mps, heading_deg, climb_mps, label }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const err = session.start(
        { lat, lon, height: height_m },
        velocityFromArgs(speed_mps, heading_deg, climb_mps),
        label ?? null,
      );
      if (err) return errText(err);
      return text(JSON.stringify(statusBody(session), null, 2));
    },
  );

  server.registerTool(
    "update_target",
    {
      description: "Feed a new position fix for the target being tracked. Refreshes the tracking deadman.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        height_m: heightSchema("target height in meters (same datum as the rig)"),
        speed_mps: speedSchema,
        heading_deg: headingSchema,
        climb_mps: climbSchema,
      },
    },
    async ({ lat, lon, height_m, speed_mps, heading_deg, climb_mps }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const err = session.updateTarget(
        { lat, lon, height: height_m },
        velocityFromArgs(speed_mps, heading_deg, climb_mps),
      );
      if (err) return errText(err);
      return text(JSON.stringify(statusBody(session), null, 2));
    },
  );

  server.registerTool(
    "stop_tracking",
    { description: "Stop following the target and halt all tracking motion.", inputSchema: {} },
    async () => { session.stop(); return text("tracking stopped"); },
  );

  server.registerTool(
    "get_tracking_status",
    {
      description:
        "Report the tracking session: state, target az/el/range, rig pan/tilt, measured pointing error, " +
        "commanded pan/tilt rates (and whether the soft-limit guard is holding either axis at zero), " +
        "and data staleness.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(statusBody(session), null, 2)),
  );
}

function round(v: number | null, dp: number): number | null {
  return v === null ? null : Number(v.toFixed(dp));
}

function statusBody(session: TrackingSession) {
  const s = session.status();
  return {
    state: s.state,
    reason: s.reason,
    label: s.label,
    target_azimuth_deg: round(s.targetAzimuthDeg, 2),
    target_elevation_deg: round(s.targetElevationDeg, 2),
    target_range_m: round(s.targetRangeM, 1),
    target_pan_deg: round(s.targetPanDeg, 2),
    target_tilt_deg: round(s.targetTiltDeg, 2),
    rig_pan_deg: round(s.rigPanDeg, 2),
    rig_tilt_deg: round(s.rigTiltDeg, 2),
    pointing_error_deg: round(s.pointingErrorDeg, 2),
    commanded_pan_dps: round(s.commandedPanDps, 2),
    commanded_tilt_dps: round(s.commandedTiltDps, 2),
    pan_limited: s.panLimited,
    tilt_limited: s.tiltLimited,
    target_age_ms: s.targetAgeMs,
    telemetry_age_ms: s.telemetryAgeMs,
  };
}
