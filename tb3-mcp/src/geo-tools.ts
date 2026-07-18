import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign } from "./angles.js";
import { CalibrationStore } from "./calibration.js";
import { Geodetic, enuDirection, azElRange, geodeticToEcef } from "./geo/wgs84.js";
import { solveOrientation, enuToPanTilt, separationDeg, resolvePanInRange } from "./geo/orientation.js";
import { panTiltToMount } from "./geo/boresight.js";
import { Vec3, Mat3, deg2rad, sub, norm } from "./geo/vec3.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";

const SUN_LOCKED_MSG = "sun guard active; blocked to protect the camera — clear it with set_sun_guard";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

// Sane band for WGS84 heights: comfortably covers below-sea-level basins
// through mountain peaks, aircraft, drones, and near-space balloon altitudes.
const MIN_HEIGHT_M = -1000;
const MAX_HEIGHT_M = 100_000;
const HEIGHT_RANGE_MSG = `height_m must be between ${MIN_HEIGHT_M} and ${MAX_HEIGHT_M} meters`;

export function heightSchema(description: string) {
  return z.number().finite()
    .min(MIN_HEIGHT_M, HEIGHT_RANGE_MSG)
    .max(MAX_HEIGHT_M, HEIGHT_RANGE_MSG)
    .describe(description);
}

// Below this rig→point range, the ENU direction vector is degenerate (the
// point coincides with the rig) and enuDirection/normalize would throw an
// opaque "cannot normalize a zero-length vector" error.
const MIN_RANGE_M = 1e-3;

function rangeM(a: Geodetic, b: Geodetic): number {
  return norm(sub(geodeticToEcef(b), geodeticToEcef(a)));
}

function currentUserPanTilt(device: Device, cfg: Config): { panDeg: number; tiltDeg: number; moving: boolean } {
  const s = device.getState();
  return {
    panDeg: applySign(stepsToDeg(s.panSteps), cfg.panSign),
    tiltDeg: applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign),
    moving: s.moving,
  };
}

// Resolve pan into range (trying ±360°), then verify tilt is reachable.
// Returns the movable pan/tilt, or an { error } message.
export function reachablePanTilt(
  panDeg: number, tiltDeg: number,
  panMin: number, panMax: number, tiltMin: number, tiltMax: number,
): { pan: number; tilt: number } | { error: string } {
  const pan = resolvePanInRange(panDeg, panMin, panMax);
  if (pan === null) {
    return { error: `computed pan ${panDeg.toFixed(2)}° is outside the reachable pan range [${panMin}, ${panMax}] (even after ±360°)` };
  }
  if (tiltDeg < tiltMin || tiltDeg > tiltMax) {
    return { error: `computed tilt ${tiltDeg.toFixed(2)}° is outside the reachable tilt range [${tiltMin}, ${tiltMax}] — target is below the horizon or too high` };
  }
  return { pan, tilt: tiltDeg };
}

export function registerGeoTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor,
): void {
  server.registerTool(
    "set_rig_location",
    {
      description: "Set the rig's fixed geographic location (WGS84). Clears any prior sightings and calibration solution.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("rig latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("rig longitude, degrees"),
        height_m: heightSchema("rig height in meters (same datum as targets)"),
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
        height_m: heightSchema("landmark height in meters (same datum as the rig)"),
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

  server.registerTool(
    "solve_calibration",
    { description: "Solve the mount orientation from the two recorded sightings (TRIAD). Reports heading, base tilt, and landmark separation; persists the solution.", inputSchema: {} },
    async () => {
      const p = store.get();
      if (p.rig === undefined) return errText("set the rig location first (set_rig_location)");
      if (p.sightings.length < 2) return errText(`need two sightings to solve; have ${p.sightings.length}`);

      const rig: Geodetic = p.rig;
      const [sa, sb] = p.sightings;
      const landmarkA: Geodetic = { lat: sa.lat, lon: sa.lon, height: sa.height };
      const landmarkB: Geodetic = { lat: sb.lat, lon: sb.lon, height: sb.height };
      if (rangeM(rig, landmarkA) < MIN_RANGE_M) {
        return errText(`landmark "${sa.label ?? "A"}" coincides with the rig location — cannot compute a direction; re-sight a real landmark`);
      }
      if (rangeM(rig, landmarkB) < MIN_RANGE_M) {
        return errText(`landmark "${sb.label ?? "B"}" coincides with the rig location — cannot compute a direction; re-sight a real landmark`);
      }
      const enuA = enuDirection(rig, landmarkA).unit;
      const enuB = enuDirection(rig, landmarkB).unit;
      const mountA = panTiltToMount(sa.panDeg, sa.tiltDeg);
      const mountB = panTiltToMount(sb.panDeg, sb.tiltDeg);

      const sep = separationDeg(enuA, enuB);
      const R = solveOrientation(mountA, enuA, mountB, enuB);
      store.setOrientation(R, new Date().toISOString());

      // Heading = ENU azimuth the boresight points at pan=0,tilt=0, i.e. the
      // direction of the mount-forward (+Y) axis = second column of R.
      const headingUnit = matForward(R);
      let heading = (Math.atan2(headingUnit[0], headingUnit[1]) * 180) / Math.PI;
      if (heading < 0) heading += 360;
      // Base tilt = how far the mount-up (+Z) axis leans from true vertical
      // (0 if the tripod is perfectly level) = third column of R.
      const upUnit = matUp(R);
      const baseTilt = 90 - (Math.asin(Math.max(-1, Math.min(1, upUnit[2]))) * 180) / Math.PI;

      const warn = sep < 15 ? " WARNING: landmarks are close together — the solution is ill-conditioned; choose landmarks farther apart in azimuth." : "";
      return text(JSON.stringify({
        heading_deg: Number(heading.toFixed(2)),
        base_tilt_deg: Number(baseTilt.toFixed(2)),
        separation_deg: Number(sep.toFixed(1)),
        note: `solved from 2 sightings.${warn}`,
      }));
    },
  );

  server.registerTool(
    "point_at",
    {
      description: "Point the rig at a geographic target (WGS84 lat/lon/height). Requires a solved calibration. Blocks until arrival.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("target latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("target longitude, degrees"),
        height_m: heightSchema("target height in meters (same datum as the rig)"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ lat, lon, height_m, speed_dps }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      if (!store.isCalibrated()) return errText("not calibrated — set_rig_location, sight two landmarks, then solve_calibration");
      const rig = store.get().rig!;
      const target: Geodetic = { lat, lon, height: height_m };
      if (rangeM(rig, target) < MIN_RANGE_M) {
        return errText("target coincides with the rig location — cannot compute a pointing direction");
      }
      const { unit } = enuDirection(rig, target);
      const R = store.getOrientation()!;
      const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
      const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
      if ("error" in reach) return errText(reach.error);
      const azel = azElRange(rig, target);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps);
        return text(JSON.stringify({
          azimuth_deg: Number(azel.azimuth.toFixed(2)),
          elevation_deg: Number(azel.elevation.toFixed(2)),
          range_m: Math.round(azel.range),
          pan_deg: moved.pan_deg,
          tilt_deg: moved.tilt_deg,
        }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  server.registerTool(
    "point_at_azel",
    {
      description: "Point the rig at an absolute azimuth/elevation (degrees), bypassing geo. Requires a solved calibration.",
      inputSchema: {
        azimuth_deg: z.number().describe("azimuth from true north, degrees (0=N, 90=E)"),
        elevation_deg: z.number().min(-90).max(90).describe("elevation above horizontal, degrees"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ azimuth_deg, elevation_deg, speed_dps }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      if (!store.isCalibrated()) return errText("not calibrated — set_rig_location, sight two landmarks, then solve_calibration");
      const az = deg2rad(azimuth_deg), el = deg2rad(elevation_deg);
      const unit: Vec3 = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
      const R = store.getOrientation()!;
      const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
      const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
      if ("error" in reach) return errText(reach.error);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps);
        return text(JSON.stringify({ pan_deg: moved.pan_deg, tilt_deg: moved.tilt_deg }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );
}

// The mount-forward (+Y) axis image in ENU = second column of R.
function matForward(R: Mat3): Vec3 { return [R[0][1], R[1][1], R[2][1]]; }
// The mount-up (+Z) axis image in ENU = third column of R.
function matUp(R: Mat3): Vec3 { return [R[0][2], R[1][2], R[2][2]]; }
