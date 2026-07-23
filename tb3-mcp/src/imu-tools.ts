import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { moveToUserAngle } from "./move.js";
import { solveImuMounting, GravitySample } from "./geo/imu-orientation.js";
import { Vec3 } from "./geo/vec3.js";
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
}
