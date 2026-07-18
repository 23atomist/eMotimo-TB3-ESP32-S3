import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { sunAzEl, sunEnu } from "./geo/sun.js";
import { boresightEnu } from "./track/control.js";
import { angleBetweenDeg } from "./geo/vec3.js";
import { stepsToDeg, applySign } from "./angles.js";
import { SunSupervisor } from "./track/supervisor.js";
import { text } from "./tool-helpers.js";

export function registerSunTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, supervisor: SunSupervisor,
): void {
  server.registerTool(
    "get_sun",
    { description: "Report the sun's azimuth/elevation now, the assumed UTC, and the boresight→sun separation (when calibrated). Read-only.", inputSchema: {} },
    async () => {
      const nowMs = Date.now();
      const p = store.get();
      let azimuth_deg: number | null = null;
      let elevation_deg: number | null = null;
      let boresight_separation_deg: number | null = null;
      const calibrated = store.isCalibrated();

      if (p.rig) {
        const { azDeg, elDeg } = sunAzEl(p.rig, nowMs);
        azimuth_deg = Number(azDeg.toFixed(3));
        elevation_deg = Number(elDeg.toFixed(3));
        const R = store.getOrientation();
        if (R) {
          const d = device.getState();
          const panDeg = applySign(stepsToDeg(d.panSteps), cfg.panSign);
          const tiltDeg = applySign(stepsToDeg(d.tiltSteps), cfg.tiltSign);
          const sep = angleBetweenDeg(boresightEnu(R, panDeg, tiltDeg), sunEnu(p.rig, nowMs));
          boresight_separation_deg = Number(sep.toFixed(3));
        }
      }

      const guard = supervisor.status();

      return text(JSON.stringify({
        calibrated,
        assumed_utc: new Date(nowMs).toISOString(),
        azimuth_deg,
        elevation_deg,
        above_horizon: elevation_deg === null ? null : elevation_deg > 0,
        boresight_separation_deg,
        rig_location_set: p.rig !== undefined,
        guard_state: guard.state,
        guard_reason: guard.reason,
        guard_enabled: guard.enabled,
        cone_deg: guard.coneDeg,
        park_tilt_deg: guard.parkTiltDeg,
        locked: guard.locked,
      }, null, 2));
    },
  );

  server.registerTool(
    "set_sun_guard",
    {
      description: "Enable/disable the sun guard and set its exclusion cone and park tilt. Also clears a standing sun lockout.",
      inputSchema: {
        enabled: z.boolean().optional().describe("master enable"),
        cone_deg: z.number().positive().max(90).optional().describe("exclusion half-angle around the sun"),
        park_tilt_deg: z.number().optional().describe("tilt to park at when the guard trips"),
        clear_lock: z.boolean().optional().describe("release a standing lockout (re-trips next tick if the sun is still in the cone)"),
      },
    },
    async ({ enabled, cone_deg, park_tilt_deg, clear_lock }) => {
      supervisor.setConfig({ enabled, coneDeg: cone_deg, parkTiltDeg: park_tilt_deg });
      if (clear_lock) supervisor.clearLock();
      return text(JSON.stringify(supervisor.status(), null, 2));
    },
  );
}
