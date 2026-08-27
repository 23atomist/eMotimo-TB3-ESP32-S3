import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign } from "./angles.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { CalibrationStore } from "./calibration.js";
import { CaptureController } from "./capture/controller.js";
import { PassJournal } from "./capture/pass-journal.js";
import { LimitsStore, effectiveLimits, CeilingLimits } from "./limits-store.js";
import { limitGuard, GuardHorizon } from "./track/control.js";
import { currentUserPanTilt } from "./geo-tools.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Exported so callers other than registerTool below (the dashboard's
// jog-hold.js release payload, and its test) can validate a candidate jog
// payload against the REAL schema instead of a hand-copied one that could
// silently drift from it.
//
// duration_ms allows 0 as an explicit "stop now": device.jog()'s tick count
// is Math.ceil(duration_ms / JOG_KEEPALIVE_MS), so duration_ms:0 is zero
// ticks -- the keep-alive loop body never runs, and clearJog() fires
// immediately after the single setJogVector() call with NO `await` between
// them (see device.ts's jog()). That means even a duration_ms:0 call with
// non-zero rates cannot leave a non-zero vector live for any real time --
// the one non-zero frame that reaches the device (proven harmless by
// test/device-jog.test.ts's "jog(duration=0)" case) is overwritten by the
// trailing zero before the event loop ever turns, so it is bounded, not an
// unbounded move. This is what lets the dashboard's press-and-hold jog
// (dashboard/public/jog-hold.js) post a genuine (0,0,0) stop vector on
// release instead of riding out the last pulse's duration_ms.
export const jogArgsShape = {
  pan_dps: z.number().describe("pan rate in degrees/second (approx)"),
  tilt_dps: z.number().describe("tilt rate in degrees/second (approx)"),
  aux: z.number().optional().describe("aux axis rate, -100..100 joystick units"),
  duration_ms: z.number().int().nonnegative().max(30000)
    .describe("how long to jog, milliseconds; 0 stops immediately (zero-rate vector, cleared right away)"),
};

export function registerTools(
  server: McpServer, device: Device, cfg: Config, session: TrackingSession,
  supervisor: SunSupervisor, store: CalibrationStore, capture: CaptureController,
  limitsStore: LimitsStore, journal: PassJournal,
): void {
  const cfgCeiling: CeilingLimits = {
    panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
  };
  // The effective (taught-or-config) range, re-read on every call: a
  // teach_limit/clear_taught_limits between two jog/goto_angle calls must
  // take effect on the very next one, not require a daemon restart.
  const effLimits = (): CeilingLimits => effectiveLimits(cfgCeiling, limitsStore.get());

  server.registerTool(
    "get_status",
    { description: "Read the TB3's current position (degrees), motion, battery, program, and connectivity.", inputSchema: {} },
    async () => {
      const s = device.getState();
      const lastUpdateAgeMs = s.lastUpdateMs === 0 ? null : Date.now() - s.lastUpdateMs;
      const stale = !s.connected || (s.lastUpdateMs !== 0 && Date.now() - s.lastUpdateMs > 2000);
      return text(JSON.stringify({
        connected: s.connected,
        pan_deg: Number(applySign(stepsToDeg(s.panSteps), cfg.panSign).toFixed(3)),
        tilt_deg: Number(applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign).toFixed(3)),
        aux_steps: Math.round(s.auxSteps),
        moving: s.moving,
        program_engaged: s.programEngaged,
        battery_v: s.batteryV,
        sta_ip: s.staIp,
        last_update_age_ms: lastUpdateAgeMs,
        stale,
      }, null, 2));
    },
  );

  server.registerTool(
    "goto_angle",
    {
      description: "Move to an absolute pan/tilt angle in degrees (user frame). Blocks until arrival.",
      inputSchema: {
        pan_deg: z.number().describe("absolute pan angle in degrees"),
        tilt_deg: z.number().describe("absolute tilt angle in degrees"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ pan_deg, tilt_deg, speed_dps }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      try {
        const result = await moveToUserAngle(device, cfg, pan_deg, tilt_deg, speed_dps, effLimits());
        return text(JSON.stringify(result));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  server.registerTool(
    "jog",
    {
      description: "Nudge the rig at a rate for a fixed duration (manual framing). Rate is approximate.",
      inputSchema: jogArgsShape,
    },
    async ({ pan_dps, tilt_dps, aux, duration_ms }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      // SAFETY: rate jog is the one motion path with no endstop and no other
      // gate between "commanded rate" and the hardware — goto_angle checks
      // limits before ever moving, and tracking has its own limitGuard
      // (track/control.ts), but a rate command here previously reached
      // device.jog() completely unchecked. Press-and-hold and the joystick
      // both post through this exact tool (see dashboard/public/jog-hold.js
      // and joystick-hold.js's module docs — both route through
      // /api/control/jog -> this "jog" tool), so guarding here covers both.
      //
      // Reuses the SAME predict-then-block pattern tracking already uses
      // (limitGuard): predict where this rate takes each axis over the
      // command's own duration, and zero only the axis that would leave the
      // effective range. limitGuard's math already allows motion AWAY from a
      // limit (the prediction lands back inside the range) — it never traps
      // the operator at a stop with no way back.
      const rig = currentUserPanTilt(device, cfg);
      const horizon: GuardHorizon = { panMs: duration_ms, tiltMs: duration_ms };
      const guarded = limitGuard(
        { panDps: pan_dps, tiltDps: tilt_dps }, rig.panDeg, rig.tiltDeg, effLimits(), horizon,
      );
      const x = clamp(Math.round((guarded.out.panDps / cfg.maxJogDps) * 100 * cfg.panSign), -100, 100);
      const y = clamp(Math.round((guarded.out.tiltDps / cfg.maxJogDps) * 100 * cfg.tiltSign), -100, 100);
      const a = clamp(Math.round((aux ?? 0) * cfg.auxSign), -100, 100);
      await device.jog(x, y, a, duration_ms);
      // Surfaced so "I stopped because I'm at the limit" is distinguishable
      // from "the control is broken" — silence here is what makes an operator
      // push harder into a stop instead of backing off.
      const held: string[] = [];
      if (guarded.panBlocked) held.push("pan");
      if (guarded.tiltBlocked) held.push("tilt");
      const limitNote = held.length > 0 ? ` — held at travel limit: ${held.join(", ")}` : "";
      return text(`jogged for ${duration_ms}ms (joy x=${x} y=${y} aux=${a})${limitNote}`);
    },
  );

  server.registerTool(
    "stop",
    { description: "Immediately stop all motion.", inputSchema: {} },
    async () => { session.stop(); await device.stop(); return text("stopped"); },
  );

  server.registerTool(
    "set_home",
    { description: "Zero the current position as the new software home.", inputSchema: {} },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      try {
        await device.setHome();
        store.invalidateCalibration();
        // Taught travel limits are captured positions relative to the
        // software zero, exactly like calibration's orientation/sightings —
        // re-zeroing invalidates them the same way, for the same reason.
        limitsStore.clear();
        return text(
          "home set — calibration cleared (R was tied to the old zero) and taught travel limits cleared " +
          "(they were relative to the old zero too); re-calibrate and re-teach before pointing/jogging near the stops",
        );
      } catch (e) { return errText(`device rejected set_home: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "trigger_camera",
    {
      description: "Fire the camera shutter or focus for a duration.",
      inputSchema: {
        action: z.enum(["shoot", "focus"]),
        ms: z.number().int().positive().max(30000).default(150),
      },
    },
    async ({ action, ms }) => { await device.triggerCamera(action, ms); return text(`camera ${action} for ${ms}ms`); },
  );

  server.registerTool(
    "list_programs",
    { description: "List the built-in programs and which is current.", inputSchema: {} },
    async () => text(JSON.stringify(await device.listPrograms(), null, 2)),
  );

  server.registerTool(
    "select_program",
    {
      description:
        "Select a built-in program by 0-based index (call list_programs for the valid range " +
        "and names). commit=true enters it (virtual C-press).",
      inputSchema: {
        // Deliberately NO hardcoded upper bound. The firmware's menu table
        // (MENU_OPTIONS, src/TB3_Black_109_Release1.ino) is the only authority
        // on how many programs exist, and a literal here has gone stale every
        // time that table CHANGED -- it once kept WEBTRACK rejected at this
        // boundary when the table grew, and the table has since SHRUNK to a
        // single entry (Track (Web)) as the shooting programs were removed
        // from the firmware. Deriving the bound per call from the device's own
        // /api/program listing is what makes this survive both directions;
        // the firmware bounds-checks again.
        index: z.number().int().min(0),
        commit: z.boolean().default(false),
      },
    },
    async ({ index, commit }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      try {
        const { names } = await device.listPrograms();
        if (index >= names.length) {
          return errText(`index must be 0..${names.length - 1} (device reports ${names.length} programs)`);
        }
        await device.selectProgram(index, commit);
        return text(`selected program ${index}${commit ? " (entered)" : ""}`);
      } catch (e) { return errText(`device rejected select_program: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "get_capture_status",
    {
      description:
        "Recording/snapshot state: whether auto capture is on, whether the recorder is open, " +
        "the current pass ICAO, and the last snapshot or error.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(capture.status(), null, 2)),
  );

  server.registerTool(
    "set_capture_mode",
    {
      description: "Enable or disable automatic capture on track lock.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      capture.setAuto(enabled);
      return text(`auto capture ${enabled ? "enabled" : "disabled"}`);
    },
  );

  server.registerTool(
    "capture_snapshot",
    {
      description: "Take one snapshot now, independent of tracking state.",
      inputSchema: { icao: z.string().optional() },
    },
    async ({ icao }) => {
      const p = await capture.manualSnapshot(icao);
      return text(`snapshot written to ${p}`);
    },
  );

  server.registerTool(
    "start_recording",
    { description: "Manually open the recording valve.", inputSchema: {} },
    async () => { await capture.setRecording(true); return text("recording started"); },
  );

  server.registerTool(
    "stop_recording",
    { description: "Manually close the recording valve.", inputSchema: {} },
    async () => { await capture.setRecording(false); return text("recording stopped"); },
  );

  server.registerTool(
    "list_passes",
    {
      description:
        "List recorded tracking passes with identity, framing geometry and tracking quality. Newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(2000).optional().describe("max rows (default 500)"),
      },
    },
    async ({ limit }) => {
      const all = journal.list();
      const rows = all.slice(-(limit ?? 500)).reverse();
      return text(JSON.stringify({ count: rows.length, total: all.length, passes: rows }, null, 2));
    },
  );
}
