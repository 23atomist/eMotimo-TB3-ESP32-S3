import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign, Limits } from "./angles.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "./track/session.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function registerTools(
  server: McpServer, device: Device, cfg: Config, session: TrackingSession,
): void {
  const limits: Limits = {
    panMin: cfg.panMin, panMax: cfg.panMax,
    tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
    maxSpeedDps: cfg.maxSpeedDps,
  };

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
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      try {
        const result = await moveToUserAngle(device, cfg, pan_deg, tilt_deg, speed_dps);
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
      inputSchema: {
        pan_dps: z.number().describe("pan rate in degrees/second (approx)"),
        tilt_dps: z.number().describe("tilt rate in degrees/second (approx)"),
        aux: z.number().optional().describe("aux axis rate, -100..100 joystick units"),
        duration_ms: z.number().int().positive().max(30000).describe("how long to jog, milliseconds"),
      },
    },
    async ({ pan_dps, tilt_dps, aux, duration_ms }) => {
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      const x = clamp(Math.round((pan_dps / cfg.maxJogDps) * 100 * cfg.panSign), -100, 100);
      const y = clamp(Math.round((tilt_dps / cfg.maxJogDps) * 100 * cfg.tiltSign), -100, 100);
      const a = clamp(Math.round((aux ?? 0) * cfg.auxSign), -100, 100);
      await device.jog(x, y, a, duration_ms);
      return text(`jogged for ${duration_ms}ms (joy x=${x} y=${y} aux=${a})`);
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
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      try { await device.setHome(); return text("home set to current position"); }
      catch (e) { return errText(`device rejected set_home: ${(e as Error).message}`); }
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
        // time that table grew -- most recently keeping WEBTRACK (8) rejected
        // at this boundary, so the daemon could not enter the Track (Web) mode
        // built for it. The real bound is derived per call from the device's
        // own /api/program listing below; the firmware bounds-checks again.
        index: z.number().int().min(0),
        commit: z.boolean().default(false),
      },
    },
    async ({ index, commit }) => {
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
}
