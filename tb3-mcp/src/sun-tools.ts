import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { sunAzEl, sunEnu } from "./geo/sun.js";
import { boresightEnu } from "./track/control.js";
import { angleBetweenDeg } from "./geo/vec3.js";
import { stepsToDeg, applySign } from "./angles.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function registerSunTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore,
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

      return text(JSON.stringify({
        calibrated,
        assumed_utc: new Date(nowMs).toISOString(),
        azimuth_deg,
        elevation_deg,
        above_horizon: elevation_deg === null ? null : elevation_deg > 0,
        boresight_separation_deg,
        rig_location_set: p.rig !== undefined,
      }, null, 2));
    },
  );
}
