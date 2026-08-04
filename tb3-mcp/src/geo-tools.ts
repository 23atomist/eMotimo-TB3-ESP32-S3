import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign } from "./angles.js";
import { CalibrationStore } from "./calibration.js";
import { Geodetic, enuDirection, azElRange, geodeticToEcef } from "./geo/wgs84.js";
import { solveOrientation, separationDeg, resolvePanInRange } from "./geo/orientation.js";
import { panTiltToMount } from "./geo/boresight.js";
import { Vec3, Mat3, deg2rad, rad2deg, sub, norm } from "./geo/vec3.js";
import {
  dBaseFromGravity, solveCalibrationWithGravity, enuToPanTiltOffset, GravitySighting,
  GravityCalibration,
} from "./geo/imu-orientation.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";
import { AdsbSource } from "./adsb/source.js";
import { extrapolateSightingPosition } from "./adsb/extrapolate.js";
import { LimitsStore, effectiveLimits, CeilingLimits } from "./limits-store.js";
import { TuningStore } from "./tuning-store.js";
import { resolveTuning } from "./tuning-resolve.js";

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

// Exported so set_north_zero (imu-tools.ts) can capture the same
// before/after posture-plus-moving snapshot solve_calibration's gravity path
// uses, instead of re-deriving the angle-sign conversion independently.
export function currentUserPanTilt(device: Device, cfg: Config): { panDeg: number; tiltDeg: number; moving: boolean } {
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

// Below this angular separation between two sightings, the TRIAD solve is
// ill-conditioned (see solve_calibration's own, slightly stricter 15deg
// landmark warning below) -- aircraft make good separation easy to achieve
// (one high, one low, or well apart in azimuth), so this is a nudge to pick
// well, not a hard refusal (the solver itself is untouched).
const AIRCRAFT_SEPARATION_WARN_DEG = 20;

// HARD floor, below which a sighting pair is refused outright rather than
// warned about. Two sightings this close describe one direction, and TRIAD
// cannot recover an orientation from one direction -- the solve is not merely
// ill-conditioned, it is undetermined, and the result is arbitrary.
//
// This exists because warning was not enough (field, 2026-07-30): the rig
// accumulated TWO BYTE-IDENTICAL sightings (same aircraft position, same
// pan/tilt -- 0.0 deg apart), the step list counted them and reported the
// procedure complete, and solve would have persisted the degenerate result
// and lit the CALIBRATED badge over it. A refusal the operator must act on
// beats a warning inside a JSON blob they may never read.
const SEPARATION_REFUSE_DEG = 5;

export function registerGeoTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, limitsStore: LimitsStore, tuningStore?: TuningStore,
): void {
  const cfgCeiling: CeilingLimits = {
    panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
  };
  // Re-read on every call, same rationale as tools.ts's effLimits(): a
  // teach_limit/clear_taught_limits between two point_at calls must take
  // effect on the very next one.
  const effLimits = (): CeilingLimits => effectiveLimits(cfgCeiling, limitsStore.get());
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
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
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
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
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
    "sight_aircraft",
    {
      description:
        "Record the CURRENT pan/tilt as a sighting of a live ADS-B aircraft (aim first via the camera " +
        "feed + jog, same as sight_landmark). The aircraft's position is extrapolated to the instant it " +
        "was centered, correcting for ADS-B report age and video latency (see calibVideoLatencyMs). " +
        "Aircraft are geometrically better than landmarks for this: they spread across azimuth AND " +
        "elevation, rather than sitting near the horizon. Two well-separated sightings (landmark or " +
        "aircraft, mixed freely) are needed before solving.",
      inputSchema: {
        hex: z.string().min(1).describe("ICAO 24-bit hex address of the aircraft to sight, e.g. a1b2c3"),
      },
    },
    async ({ hex }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (store.get().rig === undefined) {
        return errText("set the rig location first (set_rig_location) before sighting aircraft");
      }
      const wanted = hex.toLowerCase();
      const ac = source.getSnapshot().aircraft.find((a) => a.hex === wanted);
      if (!ac) return errText(`aircraft ${wanted} is not currently visible in the ADS-B feed`);

      const calibVideoLatencyMs = resolveTuning(tuningStore, cfg).calibVideoLatencyMs;
      const extrap = extrapolateSightingPosition(ac, cfg.adsbAltSource, calibVideoLatencyMs, cfg.calibMaxPosAgeSec);
      if ("error" in extrap) return errText(extrap.error);

      const { panDeg, tiltDeg, moving } = currentUserPanTilt(device, cfg);
      const label = ac.callsign ?? ac.hex;
      const slot = store.addSighting({
        lat: extrap.geodetic.lat, lon: extrap.geodetic.lon, height: extrap.geodetic.height,
        label, panDeg, tiltDeg,
      });

      // Separation warning: once the second sighting lands, check how far
      // apart the two ENU directions are. Two sightings close together in
      // angle make a degenerate, badly-conditioned solve -- this is purely
      // informational (the solver and the 2-sighting cap are untouched).
      let sepWarn = "";
      if (slot === 2) {
        const p = store.get();
        const rig: Geodetic = p.rig!;
        const [a, b] = p.sightings;
        const enuA = enuDirection(rig, { lat: a.lat, lon: a.lon, height: a.height }).unit;
        const enuB = enuDirection(rig, { lat: b.lat, lon: b.lon, height: b.height }).unit;
        const sep = separationDeg(enuA, enuB);
        if (sep < SEPARATION_REFUSE_DEG) {
          // Undo it: a pair this close is one direction recorded twice, and
          // leaving it stored is what let the UI report "2 sightings, ready
          // to solve" over a degenerate pair.
          store.replaceSightings([a]);
          return errText(
            `refusing this sighting: it is only ${sep.toFixed(1)}° from sighting 1 — that is the same direction twice, ` +
            `and an orientation cannot be solved from one direction. Sighting 1 is kept; pick an aircraft at least ` +
            `${AIRCRAFT_SEPARATION_WARN_DEG}° away (one high and one low, or well apart in azimuth).`,
          );
        }
        if (sep < AIRCRAFT_SEPARATION_WARN_DEG) {
          sepWarn = ` WARNING: sightings are only ${sep.toFixed(1)}° apart — the solve will be ill-conditioned; ` +
            "pick one aircraft high and one low, or well apart in azimuth.";
        }
      }

      const moveWarn = moving ? " WARNING: the rig was still moving; pan/tilt may not be settled — re-sight when stopped." : "";
      return text(JSON.stringify({
        slot, pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
        hex: ac.hex, callsign: ac.callsign,
        moved_m: Math.round(extrap.movedM),
        position_age_sec: Number(extrap.positionAgeSec.toFixed(1)),
        note: `${slot}/2 sightings recorded.${moveWarn}${sepWarn}`,
      }));
    },
  );

  server.registerTool(
    "get_calibration",
    { description: "Report the current calibration profile: rig location, sightings, solved heading, timestamp, and whether it is calibrated.", inputSchema: {} },
    async () => {
      const p = store.get();
      const imu = store.getImuMounting();
      return text(JSON.stringify({
        calibrated: store.isCalibrated(),
        // A set_north_zero seed reports orientation-set-but-not-calibrated
        // (isCalibrated() excludes it on purpose) -- surfaced explicitly so
        // it reads as "a seed, not an answer" rather than just "uncalibrated".
        //
        // `&& !!store.getOrientation()` (review fix, finding C-1): isProvisional()
        // alone answers "was the last orientation write a set_north_zero seed",
        // NOT "is there currently a usable orientation" -- addSighting (calibration.ts)
        // clears `orientation` on every call but deliberately does NOT clear
        // `orientationProvisional` (that flag is only ever cleared by a REAL
        // solve -- see setOrientation/setGravityCalibration), so after the
        // first sight_aircraft/sight_landmark call following a set_north_zero
        // seed, isProvisional() stays true while getOrientation() is already
        // undefined. Reporting bare isProvisional() there would tell the
        // dashboard (step-gate.js's north-zero done-ness, cockpit.js's
        // aircraftRowActions hasOrientation) that tracking is still possible
        // when TrackingSession.start()/tick() (track/session.ts) already
        // refuse for lack of an orientation -- exactly the "checklist says
        // go, daemon says no" defect this fixes. This is a serialization
        // truth fix, not a behaviour change: addSighting's own clearing
        // behaviour (and the daemon-side root fix of not clearing a
        // PROVISIONAL orientation there) is separate, later, multi-landmark
        // work -- see test/geo-tools.test.ts's own regression pin.
        provisional: store.isProvisional() && !!store.getOrientation(),
        rig: p.rig,
        sightings: p.sightings,
        solved_at: p.solvedAt ?? null,
        // Null until characterize_imu has persisted a mounting solve -- the
        // dashboard's calibration step-gate (dashboard/public/step-gate.js)
        // gates the IMU step (and everything after it) on this being
        // present. rms_deg mirrors characterize_imu's own rms_deg and may be
        // absent (schema tolerates it) on a profile persisted before this
        // field existed.
        imu_mounting: imu ? { rms_deg: imu.rmsDeg ?? null } : null,
      }, null, 2));
    },
  );

  server.registerTool(
    "clear_calibration",
    { description: "Erase the calibration profile (rig location, sightings, solution).", inputSchema: {} },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      store.clear(); return text("calibration cleared");
    },
  );

  server.registerTool(
    "solve_calibration",
    { description: "Solve the mount orientation from the two recorded sightings (TRIAD). Reports heading, base tilt, and landmark separation; persists the solution.", inputSchema: {} },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
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

      const imu = store.getImuMounting();
      if (imu) {
        // Gravity-anchored path: a fresh gravity read at the CURRENT posture
        // (the tripod may have been re-leveled since characterize_imu ran)
        // gives d_base; that plus the two sightings solves R and the
        // camera-boresight offset c_head in one shot.
        const before = currentUserPanTilt(device, cfg);
        let gravity: Vec3;
        try {
          gravity = await device.getGravity(100);
        } catch (e) {
          return errText(`gravity read failed: ${(e as Error).message}`);
        }
        // The burst read above takes multiple seconds. If the mount moved
        // during it (a stray goto/track from another session, a
        // reconnect-replayed command -- this rig has hit exactly that in the
        // field), the posture captured before the read no longer matches
        // where the gravity sample was actually taken, and dBaseFromGravity
        // would silently pair mismatched posture+gravity into a wrong R/cHead
        // that then gets PERSISTED -- the headingResidualDeg>3 gate below
        // does not catch this class of error, since a wrong-but-internally-
        // consistent posture can still produce a low residual. Hard-refuse
        // rather than warn, since this feeds a persisted calibration.
        const after = currentUserPanTilt(device, cfg);
        const MOVE_TOL_DEG = 0.5;
        if (
          before.moving || after.moving ||
          Math.abs(before.panDeg - after.panDeg) > MOVE_TOL_DEG ||
          Math.abs(before.tiltDeg - after.tiltDeg) > MOVE_TOL_DEG
        ) {
          return errText("the rig moved during the gravity read — hold the mount still and re-run solve_calibration");
        }
        const dBase = dBaseFromGravity(imu.rS, after.panDeg, after.tiltDeg, gravity, cfg.geoPanSign);
        // A correct R_s makes dBase INDEPENDENT of the posture it is measured
        // at -- it describes the base, not where the head happens to be
        // pointing. So a fresh read that disagrees with the stored
        // characterization means R_s itself is wrong (the IMU moved, or
        // characterize_imu was run on a different physical setup), and every
        // number downstream of it is untrustworthy including the base-lean
        // figure this tool reports.
        //
        // Field 2026-07-30: the operator levelled the tripod and the solve
        // then reported the base as 7.8deg off, WORSE than the 3.87deg stored
        // -- relevelling cannot do that, so the disagreement was the real
        // finding and nothing surfaced it.
        const storedDBase = imu.dBase;
        const dot3 = dBase[0] * storedDBase[0] + dBase[1] * storedDBase[1] + dBase[2] * storedDBase[2];
        const imuDisagreeDeg = rad2deg(Math.acos(Math.max(-1, Math.min(1, dot3))));
        const toSighting = (s: typeof sa): GravitySighting => {
          const { unit } = enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height });
          const { elevation } = azElRange(rig, { lat: s.lat, lon: s.lon, height: s.height });
          return { panDeg: s.panDeg, tiltDeg: s.tiltDeg, enuUnit: unit, elevationDeg: elevation };
        };
        let solved: GravityCalibration;
        try {
          solved = solveCalibrationWithGravity(dBase, [toSighting(sa), toSighting(sb)], cfg.geoPanSign);
        } catch (e) {
          return errText(`gravity solve failed: ${(e as Error).message}`);
        }
        const { R, cHead, headingResidualDeg, baseLeanDeg, infeasibleBy } = solved;
        if (headingResidualDeg > 3) {
          // Name the base lean explicitly. It is the dominant conditioning
          // term and it is invisible to the operator otherwise -- on
          // 2026-07-30 a 3.87deg lean made a pair of GOOD sightings
          // unsolvable, and the message at the time blamed the sightings and
          // sent the operator off to re-sight, which could not have helped.
          // Ordered deliberately: if the IMU characterization is stale, the
          // lean figure is derived from it and is not evidence of anything.
          // Telling the operator to level a tripod that is already level is
          // exactly the wrong instruction.
          const imuNote = imuDisagreeDeg > 2
            ? ` The live gravity read disagrees with the stored IMU characterization by ${imuDisagreeDeg.toFixed(1)}° — that should be ~0° regardless of posture, so R_s is stale (the IMU moved, or characterize_imu was run on a different setup). RE-RUN characterize_imu first; until then the base-lean figure below is derived from bad data and cannot be trusted.`
            : "";
          if (imuNote) {
            return errText(`gravity solve rejected: the two sightings disagree by ${headingResidualDeg.toFixed(1)}°.${imuNote}`);
          }
          const leanNote = baseLeanDeg > 1.5
            ? ` The tripod base is ${baseLeanDeg.toFixed(1)}° off level, which is the most likely cause — level it and re-solve BEFORE re-sighting (the existing sightings stay valid).`
            : "";
          const infeasNote = infeasibleBy > 0
            ? ` (the two elevation constraints admit no exact camera boresight — nearest fit used, off by ${infeasibleBy.toFixed(3)})`
            : "";
          return errText(`gravity solve rejected: the two sightings disagree by ${headingResidualDeg.toFixed(1)}°${infeasNote}.${leanNote} If the base is already level, re-sight with more elevation spread (one high, one low).`);
        }
        store.setGravityCalibration(R, cHead, new Date().toISOString());
        const upUnit: Vec3 = [R[0][2], R[1][2], R[2][2]];
        const baseTilt = 90 - rad2deg(Math.asin(Math.max(-1, Math.min(1, upUnit[2]))));
        return text(JSON.stringify({
          mode: "gravity-anchored",
          heading_residual_deg: Number(headingResidualDeg.toFixed(2)),
          base_tilt_deg: Number(baseTilt.toFixed(2)),
          camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, cHead[1])))).toFixed(1)),
          note: "solved with gravity anchor + camera offset.",
        }));
      }

      const enuA = enuDirection(rig, landmarkA).unit;
      const enuB = enuDirection(rig, landmarkB).unit;
      const mountA = panTiltToMount(sa.panDeg, sa.tiltDeg);
      const mountB = panTiltToMount(sb.panDeg, sb.tiltDeg);

      const sep = separationDeg(enuA, enuB);
      // Check BEFORE persisting. This used to solve, store the result, and
      // only then append a warning string -- so a degenerate pair produced a
      // stored orientation and a CALIBRATED badge over an arbitrary answer.
      if (sep < SEPARATION_REFUSE_DEG) {
        return errText(
          `refusing to solve: the two sightings are only ${sep.toFixed(1)}° apart — that is one direction, and TRIAD ` +
          `cannot determine an orientation from one direction. Re-sight so the pair is at least ` +
          `${AIRCRAFT_SEPARATION_WARN_DEG}° apart (one high and one low, or well apart in azimuth). ` +
          "The existing calibration is left untouched.",
        );
      }
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
      const cHead = store.getCHead() ?? [0, 1, 0];
      const limits = effLimits();
      const inv = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limits);
      const reach = reachablePanTilt(inv.panDeg, inv.tiltDeg, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
      if ("error" in reach) return errText(reach.error);
      const azel = azElRange(rig, target);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps, limits);
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
      const cHead = store.getCHead() ?? [0, 1, 0];
      const limits = effLimits();
      const inv = enuToPanTiltOffset(R, cHead, cfg.geoPanSign, unit, limits);
      const reach = reachablePanTilt(inv.panDeg, inv.tiltDeg, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
      if ("error" in reach) return errText(reach.error);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps, limits);
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
