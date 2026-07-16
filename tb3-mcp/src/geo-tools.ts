import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign } from "./angles.js";
import { CalibrationStore } from "./calibration.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function currentUserPanTilt(device: Device, cfg: Config): { panDeg: number; tiltDeg: number; moving: boolean } {
  const s = device.getState();
  return {
    panDeg: applySign(stepsToDeg(s.panSteps), cfg.panSign),
    tiltDeg: applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign),
    moving: s.moving,
  };
}

export function registerGeoTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore,
): void {
  server.registerTool(
    "set_rig_location",
    {
      description: "Set the rig's fixed geographic location (WGS84). Clears any prior sightings and calibration solution.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("rig latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("rig longitude, degrees"),
        height_m: z.number().finite().describe("rig height in meters (same datum as targets)"),
      },
    },
    async ({ lat, lon, height_m }) => {
      store.setRigLocation(lat, lon, height_m);
      return text(`rig location set to ${lat}, ${lon}, ${height_m}m; sightings cleared`);
    },
  );

  server.registerTool(
    "sight_landmark",
    {
      description: "Record the CURRENT pan/tilt as a sighting of a known landmark (aim first via the camera feed + jog). Two well-separated sightings are needed before solving.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("landmark latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("landmark longitude, degrees"),
        height_m: z.number().finite().describe("landmark height in meters (same datum as the rig)"),
        label: z.string().optional().describe("optional name for this landmark"),
      },
    },
    async ({ lat, lon, height_m, label }) => {
      if (store.get().rig === undefined) {
        return errText("set the rig location first (set_rig_location) before sighting landmarks");
      }
      const { panDeg, tiltDeg, moving } = currentUserPanTilt(device, cfg);
      const slot = store.addSighting({ lat, lon, height: height_m, label, panDeg, tiltDeg });
      const warn = moving ? " WARNING: the rig was still moving; pan/tilt may not be settled — re-sight when stopped." : "";
      return text(JSON.stringify({
        slot, pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
        note: `${slot}/2 sightings recorded.${warn}`,
      }));
    },
  );

  server.registerTool(
    "get_calibration",
    { description: "Report the current calibration profile: rig location, sightings, solved heading, timestamp, and whether it is calibrated.", inputSchema: {} },
    async () => {
      const p = store.get();
      return text(JSON.stringify({
        calibrated: store.isCalibrated(),
        rig: p.rig,
        sightings: p.sightings,
        solved_at: p.solvedAt ?? null,
      }, null, 2));
    },
  );

  server.registerTool(
    "clear_calibration",
    { description: "Erase the calibration profile (rig location, sightings, solution).", inputSchema: {} },
    async () => { store.clear(); return text("calibration cleared"); },
  );
}
