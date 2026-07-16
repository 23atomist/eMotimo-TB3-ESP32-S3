import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, degToSteps, applySign, checkPanTilt, checkSpeed, Limits } from "./angles.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function registerTools(server: McpServer, device: Device, cfg: Config): void {
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
      return text(JSON.stringify({
        connected: s.connected,
        pan_deg: Number(applySign(stepsToDeg(s.panSteps), cfg.panSign).toFixed(3)),
        tilt_deg: Number(applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign).toFixed(3)),
        aux_steps: Math.round(s.auxSteps),
        moving: s.moving,
        program_engaged: s.programEngaged,
        battery_v: s.batteryV,
        sta_ip: s.staIp,
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
      const lim = checkPanTilt(pan_deg, tilt_deg, limits);
      if (!lim.ok) return errText(lim.error!);
      const spd = checkSpeed(speed_dps, cfg.maxSpeedDps);
      if (!spd.ok) return errText(spd.error!);

      const devPan = applySign(pan_deg, cfg.panSign);
      const devTilt = applySign(tilt_deg, cfg.tiltSign);
      try {
        await device.gotoAngle(devPan, devTilt, speed_dps);
      } catch (e) {
        return errText(`device rejected goto: ${(e as Error).message}`);
      }

      const cur = device.getState();
      const distDeg = Math.max(
        Math.abs(devPan - stepsToDeg(cur.panSteps)),
        Math.abs(devTilt - stepsToDeg(cur.tiltSteps)),
      );
      const effSpeed = speed_dps ?? cfg.maxSpeedDps;
      const timeoutMs = Math.max(5000, (distDeg / effSpeed) * 1000 * 3 + 3000);

      try {
        const final = await device.waitForArrival(degToSteps(devPan), degToSteps(devTilt), timeoutMs);
        return text(JSON.stringify({
          arrived: true,
          pan_deg: Number(applySign(stepsToDeg(final.panSteps), cfg.panSign).toFixed(3)),
          tilt_deg: Number(applySign(stepsToDeg(final.tiltSteps), cfg.tiltSign).toFixed(3)),
        }));
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
    async () => { await device.stop(); return text("stopped"); },
  );

  server.registerTool(
    "set_home",
    { description: "Zero the current position as the new software home.", inputSchema: {} },
    async () => {
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
    { description: "List the 8 built-in programs and which is current.", inputSchema: {} },
    async () => text(JSON.stringify(await device.listPrograms(), null, 2)),
  );

  server.registerTool(
    "select_program",
    {
      description: "Select a built-in program (0..7). commit=true enters it (virtual C-press).",
      inputSchema: {
        index: z.number().int().min(0).max(7),
        commit: z.boolean().default(false),
      },
    },
    async ({ index, commit }) => {
      try { await device.selectProgram(index, commit); return text(`selected program ${index}${commit ? " (entered)" : ""}`); }
      catch (e) { return errText(`device rejected select_program: ${(e as Error).message}`); }
    },
  );
}
