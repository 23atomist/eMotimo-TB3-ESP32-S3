import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vec3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { velocityFromSpeedHeading } from "./track/estimator.js";
import { heightSchema } from "./geo-tools.js";
import { SunSupervisor } from "./track/supervisor.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";
import { AimTrimStore } from "./aim-trim-store.js";

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

export function registerTrackTools(
  server: McpServer, session: TrackingSession, supervisor: SunSupervisor,
  // Defaulted so callers/tests predating the standing trim keep compiling;
  // when absent the trim tools report/refuse rather than pretending.
  trimStore?: AimTrimStore,
): void {
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
    "park_idle",
    {
      description:
        "Point the rig up to the idle park position when there is nothing to track, so it does not sit " +
        "wherever the last pass ended -- often the horizon, and the neighbours' windows. Refuses while " +
        "sun-locked (the sun park always wins, unconditionally) or while a tracking session is active. " +
        "Idempotent: a no-op once already parked, so it is safe to call on every idle tick.",
      inputSchema: {},
    },
    async () => { await supervisor.parkIdle(); return text("idle park requested"); },
  );

  server.registerTool(
    "get_tracking_status",
    {
      description:
        "Report the tracking session: state, target az/el/range, rig pan/tilt, measured pointing error, " +
        "commanded pan/tilt rates (and whether the soft-limit guard is holding either axis at zero), " +
        "the standing operator aim-offset, and data staleness.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(statusBody(session), null, 2)),
  );

  server.registerTool(
    "nudge_aim_offset",
    {
      description:
        "Adjust the standing aim-offset applied to the tracking setpoint by a small delta (degrees). " +
        "While tracking, the rig servos to target+offset and HOLDS it there — once a plane is tracked " +
        "(and so nearly stationary in frame), nudge until it is centred; the resulting offset IS the " +
        "measured drift-calibration error (record it with sight_aircraft next). Clamped to a few degrees " +
        "(a bug/typo cannot produce an unbounded slew); the offset still passes through every pan/tilt " +
        "limit, the sun guard, and E-STOP exactly like an unshifted target does. Resets to zero on every " +
        "new start_tracking/track_aircraft. This is the same small, mechanical interface a future " +
        "automatic (vision-based) corrector would drive.",
      inputSchema: {
        delta_pan_deg: z.number().finite().describe("pan correction to add, degrees"),
        delta_tilt_deg: z.number().finite().describe("tilt correction to add, degrees"),
      },
    },
    async ({ delta_pan_deg, delta_tilt_deg }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const offset = session.nudgeOffset(delta_pan_deg, delta_tilt_deg);
      // Report the clamp. Without this the offset silently stops moving while
      // the operator keeps nudging and the plane stays off-centre, with no way
      // to tell "I have run out of trim" from "this control is broken" --
      // exactly the failure reported from the field on 2026-07-29. If this
      // fires, the pointing seed itself is too far off to trim around: either
      // raise maxAimOffsetDeg or re-run set_north_zero.
      const clamped = offset.panClamped || offset.tiltClamped;
      return text(JSON.stringify({
        offset_pan_deg: Number(offset.panDeg.toFixed(3)),
        offset_tilt_deg: Number(offset.tiltDeg.toFixed(3)),
        clamped,
        pan_clamped: offset.panClamped,
        tilt_clamped: offset.tiltClamped,
        max_offset_deg: offset.maxDeg,
        ...(clamped ? { note: `aim offset is at its ±${offset.maxDeg}° limit — the pointing seed is off by more than the trim can absorb; re-run set_north_zero or raise maxAimOffsetDeg` } : {}),
      }));
    },
  );

  server.registerTool(
    "get_aim_offset",
    { description: "Report the current tracking aim-offset (degrees). Read-only.", inputSchema: {} },
    async () => {
      const offset = session.getOffset();
      return text(JSON.stringify({
        offset_pan_deg: Number(offset.panDeg.toFixed(3)),
        offset_tilt_deg: Number(offset.tiltDeg.toFixed(3)),
      }));
    },
  );

  server.registerTool(
    "set_aim_trim",
    {
      description:
        "Save a STANDING aim trim that every future tracking pass starts from, instead of starting at zero. " +
        "This is the fixed camera-boresight correction the operator would otherwise re-dial on every single " +
        "plane. Call with no arguments to adopt whatever aim-offset is currently dialled in (nudge until the " +
        "target is centred, then save it); or pass explicit degrees. Clamped to the same few-degree ceiling as " +
        "nudge_aim_offset. Takes effect on the NEXT pass. This is an operator trim, not a calibration: once " +
        "enough well-spread sightings let solve_calibration identify the camera offset properly, clear it.",
      inputSchema: {
        pan_deg: z.number().finite().optional().describe("standing pan trim, degrees (default: the live aim-offset)"),
        tilt_deg: z.number().finite().optional().describe("standing tilt trim, degrees (default: the live aim-offset)"),
      },
    },
    async ({ pan_deg, tilt_deg }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (!trimStore) return errText("standing aim trim is not configured on this server");
      const live = session.getOffset();
      const saved = trimStore.set({
        panDeg: pan_deg ?? live.panDeg,
        tiltDeg: tilt_deg ?? live.tiltDeg,
      });
      return text(JSON.stringify({
        trim_pan_deg: Number(saved.panDeg.toFixed(3)),
        trim_tilt_deg: Number(saved.tiltDeg.toFixed(3)),
        note: "saved — every new tracking pass now starts from this trim. The CURRENT pass is unchanged.",
      }));
    },
  );

  server.registerTool(
    "get_aim_trim",
    { description: "Report the standing aim trim every tracking pass starts from. Read-only.", inputSchema: {} },
    async () => {
      const t = trimStore?.get() ?? { panDeg: 0, tiltDeg: 0 };
      return text(JSON.stringify({
        trim_pan_deg: Number(t.panDeg.toFixed(3)),
        trim_tilt_deg: Number(t.tiltDeg.toFixed(3)),
        configured: trimStore !== undefined,
      }));
    },
  );

  server.registerTool(
    "clear_aim_trim",
    { description: "Zero the standing aim trim, so tracking passes start from no correction again.", inputSchema: {} },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (!trimStore) return errText("standing aim trim is not configured on this server");
      trimStore.clear();
      return text("standing aim trim cleared");
    },
  );

  server.registerTool(
    "clear_aim_offset",
    {
      description:
        "Reset the tracking aim-offset back to the standing aim trim (see set_aim_trim), or to zero when no trim is set.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      session.clearOffset();
      return text("aim offset reset to the standing trim");
    },
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
    coasting: s.coasting,
    offset_pan_deg: round(s.offsetPanDeg, 3),
    offset_tilt_deg: round(s.offsetTiltDeg, 3),
  };
}
