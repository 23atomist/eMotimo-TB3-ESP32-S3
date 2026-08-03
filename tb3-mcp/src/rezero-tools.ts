// Reboot re-zero: MCP surface + boot-time recovery for a lost step origin.
//
// The firmware does not persist step position, so every power cycle (and
// every OTA flash) invalidates pan/tilt against both the taught travel
// limits and the solved calibration -- see boot-watch.ts and geo/rezero.ts
// for the detection and the math. This module wires that math to the store
// and exposes it as MCP tools, plus the guard other tools call to refuse
// automated motion while the origin is unknown.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CalibrationStore } from "./calibration.js";
import { LimitsStore } from "./limits-store.js";
import { BootWatcher } from "./boot-watch.js";
import { Config } from "./config.js";
import { Vec3 } from "./geo/vec3.js";
import { boresightEnu } from "./track/control.js";
import {
  solveTiltOffset, solvePanOffset, applyTiltOffset,
  MAX_TILT_RESIDUAL_DEG, MAX_PAN_RESIDUAL_DEG,
} from "./geo/rezero.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

// A posture read older than this cannot be trusted to describe the SAME
// instant as the gravity sample it is paired with -- see RezeroPosture's doc
// for the incident this guards against. Fixed per the task brief, not
// configurable: this is a safety floor, not a tuning knob. Exported so the
// MCP tools' own before/after gravity-read check (below) shares the exact
// same threshold onReboot uses, rather than a second, driftable copy.
export const MAX_POSTURE_STALE_MS = 2000;

// The posture paired with a gravity read for onReboot's tilt solve. Widened
// (Finding I3) beyond {panDeg, tiltDeg} so onReboot can itself refuse a
// reading it cannot vouch for, the same way solve_calibration's and
// set_north_zero's gravity paths already do (geo-tools.ts:302-324,
// imu-tools.ts:203-220) -- both wrap a gravity read in a before/after posture
// plus `moving` check, with a comment explaining that this exact pairing once
// produced a persisted wrong calibration in the field. onReboot is the one
// gravity-consuming path that did not: it read gravity over HTTP but posture
// from the WebSocket tick cache, and the boot poll's own HTTP uptime check
// could detect a reboot before the WS had reconnected and delivered a
// post-reboot tick -- pairing a FRESH gravity read with a STALE (pre-reboot)
// posture. Measured at a true 23.33deg offset this produced `applied: true`,
// Delta-tilt ~0, residual 0.00deg: a confident, wrong success. `moving` and
// `staleMs` are deliberately non-optional (not `moving?`/`staleMs?`) -- a
// caller that could omit them could reintroduce exactly this bug silently;
// see buildRezeroPosture (server.ts) for how a real caller supplies them.
export interface RezeroPosture {
  panDeg: number;
  tiltDeg: number;
  moving: boolean;
  // Date.now() - lastUpdateMs at the moment this posture was read; Infinity
  // when the WebSocket is disconnected (there is no tick to be stale FROM).
  staleMs: number;
}

// Injected so every path is testable without a rig.
//
// session/supervisor (Finding I5): set_landmark, rezero_from_landmark, and
// rezero_from_aircraft persist calibration/limits state while checking
// neither whether tracking is active nor whether the sun guard is locked --
// the same two guards seven other tools already carry (e.g. imu-tools.ts's
// set_north_zero) for exactly this reason: recording a landmark or applying
// a re-zero while the rig is slewing under an active session captures a
// posture that does not match the gravity or ENU it is paired with.
// Narrowed to the single method each check needs (not the full
// TrackingSession/SunSupervisor classes) so this stays testable without
// constructing either -- server.ts's real TrackingSession/SunSupervisor
// instances satisfy these structurally.
export interface RezeroDeps {
  calib: CalibrationStore;
  limits: LimitsStore;
  boot: BootWatcher;
  cfg: Config;
  gravity: () => Promise<Vec3 | undefined>;  // mean gravity; undefined when the IMU is absent
  posture: () => Promise<RezeroPosture>;
  aircraftEnu: (hex: string) => Promise<Vec3 | undefined>;
  session: { isActive: () => boolean };
  supervisor: { isSunLocked: () => boolean };
}

// onReboot and rezeroFromEnu take narrower argument objects than RezeroDeps:
// they need no MCP server, no config, and no aircraft lookup, and keeping
// them narrow is what lets the tests drive them with plain fakes.
export interface OnRebootArgs {
  calib: CalibrationStore;
  limits: LimitsStore;
  boot: BootWatcher;
  geoPanSign: number;
  gravity: () => Promise<Vec3 | undefined>;
  posture: () => Promise<RezeroPosture>;
  bootId: number;
}
export interface RezeroArgs {
  calib: CalibrationStore;
  limits: LimitsStore;
  geoPanSign: number;
  bootId: number;
}

type RebootOutcome = { applied: boolean; deltaTiltDeg?: number; residualDeg?: number; reason?: string };
type RezeroOutcome = {
  applied: boolean; deltaPanDeg?: number; deltaTiltDeg?: number; residualDeg?: number; reason?: string;
};

// The most recent onReboot/rezeroFromEnu outcome, purely for get_rezero_status
// (see below) -- the failure this whole feature addresses was *invisible*, so
// the numbers a solve produced (or the reason it refused) must stay readable
// after the fact, not just returned once to whichever caller triggered it.
// Keyed by CalibrationStore instance (not persisted -- this is diagnostic,
// not state anything else depends on) so tests using independent stores never
// see each other's history.
interface LastRezero {
  kind: "boot" | "reference";
  atIso: string;
  applied: boolean;
  deltaPanDeg?: number;
  deltaTiltDeg?: number;
  residualDeg?: number;
  reason?: string;
}
const lastRezero = new WeakMap<CalibrationStore, LastRezero>();

// Shift every taught axis to the given cumulative offset -- by only the part
// it does not already carry, and never an edge stamped with THIS boot
// generation (already in the current frame -- see LimitsStore.shiftToOffset,
// which does the actual work; this is a thin, named pass-through so both call
// sites below read identically and can never drift apart).
function applyLimitDelta(
  limits: LimitsStore, panTotal: number, tiltTotal: number, bootId: number,
): void {
  limits.shiftToOffset(panTotal, tiltTotal, bootId);
}

function record<T extends { applied: boolean; deltaTiltDeg?: number; residualDeg?: number; reason?: string }>(
  calib: CalibrationStore, kind: LastRezero["kind"], r: T & { deltaPanDeg?: number },
): T {
  lastRezero.set(calib, {
    kind, atIso: new Date().toISOString(), applied: r.applied,
    deltaPanDeg: r.deltaPanDeg, deltaTiltDeg: r.deltaTiltDeg, residualDeg: r.residualDeg, reason: r.reason,
  });
  return r;
}

// Ordered so the dangerous axis is protected first: tilt is the axis that
// reached a mechanical stop on 2026-08-02 because the guard was enforcing the
// previous origin's taught limits against the new zero.
export async function onReboot(a: OnRebootArgs): Promise<RebootOutcome> {
  const imu = a.calib.getImuMounting();
  const cHead = a.calib.getCHead();
  const R = a.calib.getOrientation();
  const g = await a.gravity();

  // Always mark and stamp, whatever else happens: an unknown origin must be
  // recorded even when we cannot measure the offset.
  //
  // Pan is cleared on EVERY exit path (operator decision, 2026-08-03,
  // superseding round 1's "leave it untouched" design): during the pending
  // window the taught pan edges describe the OLD origin and can be off by
  // the full cumulative Delta-pan (73deg by the third cycle of the
  // multi-cycle acceptance test) -- yet jog and teach_limit deliberately
  // stay open during that window (rezeroGuard's own comment), so enforcing
  // those stale edges is verbatim the mechanism that drove tilt into its
  // mechanical stop on 2026-08-02. Clearing falls back to the config
  // ceiling. Accepted cost: the taught pan values are gone, so pan is
  // RE-TAUGHT after a reboot rather than recovered by the eventual re-zero
  // -- unlike tilt, which onReboot can solve immediately from gravity, pan
  // has no equivalent boot-time signal, so there is nothing trustworthy to
  // preserve. Placed in finish() so no exit path (success, oversized
  // residual, or missing IMU) can skip it -- the same reasoning that already
  // put tilt's clearAxis calls on its own failure paths, just applied to the
  // axis that ALWAYS lacks a boot-time solve.
  const finish = (r: RebootOutcome): RebootOutcome => {
    a.limits.clearAxis("pan");
    a.limits.setBootId(a.bootId);
    a.calib.markRezeroNeeded(a.bootId);
    return record(a.calib, "boot", r);
  };

  // No IMU, no characterization, no cHead, or no orientation => Delta-tilt is
  // unmeasurable. Clear the tilt limits rather than guess: a guessed offset
  // that looks precise is worse than an absent one. A profile can carry a
  // provisional orientation with cHead still unset -- checking cHead alone
  // does not imply R is present, so both are checked explicitly.
  if (!imu || !cHead || !R || !g) {
    a.limits.clearAxis("tilt");
    return finish({ applied: false, reason: "no IMU gravity or no prior characterization — both axes fall back to the config ceiling" });
  }

  const p = await a.posture();

  // A gravity read is only as trustworthy as the posture paired with it
  // (Finding I3): if the posture is stale -- the WS tick cache has not
  // delivered a fresh sample since before the reboot, e.g. the boot poll's
  // own HTTP uptime check detected the reboot before the WS reconnected -- or
  // the rig is mid-motion, solveTiltOffset would silently pair a TRUE gravity
  // reading with a WRONG pan/tilt. Measured at a true 23.33deg offset, that
  // pairing produced `applied: true`, Delta-tilt ~0, residual 0.00deg: a
  // confident, wrong success, logged as if the reboot had been handled.
  // Refuse before solving -- and, unlike the oversized-residual path below,
  // do NOT clear the tilt limits: this is not "gravity doesn't fit any
  // origin-only shift" (a numerical solve failure), it is "we don't trust
  // this reading at all" (an input-validity failure), and the operator needs
  // to be able to tell the two apart from the reason text. finish() still
  // clears pan (unconditional on every exit path, per applyLimitDelta's own
  // comment) and marks needsRezero -- an unknown origin must be recorded
  // even when the read can't be trusted enough to solve.
  if (p.staleMs > MAX_POSTURE_STALE_MS) {
    const age = p.staleMs === Infinity ? "disconnected" : `${Math.round(p.staleMs)}ms`;
    return finish({
      applied: false,
      reason: `posture is stale (${age} since the last tick, threshold ${MAX_POSTURE_STALE_MS}ms) — refusing to pair it with a fresh gravity read; tilt limits left untouched`,
    });
  }
  if (p.moving) {
    return finish({
      applied: false,
      reason: "the rig is moving — refusing to pair a fresh gravity read with an unsettled posture; tilt limits left untouched",
    });
  }

  const t = solveTiltOffset(imu.rS, imu.dBase, p.panDeg, p.tiltDeg, g, a.geoPanSign);

  if (t.residualDeg > MAX_TILT_RESIDUAL_DEG) {
    a.limits.clearAxis("tilt");
    return finish({
      applied: false, deltaTiltDeg: t.deltaTiltDeg, residualDeg: t.residualDeg,
      reason: `gravity does not fit an origin-only shift (residual ${t.residualDeg.toFixed(2)}deg) — the tripod appears to have moved; full recalibration required`,
    });
  }

  // Shift the tilt LIMITS only -- deliberately do NOT touch cHead here.
  //
  // Delta-pan is still unknown at this point, and the pan/tilt decoupling is
  // only approximate: dBase sits ~1.45deg off the pan axis on this rig, so an
  // unknown pan error perturbs the recovered Delta-tilt by up to ~2.03deg
  // (measured). Baking that into cHead now would make it permanent. Automated
  // motion is blocked until re-zero anyway, so the calibration can wait for
  // the better estimate; the limits cannot, because tilt is the axis that
  // reaches a mechanical stop.
  //
  // Sign: deltaTiltDeg solves trueTilt = reportedTilt + deltaTiltDeg (see
  // solveTiltOffset). A taught edge was recorded as a REPORTED reading under
  // the OLD origin, which — at teach time — equalled true tilt for that
  // physical spot. Its NEW-origin reading at that same physical spot is
  // therefore trueTilt - deltaTiltDeg = oldValue - deltaTiltDeg, so the shift
  // applied to the stored edge must be the negated offset -- applyLimitDelta
  // encodes that negation.
  //
  // deltaTiltDeg here is already CUMULATIVE since characterize_imu
  // (imuMounting.dBase is never refreshed by a re-zero -- see solveTiltOffset),
  // so it is passed straight through as the new total, not added as an
  // increment on top of the old one; applyLimitDelta shifts by only the part
  // not already applied, and never a tilt edge re-taught under a.bootId
  // itself (e.g. after a prior failed attempt this same boot generation --
  // see shiftToOffset). Pan is passed through unchanged (prev.panDeg):
  // Delta-pan is still unknown, and this call must not touch it.
  const prev = a.limits.getAppliedOffset();
  applyLimitDelta(a.limits, prev.panDeg, t.deltaTiltDeg, a.bootId);
  return finish({ applied: true, deltaTiltDeg: t.deltaTiltDeg, residualDeg: t.residualDeg });
}

// Solves BOTH offsets, iterating twice to break their weak coupling.
//
// Delta-tilt and Delta-pan are nearly independent -- gravity sees tilt and is
// nearly blind to pan -- but only nearly: the residual coupling is bounded by
// how far dBase sits off the pan axis, i.e. by tripod lean. On this rig that
// is 1.45deg, giving up to ~2.03deg of Delta-tilt error when pan is unknown.
// One extra pass removes it: solve tilt with the reported pan, solve pan,
// then re-solve tilt with the CORRECTED pan. Both offsets are applied
// together at the end, so a mid-sequence failure never leaves a half-applied
// calibration.
//
// `gravity`/`posture` must be read fresh at the moment the operator has the
// reference centred -- the same instant the pan reading is taken.
export async function rezeroFromEnu(
  a: RezeroArgs, refEnu: Vec3,
  posture: { panDeg: number; tiltDeg: number }, gravity: Vec3,
): Promise<RezeroOutcome> {
  if (!a.calib.needsRezero()) return record(a.calib, "reference", { applied: false, reason: "no re-zero is pending" });
  // Solve against the BASELINE (the calibration exactly as originally solved),
  // never against the live getOrientation()/getCHead() -- those are already
  // shifted by any previous re-zero, and solving against them would make the
  // result INCREMENTAL on top of whatever was already applied. solveTiltOffset
  // (below) is cumulative from imuMounting's dBase (never refreshed by a
  // re-zero); solving pan against a live, already-offset R made the old pan
  // result incremental instead -- a mismatch that, applied as increments,
  // accumulated pointing error on every re-zero after the first. This is the
  // core fix.
  const baseline = a.calib.getBaseline();
  const imu = a.calib.getImuMounting();
  if (!baseline || !baseline.cHead0 || !imu) {
    return record(a.calib, "reference", { applied: false, reason: "no calibration to re-zero — solve one first" });
  }
  const { R0, cHead0 } = baseline;

  const tiltAt = (panDeg: number) =>
    solveTiltOffset(imu.rS, imu.dBase, panDeg, posture.tiltDeg, gravity, a.geoPanSign);

  // Pass 1: tilt from the reported pan (pan error still unknown). Cumulative
  // since characterize_imu, same as onReboot's solve.
  let t = tiltAt(posture.panDeg);
  if (t.residualDeg > MAX_TILT_RESIDUAL_DEG) {
    return record(a.calib, "reference", {
      applied: false, residualDeg: t.residualDeg,
      reason: `gravity does not fit an origin-only shift (residual ${t.residualDeg.toFixed(2)}deg) — the tripod appears to have moved; full recalibration required`,
    });
  }

  // Pass 2: pan, solved against the BASELINE orientation/boresight (R0/cHead0
  // adjusted by this pass's tilt estimate) -- so the result is the TOTAL pan
  // offset since the baseline solve, cumulative like tilt's, not an increment
  // on top of whatever a previous re-zero already assigned.
  const p = solvePanOffset(R0, applyTiltOffset(cHead0, t.deltaTiltDeg), a.geoPanSign,
                           refEnu, posture.panDeg, posture.tiltDeg);
  if (p.residualDeg > MAX_PAN_RESIDUAL_DEG) {
    return record(a.calib, "reference", {
      applied: false, deltaPanDeg: p.deltaPanDeg, residualDeg: p.residualDeg,
      reason: `reference does not fit an origin-only shift (residual ${p.residualDeg.toFixed(2)}deg) — wrong landmark centred, or the tripod moved`,
    });
  }

  // Pass 3: tilt again, now with the corrected pan. This is the pass that
  // removes the coupling error.
  t = tiltAt(posture.panDeg + p.deltaPanDeg);

  // ASSIGN the cumulative totals to the baseline offset -- setOriginOffset
  // (not applyRezero's absolute overwrite of R/cHead) is what makes re-zeroing
  // idempotent: running it again with the same inputs re-derives the same
  // totals and assigns the same result, rather than folding a fresh increment
  // onto an already-shifted calibration.
  a.calib.setOriginOffset(p.deltaPanDeg, t.deltaTiltDeg, a.bootId);

  // Shift BOTH axes through the same call, for uniformity -- see
  // applyLimitDelta's own comment. onReboot already moved tilt by its
  // first-pass estimate; this call shifts it the rest of the way (the small
  // pan-coupling refinement), so tilt and pan can never drift apart.
  //
  // Pan is different from tilt here: onReboot now CLEARS pan on every exit
  // path (operator decision, 2026-08-03 -- see onReboot's finish() comment),
  // so there is normally NOTHING for this call to shift on the pan axis --
  // shiftToOffset's per-edge `!== undefined` check makes that a clean no-op,
  // the same as the "pan never taught" case it already covered. The one case
  // where a pan edge IS present here is an operator re-teach during the
  // pending window (jog/teach_limit stay open -- rezeroGuard's comment); that
  // edge is stamped with a.bootId (the boot generation this re-zero is FOR,
  // set by onReboot's finish() before the re-teach could happen) and is
  // therefore skipped by shiftToOffset: it is already expressed in the
  // current frame and must not move. Both of these are asserted directly in
  // test/rezero-tools.test.ts rather than assumed.
  applyLimitDelta(a.limits, p.deltaPanDeg, t.deltaTiltDeg, a.bootId);

  return record(a.calib, "reference", {
    applied: true, deltaPanDeg: p.deltaPanDeg, deltaTiltDeg: t.deltaTiltDeg, residualDeg: p.residualDeg,
  });
}

// Automated motion must fail CLOSED while the origin is unknown; anything the
// operator is actively watching (jog, teach_limit) stays open, because they
// have to be able to drive to the landmark and to re-teach if they choose.
export function rezeroGuard(calib: CalibrationStore): string | undefined {
  if (!calib.needsRezero()) return undefined;
  return "the rig rebooted and its step origin is unknown, so pan/tilt no longer mean " +
    "what the calibration says — centre the stored landmark and call rezero_from_landmark " +
    "(or rezero_from_aircraft <hex>). Jog and teach_limit still work.";
}

// Same tolerance as solve_calibration's and set_north_zero's gravity paths
// (geo-tools.ts:319, imu-tools.ts:180) -- small mechanical settling between
// the before/after posture reads is normal and must not trip the guard.
const MOVE_TOL_DEG = 0.5;

type GravityReadResult = { gravity: Vec3; posture: RezeroPosture } | { error: string };

// Read posture, then gravity, then posture again, and refuse the pairing if
// anything about the posture is untrustworthy -- mirrors solve_calibration's
// and set_north_zero's before/after-plus-moving guard (geo-tools.ts:302-324,
// imu-tools.ts:203-220), which both carry the same comment this one does:
// the gravity burst takes real seconds, and a mount that moved during or
// around it must not silently pair a stale/moved posture with the sample
// that gets solved and PERSISTED. Also checks staleMs against
// MAX_POSTURE_STALE_MS (Task 5's onReboot convention) on both reads, since a
// WS disconnect mid-burst is the same class of untrustworthy pairing as a
// stale boot-time tick cache.
async function readGravityWithPosture(deps: RezeroDeps, toolName: string): Promise<GravityReadResult> {
  const before = await deps.posture();
  const gravity = await deps.gravity();
  if (!gravity) return { error: "no IMU gravity available — cannot solve a re-zero" };
  const after = await deps.posture();

  const staleMs = Math.max(before.staleMs, after.staleMs);
  if (staleMs > MAX_POSTURE_STALE_MS) {
    const age = staleMs === Infinity ? "disconnected" : `${Math.round(staleMs)}ms`;
    return {
      error: `posture is stale (${age} since the last tick, threshold ${MAX_POSTURE_STALE_MS}ms) — ` +
        "refusing to pair it with a fresh gravity read",
    };
  }
  if (before.moving || after.moving) {
    return { error: `the rig is moving — hold the mount still and re-run ${toolName}` };
  }
  if (
    Math.abs(before.panDeg - after.panDeg) > MOVE_TOL_DEG ||
    Math.abs(before.tiltDeg - after.tiltDeg) > MOVE_TOL_DEG
  ) {
    return { error: `the rig moved during the gravity read — hold the mount still and re-run ${toolName}` };
  }
  return { gravity, posture: after };
}

export function registerRezeroTools(server: McpServer, deps: RezeroDeps): void {
  const bootIdNow = (): number => deps.boot.bootId();

  server.registerTool(
    "set_landmark",
    {
      description:
        "Record the CURRENT pan/tilt as a fixed reference (a distant, unmoving landmark) for re-zeroing " +
        "after a reboot. Requires a solved (non-provisional) calibration — recording a reference from a " +
        "provisional orientation would bake the very error re-zero exists to correct into the thing used " +
        "to correct it. Only one landmark is kept; a later call replaces it.",
      inputSchema: { label: z.string().min(1).describe("name for this reference, e.g. a water tower or antenna") },
    },
    async ({ label }) => {
      if (deps.supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (deps.session.isActive()) return errText("tracking active; stop_tracking first");
      if (!deps.calib.isCalibrated()) {
        return errText("not calibrated — solve_calibration (or a gravity-anchored solve) first; a landmark recorded from an unsolved/provisional orientation would be untrustworthy");
      }
      const R = deps.calib.getOrientation()!;
      const cHead = deps.calib.getCHead() ?? [0, 1, 0];
      const { panDeg, tiltDeg, moving } = await deps.posture();
      // No gravity read here (set_landmark only records the current
      // boresight, it doesn't solve anything), so there is no before/after
      // pairing to protect -- just refuse a posture caught mid-slew, the
      // same single-point check onReboot applies to its own posture read.
      if (moving) return errText("the rig is moving — hold it still to record a landmark");
      const enu = boresightEnu(R, panDeg, tiltDeg, cHead, deps.cfg.geoPanSign);
      deps.calib.setLandmark({ label, enu, panDeg, tiltDeg, recordedAt: new Date().toISOString() });
      return text(JSON.stringify({
        label, pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
        note: "landmark recorded — after a reboot, re-centre it and call rezero_from_landmark.",
      }));
    },
  );

  server.registerTool(
    "rezero_from_landmark",
    {
      description:
        "Re-zero after a reboot using the stored landmark (see set_landmark). Aim the rig so the landmark " +
        "is centred, then call this with no arguments — it reads the current posture and IMU gravity itself.",
      inputSchema: {},
    },
    async () => {
      if (deps.supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (deps.session.isActive()) return errText("tracking active; stop_tracking first");
      const lm = deps.calib.getLandmark();
      if (!lm) {
        return errText("no landmark recorded — call set_landmark while calibration is still trusted, or use rezero_from_aircraft <hex> instead");
      }
      const read = await readGravityWithPosture(deps, "rezero_from_landmark");
      if ("error" in read) return errText(read.error);
      const res = await rezeroFromEnu(
        { calib: deps.calib, limits: deps.limits, geoPanSign: deps.cfg.geoPanSign, bootId: bootIdNow() },
        lm.enu, read.posture, read.gravity,
      );
      if (!res.applied) return errText(res.reason ?? "re-zero failed");
      return text(JSON.stringify({
        applied: true,
        delta_pan_deg: Number((res.deltaPanDeg as number).toFixed(3)),
        delta_tilt_deg: Number((res.deltaTiltDeg as number).toFixed(3)),
        residual_deg: Number((res.residualDeg as number).toFixed(3)),
      }));
    },
  );

  server.registerTool(
    "rezero_from_aircraft",
    {
      description:
        "Re-zero after a reboot using a currently-visible ADS-B aircraft as the reference, instead of a " +
        "stored landmark. Aim so the aircraft is centred, then call this — same fix, no set_landmark needed. " +
        "Refuses if the aircraft is not visible or its position report is stale.",
      inputSchema: { hex: z.string().min(1).describe("ICAO 24-bit hex address of the centred aircraft, e.g. a1b2c3") },
    },
    async ({ hex }) => {
      if (deps.supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (deps.session.isActive()) return errText("tracking active; stop_tracking first");
      const enu = await deps.aircraftEnu(hex);
      if (!enu) {
        return errText(`aircraft ${hex} is not usable as a re-zero reference — not currently visible, or its position report is stale/unknown`);
      }
      const read = await readGravityWithPosture(deps, "rezero_from_aircraft");
      if ("error" in read) return errText(read.error);
      const res = await rezeroFromEnu(
        { calib: deps.calib, limits: deps.limits, geoPanSign: deps.cfg.geoPanSign, bootId: bootIdNow() },
        enu, read.posture, read.gravity,
      );
      if (!res.applied) return errText(res.reason ?? "re-zero failed");
      return text(JSON.stringify({
        applied: true, hex,
        delta_pan_deg: Number((res.deltaPanDeg as number).toFixed(3)),
        delta_tilt_deg: Number((res.deltaTiltDeg as number).toFixed(3)),
        residual_deg: Number((res.residualDeg as number).toFixed(3)),
      }));
    },
  );

  server.registerTool(
    "get_rezero_status",
    {
      description:
        "Report re-zero state: whether a re-zero is pending, the boot generation it concerns, the stored " +
        "landmark's label (if any), which travel-limit axes currently have taught edges, and the most " +
        "recently solved offsets/residuals (from either a boot-time tilt solve or a landmark/aircraft " +
        "re-zero). Read-only. NOTE: SunSupervisor's sun-avoidance guard is deliberately NOT gated by a " +
        "pending re-zero (gating it would remove sun protection entirely, not just degrade it) -- it still " +
        "computes its sun-cone test and park plan from the current, unverified orientation. So while " +
        "needs_rezero is true here, treat sun protection as degraded: it can believe the boresight is safe " +
        "when the rig is actually pointed at the sun.",
      inputSchema: {},
    },
    async () => {
      const needsRezero = deps.calib.needsRezero();
      const landmark = deps.calib.getLandmark();
      const taught = deps.limits.get();
      const last = lastRezero.get(deps.calib);
      return text(JSON.stringify({
        needs_rezero: needsRezero,
        boot_id: deps.calib.getBootId() ?? null,
        landmark_label: landmark?.label ?? null,
        taught_axes: {
          pan: taught.panMin !== undefined || taught.panMax !== undefined,
          tilt: taught.tiltMin !== undefined || taught.tiltMax !== undefined,
        },
        last_rezero: last ? {
          kind: last.kind, at: last.atIso, applied: last.applied,
          delta_pan_deg: last.deltaPanDeg ?? null, delta_tilt_deg: last.deltaTiltDeg ?? null,
          residual_deg: last.residualDeg ?? null, reason: last.reason ?? null,
        } : null,
        // SunSupervisor is deliberately NOT gated by rezeroGuard (see this
        // tool's own description) -- it keeps computing its sun-cone test and
        // park plan from the current, unverified orientation, so sun
        // protection is degraded (it can call a sun-pointed boresight "safe")
        // for exactly as long as needs_rezero stays true.
        sun_guard: {
          degraded: needsRezero,
          note: needsRezero
            ? "sun protection is degraded — a re-zero is pending, so SunSupervisor's cone test is running " +
              "against an unverified orientation and can be wrong"
            : "sun protection normal — no re-zero pending",
        },
      }, null, 2));
    },
  );
}
