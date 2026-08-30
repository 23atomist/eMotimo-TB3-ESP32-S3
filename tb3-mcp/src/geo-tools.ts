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
  dBaseFromGravity, enuToPanTiltOffset,
} from "./geo/imu-orientation.js";
import { residualRmsBoundDeg, MAX_CHEAD_OFF_AXIS_DEG } from "./geo/calibration-fit.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";
import { AdsbSource } from "./adsb/source.js";
import { extrapolateSightingPosition } from "./adsb/extrapolate.js";
import { LimitsStore, effectiveLimits, CeilingLimits } from "./limits-store.js";

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
  supervisor: SunSupervisor, source: AdsbSource, limitsStore: LimitsStore,
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
      description: "Record the CURRENT pan/tilt as a sighting of a known landmark (aim first via the camera feed + jog). Sightings accumulate; more of them, spread in BOTH azimuth and tilt, make a better solve.",
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
        note: `${slot} sighting(s) recorded.${warn}`,
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

      const extrap = extrapolateSightingPosition(ac, cfg.adsbAltSource, cfg.calibVideoLatencyMs, cfg.calibMaxPosAgeSec);
      if ("error" in extrap) return errText(extrap.error);

      // A sighting asserts "the camera is pointed at this aircraft RIGHT NOW",
      // so it is only as good as the posture read paired with it. Both of these
      // are REFUSALS, not warnings: a bad sighting is not a weak vote that the
      // fit can outweigh, it is false evidence that drags the solve with it.
      //
      // Field bug 2026-08-30: a sighting taken while telemetry lagged recorded
      // pan 9.1/tilt 3.9 for an aircraft 51° away, and the auto re-solve put
      // the rig ~27° off. `moving` was only ever appended to a JSON note, and
      // a STALE read reports moving:false anyway -- so nothing caught it.
      const devState = device.getState();
      const telemetryAgeMs = devState.lastUpdateMs === 0 ? Infinity : Date.now() - devState.lastUpdateMs;
      if (telemetryAgeMs > cfg.trackStaleTelemetryMs) {
        return errText(
          `posture telemetry is stale (${Number.isFinite(telemetryAgeMs) ? Math.round(telemetryAgeMs) + "ms" : "never received"}, ` +
          `limit ${cfg.trackStaleTelemetryMs}ms) — the recorded pan/tilt would not be where the camera is now; re-sight once telemetry is live`,
        );
      }
      const { panDeg, tiltDeg, moving } = currentUserPanTilt(device, cfg);
      if (moving) {
        return errText("the rig is still moving — hold the aim until it settles, then re-sight");
      }
      const label = ac.callsign ?? ac.hex;
      // 1σ angular error for this sighting: the operator's centring error,
      // plus the residual position uncertainty after extrapolation converted
      // to an angle at this range. A close, fast, stale target is worth less
      // than a distant, fresh one, and the fit weights accordingly.
      const OPERATOR_AIM_SIGMA_DEG = 0.5;
      const sightRig: Geodetic = store.get().rig!;
      const speedMs = (ac.gsKt ?? 250) * 0.514444;
      const residualAgeSec = Math.max(0.5, extrap.positionAgeSec * 0.25);
      const posSigmaM = speedMs * residualAgeSec;
      const rangeMeters = rangeM(sightRig, extrap.geodetic);
      const sigmaDeg = Math.hypot(
        OPERATOR_AIM_SIGMA_DEG,
        rangeMeters > 1 ? rad2deg(posSigmaM / rangeMeters) : OPERATOR_AIM_SIGMA_DEG,
      );
      const slot = store.addSighting({
        lat: extrap.geodetic.lat, lon: extrap.geodetic.lon, height: extrap.geodetic.height,
        label, panDeg, tiltDeg, sigmaDeg,
      });

      // The old degenerate-PAIR refusal is gone with the two-sighting cap:
      // with an unbounded list a close sighting is redundant evidence, not a
      // solve-breaking pair, and the fit reports conditioning as real numbers
      // (tilt_spread_deg, the parameter sigmas) instead of a yes/no guess.
      return text(JSON.stringify({
        slot, pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
        hex: ac.hex, callsign: ac.callsign,
        moved_m: Math.round(extrap.movedM),
        position_age_sec: Number(extrap.positionAgeSec.toFixed(1)),
        sigma_deg: Number(sigmaDeg.toFixed(2)),
        note: `${slot} sighting(s) recorded.`,
      }));
    },
  );

  server.registerTool(
    "get_calibration",
    { description: "Report the current calibration profile: rig location, sightings, solved heading, timestamp, and whether it is calibrated.", inputSchema: {} },
    async () => {
      const p = store.get();
      const imu = store.getImuMounting();
      const fit = store.getLastFit();
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
        // Per-sighting residual and rejection come from the live fit, so the
        // dashboard can point at the ONE bad sighting instead of telling the
        // operator "they disagree" and leaving them to guess which.
        sightings: p.sightings.map((s, i) => ({
          id: s.id ?? null,
          label: s.label ?? null,
          at_iso: s.atIso ?? null,
          pan_deg: Number(s.panDeg.toFixed(3)),
          tilt_deg: Number(s.tiltDeg.toFixed(3)),
          residual_deg: fit ? Number(fit.residualsDeg[i].toFixed(2)) : null,
          rejected: fit ? fit.rejected[i] : false,
        })),
        fit: fit === null ? null : {
          stage: fit.stage,
          fallback_reason: fit.fallbackReason,
          used_count: fit.usedCount,
          heading_sigma_deg: Number(fit.headingSigmaDeg.toFixed(3)),
          chead_sigma_deg: fit.cHeadSigmaDeg === null ? null : Number(fit.cHeadSigmaDeg.toFixed(3)),
          camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, fit.cHead[1])))).toFixed(2)),
          tilt_spread_deg: Number(fit.tiltSpreadDeg.toFixed(1)),
          rms_deg: Number(fit.rmsDeg.toFixed(3)),
          base_lean_deg: Number(fit.baseLeanDeg.toFixed(2)),
        },
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
    "remove_sighting",
    {
      description: "Delete one calibration sighting by id (see get_calibration) and re-solve from the rest.",
      inputSchema: { id: z.string().min(1).describe("sighting id from get_calibration") },
    },
    async ({ id }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (!store.removeSighting(id)) return errText(`no sighting with id ${id}`);
      const fit = store.getLastFit();
      return text(JSON.stringify({
        removed: id,
        remaining: store.get().sightings.length,
        stage: fit?.stage ?? null,
        rms_deg: fit ? Number(fit.rmsDeg.toFixed(3)) : null,
      }));
    },
  );

  server.registerTool(
    "clear_sightings",
    {
      description: "Delete every calibration sighting, keeping the rig location and IMU characterization. Use after physically moving the rig.",
      inputSchema: {},
    },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      store.clearSightings();
      return text(JSON.stringify({ cleared: true, remaining: 0 }));
    },
  );

  server.registerTool(
    "solve_calibration",
    { description: "Re-anchor on a fresh gravity read and re-solve the mount orientation from ALL recorded sightings. Reports the fit stage (heading-only vs full camera offset), per-parameter confidence, tilt spread, residual RMS and base tilt; persists the solution. Falls back to a two-sighting TRIAD solve when the IMU has not been characterized.", inputSchema: {} },
    async () => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const p = store.get();
      if (p.rig === undefined) return errText("set the rig location first (set_rig_location)");
      if (p.sightings.length < 1) return errText("need at least one sighting to solve");

      const rig: Geodetic = p.rig;
      // Checked across EVERY sighting, not just the first two: the fit uses
      // the whole list, so a degenerate one anywhere in it would poison the
      // solve while a two-element check looked right.
      for (const s of p.sightings) {
        if (rangeM(rig, { lat: s.lat, lon: s.lon, height: s.height }) < MIN_RANGE_M) {
          return errText(`landmark "${s.label ?? "?"}" coincides with the rig location — cannot compute a direction; re-sight a real landmark`);
        }
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
        // Gate BEFORE committing. The old solver refused when the two
        // sightings disagreed by more than 3°, and dropping that would let a
        // mis-aimed sighting re-anchor the rig on bad data. The bound is the
        // fit module's own residual rule (residualRmsBoundDeg), not a second
        // copy of it, so the two cannot drift apart.
        const candidate = store.previewFit(dBase);
        if (!candidate) return errText("solve failed: no usable sightings for the fit");
        // A heading-only fit holds the camera offset at forward, so a REAL
        // boresight offset it could not identify lands entirely in its
        // residual. Gating such a fit on the sighting-noise bound rejects
        // good data outright — the operator's real 2026-07-30 pair fits
        // heading-only at 4.5° rms purely from the rig's own ~4.4° boresight.
        // So allow, for a heading-only fit, as much residual as a PLAUSIBLE
        // unidentified camera offset could explain; past that the data is bad
        // rather than merely under-modelled. A full fit had the freedom to
        // absorb a real offset, so it gets the tight bound.
        const noiseBoundDeg = residualRmsBoundDeg(store.sightingSigmasDeg());
        const rmsBoundDeg = candidate.stage === "full"
          ? noiseBoundDeg
          : Math.max(noiseBoundDeg, MAX_CHEAD_OFF_AXIS_DEG);
        if (candidate.rmsDeg > rmsBoundDeg) {
          // Name the worst sighting: with an unbounded list "they disagree"
          // is not actionable, but "drop this one" is.
          let worst = 0;
          candidate.residualsDeg.forEach((r, i) => { if (r > candidate.residualsDeg[worst]) worst = i; });
          const bad = p.sightings[worst];
          const leanNote = candidate.baseLeanDeg > 1.5
            ? ` The tripod base is ${candidate.baseLeanDeg.toFixed(1)}° off level, which is the most likely cause — level it and re-solve BEFORE re-sighting (the existing sightings stay valid).`
            : "";
          const imuStaleNote = imuDisagreeDeg > 2
            ? ` The live gravity read also disagrees with the stored IMU characterization by ${imuDisagreeDeg.toFixed(1)}° — that should be ~0° regardless of posture, so R_s is stale. RE-RUN characterize_imu first; until then the base-lean figure is derived from bad data.`
            : "";
          return errText(
            `gravity solve rejected: the sightings are mutually inconsistent — residual RMS ${candidate.rmsDeg.toFixed(1)}° against a bound of ${rmsBoundDeg.toFixed(1)}°. ` +
            `The worst is "${bad?.label ?? "?"}" (id ${bad?.id ?? "?"}) at ${candidate.residualsDeg[worst].toFixed(1)}° — if it was mis-aimed, remove_sighting it and re-solve.` +
            `${leanNote}${imuStaleNote}`,
          );
        }

        // Persist the verified anchor, then let the store re-fit from the FULL
        // sighting list. setBaseDown calls resolve() itself, so this is the
        // same code path load()/addSighting() use — there is exactly one
        // place a calibration is produced.
        store.setBaseDown(dBase);
        const fit = store.getLastFit();
        if (!fit) return errText("solve failed: no usable sightings for the fit");

        const imuNote = imuDisagreeDeg > 2
          ? ` WARNING: the live gravity read disagrees with the stored IMU characterization by ${imuDisagreeDeg.toFixed(1)}° — that should be ~0° regardless of posture, so R_s is stale (the IMU moved, or characterize_imu was run on a different setup). Re-run characterize_imu.`
          : "";
        const R = fit.R;
        const upUnit: Vec3 = [R[0][2], R[1][2], R[2][2]];
        const baseTilt = 90 - rad2deg(Math.asin(Math.max(-1, Math.min(1, upUnit[2]))));
        const note = fit.stage === "full"
          ? "solved with gravity anchor + camera offset."
          : `solved heading-only: ${fit.usedCount} sighting(s) spanning ${fit.tiltSpreadDeg.toFixed(1)}° of tilt do not determine the camera offset, so it is held at forward. Add sightings with more tilt spread (one high and close, one low and distant) to unlock it.`;
        return text(JSON.stringify({
          mode: "gravity-anchored",
          stage: fit.stage,
          used_count: fit.usedCount,
          rejected_count: fit.rejected.filter(Boolean).length,
          heading_sigma_deg: Number(fit.headingSigmaDeg.toFixed(3)),
          chead_sigma_deg: fit.cHeadSigmaDeg === null ? null : Number(fit.cHeadSigmaDeg.toFixed(3)),
          camera_offset_deg: Number(rad2deg(Math.acos(Math.max(-1, Math.min(1, fit.cHead[1])))).toFixed(2)),
          tilt_spread_deg: Number(fit.tiltSpreadDeg.toFixed(1)),
          rms_deg: Number(fit.rmsDeg.toFixed(3)),
          base_tilt_deg: Number(baseTilt.toFixed(2)),
          note: `${note}${imuNote}`,
        }, null, 2));
      }

      // TRIAD fallback (no IMU characterization). Unlike the gravity-anchored
      // fit above, this one genuinely needs a PAIR — it derives the whole
      // orientation from two directions with nothing else to anchor it.
      if (p.sightings.length < 2) {
        return errText(`need two sightings to solve without an IMU characterization; have ${p.sightings.length} (run characterize_imu to solve from one)`);
      }
      const [sa, sb] = p.sightings;
      const landmarkA: Geodetic = { lat: sa.lat, lon: sa.lon, height: sa.height };
      const landmarkB: Geodetic = { lat: sb.lat, lon: sb.lon, height: sb.height };
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
