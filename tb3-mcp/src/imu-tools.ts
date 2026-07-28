import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { moveToUserAngle } from "./move.js";
import { solveImuMounting, GravitySample, dBaseFromGravity, solveNorthZero } from "./geo/imu-orientation.js";
import { Vec3 } from "./geo/vec3.js";
import { currentUserPanTilt } from "./geo-tools.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

export interface SweepPosition { panDeg: number; tiltDeg: number; }

// Diverse pan+tilt geometry so R_s is well-conditioned (the sweep MUST span both
// axes — clustering near the horizon leaves R_s under-constrained). Matches the
// characterization geometry used to validate the solve.
export const SWEEP_POSITIONS: SweepPosition[] = [
  { panDeg: -102, tiltDeg: 0 }, { panDeg: -102, tiltDeg: 25 }, { panDeg: -102, tiltDeg: -25 },
  { panDeg: -65, tiltDeg: 10 }, { panDeg: -140, tiltDeg: 10 }, { panDeg: -65, tiltDeg: -15 },
  { panDeg: -140, tiltDeg: 25 },
];

export interface CharacterizeDeps {
  positions: SweepPosition[];
  geoPanSign: number;
  samplesPerPos: number;
  moveTo: (panDeg: number, tiltDeg: number) => Promise<void>;
  getGravity: (n: number) => Promise<Vec3>;
  store: CalibrationStore;
  isSunLocked: () => boolean;
}

export async function runCharacterizeImu(deps: CharacterizeDeps): Promise<{ rmsDeg: number; residualsDeg: number[] }> {
  const samples: GravitySample[] = [];
  for (const p of deps.positions) {
    // The background sun supervisor can trip mid-sweep (this dwells for minutes
    // across widely-spaced postures) and cannot abort an in-flight leg itself —
    // re-check before every leg, not just once up front. setImuMounting only
    // runs after the full sweep + solve below, so aborting here persists
    // nothing: no partial R_s ever reaches the store.
    if (deps.isSunLocked()) throw new Error("sun guard locked mid-sweep — aborting characterize_imu");
    await deps.moveTo(p.panDeg, p.tiltDeg);
    const gravity = await deps.getGravity(deps.samplesPerPos);
    samples.push({ panDeg: p.panDeg, tiltDeg: p.tiltDeg, gravity });
  }
  const { rS, dBase, residualsDeg, rmsDeg } = solveImuMounting(samples, deps.geoPanSign);
  deps.store.setImuMounting(rS, dBase);
  return { rmsDeg, residualsDeg };
}

export function registerImuTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, supervisor: SunSupervisor,
  session: TrackingSession,
): void {
  server.registerTool(
    "characterize_imu",
    {
      description: "Sweep the rig through a fixed pan+tilt geometry, read gravity at each, and solve the one-time IMU→head mounting (R_s). Needed once while the IMU stays bolted on; persists R_s for gravity-anchored calibration. Motion tool — respects limits, sun guard, deadman.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) return errText("tracking active; stop_tracking first");
      try {
        const res = await runCharacterizeImu({
          positions: SWEEP_POSITIONS,
          geoPanSign: cfg.geoPanSign,
          samplesPerPos: 100,
          moveTo: async (p, t) => { await moveToUserAngle(device, cfg, p, t); },
          getGravity: (n) => device.getGravity(n),
          store,
          isSunLocked: () => supervisor.isSunLocked(),
        });
        return text(JSON.stringify({
          note: `IMU mounting solved from ${SWEEP_POSITIONS.length} positions`,
          rms_deg: Number(res.rmsDeg.toFixed(2)),
          warn: res.rmsDeg > 3 ? "high residual — the IMU mounting may have shifted or the sweep was too clustered; re-run." : undefined,
        }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  // Movement tolerance around the gravity burst read, same value and
  // rationale as solve_calibration's gravity-anchored path (geo-tools.ts):
  // the burst takes multiple seconds, and a mount that moved during it would
  // silently pair a stale posture with the gravity sample.
  const MOVE_TOL_DEG = 0.5;

  server.registerTool(
    "set_north_zero",
    {
      description:
        "Declare the rig's CURRENT pointing as true north, level (azimuth 0°, elevation 0°), and combine " +
        "that with the characterized IMU mounting (characterize_imu) to produce a complete but " +
        "PROVISIONAL orientation — a seed for drift calibration, NOT a solved calibration (get_calibration " +
        "and the dashboard mark it 'provisional'; point_at/point_at_azel still refuse until a real " +
        "solve_calibration runs). Point the rig at TRUE north before calling — magnetic north differs by " +
        "roughly 10–11° East at this site — but a rough heading is fine: the drift-calibration loop " +
        "(track an aircraft, nudge the aim with nudge_aim_offset until it's centred, then sight_aircraft) " +
        "measures and removes whatever heading error this leaves. Requires characterize_imu to have run. " +
        "Refuses if the rig is moving (the gravity read must be taken at a settled posture).",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) return errText("tracking active; stop_tracking first");
      const imu = store.getImuMounting();
      if (!imu) return errText("run characterize_imu first — set_north_zero needs the IMU mounting solve (R_s)");

      const before = currentUserPanTilt(device, cfg);
      let gravity: Vec3;
      try {
        gravity = await device.getGravity(100);
      } catch (e) {
        return errText(`gravity read failed: ${(e as Error).message}`);
      }
      // Same before/after-plus-moving guard as solve_calibration's gravity
      // path: the burst read takes real time, and a mount that moved during
      // or around it must not silently pair a stale posture with the sample.
      const after = currentUserPanTilt(device, cfg);
      if (
        before.moving || after.moving ||
        Math.abs(before.panDeg - after.panDeg) > MOVE_TOL_DEG ||
        Math.abs(before.tiltDeg - after.tiltDeg) > MOVE_TOL_DEG
      ) {
        return errText("the rig moved during the gravity read — hold the mount still and re-run set_north_zero");
      }

      const dBase = dBaseFromGravity(imu.rS, after.panDeg, after.tiltDeg, gravity, cfg.geoPanSign);
      const R = solveNorthZero(dBase, after.panDeg, after.tiltDeg, cfg.geoPanSign);
      const solvedAtIso = new Date().toISOString();
      store.setProvisionalOrientation(R, solvedAtIso);

      return text(JSON.stringify({
        provisional: true,
        pan_deg: Number(after.panDeg.toFixed(3)),
        tilt_deg: Number(after.tiltDeg.toFixed(3)),
        note:
          "PROVISIONAL orientation set from the current pointing = true north, level. This is a seed for " +
          "drift calibration, not a solved calibration — track_aircraft/start_tracking will use it, but " +
          "point_at/point_at_azel and get_calibration's `calibrated` flag still require solve_calibration.",
      }));
    },
  );
}
