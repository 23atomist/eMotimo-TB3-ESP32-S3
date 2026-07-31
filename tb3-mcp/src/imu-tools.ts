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
import { LimitsStore, CeilingLimits, effectiveLimits } from "./limits-store.js";
import { ceilingFrom } from "./limits-tools.js";
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
  // Where the rig actually ended up after moveTo. Optional so existing
  // callers/tests keep the old "trust the request" behaviour.
  achievedPosture?: () => Promise<{ panDeg: number; tiltDeg: number }>;
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
    // Record where the rig ACTUALLY is, not where we asked it to go. A leg
    // that clamps, stalls against a mechanical stop, or lands short pairs a
    // real gravity reading with a posture the rig was never at, and
    // solveImuMounting has no way to tell -- it silently produces a wrong
    // R_s, which then poisons dBase, the base-lean figure, and every solve
    // downstream (field 2026-07-30: R_s disagreed with a live gravity read
    // by 7.8deg and the calibration could not be completed).
    const at = deps.achievedPosture ? await deps.achievedPosture() : { panDeg: p.panDeg, tiltDeg: p.tiltDeg };
    samples.push({ panDeg: at.panDeg, tiltDeg: at.tiltDeg, gravity });
  }
  const { rS, dBase, residualsDeg, rmsDeg } = solveImuMounting(samples, deps.geoPanSign);
  deps.store.setImuMounting(rS, dBase, rmsDeg);
  return { rmsDeg, residualsDeg };
}

export function registerImuTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, supervisor: SunSupervisor,
  session: TrackingSession, limitsStore: LimitsStore,
): void {
  const effLimits = (): CeilingLimits => effectiveLimits(ceilingFrom(cfg), limitsStore.get());
  server.registerTool(
    "characterize_imu",
    {
      description: "Sweep the rig through a fixed pan+tilt geometry, read gravity at each, and solve the one-time IMU→head mounting (R_s). Needed once while the IMU stays bolted on; persists R_s for gravity-anchored calibration. Motion tool — respects limits, sun guard, deadman.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) return errText("tracking active; stop_tracking first");
      // Preflight the whole sweep geometry BEFORE moving anything. The sweep
      // needs its full spread to condition the R_s solve; running a subset
      // produces a confidently wrong answer rather than an obvious failure,
      // and moving first would leave the rig parked mid-sweep.
      const lim = effLimits();
      const unreachable = SWEEP_POSITIONS.filter(
        (p) => p.panDeg < lim.panMin || p.panDeg > lim.panMax || p.tiltDeg < lim.tiltMin || p.tiltDeg > lim.tiltMax,
      );
      if (unreachable.length > 0) {
        const list = unreachable.map((p) => `(pan ${p.panDeg}°, tilt ${p.tiltDeg}°)`).join(", ");
        return errText(
          `characterize_imu needs ${SWEEP_POSITIONS.length} widely-spaced postures, but ${unreachable.length} of them are outside the current travel limits ` +
          `(pan ${lim.panMin.toFixed(1)}°..${lim.panMax.toFixed(1)}°, tilt ${lim.tiltMin.toFixed(1)}°..${lim.tiltMax.toFixed(1)}°): ${list}. ` +
          "Run clear_taught_limits, characterize, then re-teach the limits — or widen them enough to contain the sweep. " +
          "Characterizing from the reachable subset would silently solve a wrong IMU mounting.",
        );
      }
      try {
        const res = await runCharacterizeImu({
          positions: SWEEP_POSITIONS,
          geoPanSign: cfg.geoPanSign,
          samplesPerPos: 100,
          // effLimits(), NOT the bare config ceiling. Passing no limits here
          // silently fell back to cfg.panMin/panMax/tiltMin/tiltMax and drove
          // the sweep straight through the operator's TAUGHT travel limits --
          // the ones taught because the rig was grinding into its stops. That
          // is the exact gap limits-store.ts's module doc says every absolute
          // move must not have.
          moveTo: async (p, t) => { await moveToUserAngle(device, cfg, p, t, undefined, effLimits()); },
          getGravity: (n) => device.getGravity(n),
          achievedPosture: async () => {
            const at = currentUserPanTilt(device, cfg);
            return { panDeg: at.panDeg, tiltDeg: at.tiltDeg };
          },
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
