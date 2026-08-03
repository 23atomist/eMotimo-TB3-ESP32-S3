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
  solveTiltOffset, solvePanOffset, applyTiltOffset, applyPanOffset,
  MAX_TILT_RESIDUAL_DEG, MAX_PAN_RESIDUAL_DEG,
} from "./geo/rezero.js";
import { text, errText } from "./tool-helpers.js";

// Injected so every path is testable without a rig.
export interface RezeroDeps {
  calib: CalibrationStore;
  limits: LimitsStore;
  boot: BootWatcher;
  cfg: Config;
  gravity: () => Promise<Vec3 | undefined>;  // mean gravity; undefined when the IMU is absent
  posture: () => Promise<{ panDeg: number; tiltDeg: number }>;
  aircraftEnu: (hex: string) => Promise<Vec3 | undefined>;
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
  posture: () => Promise<{ panDeg: number; tiltDeg: number }>;
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

// Pan edges taught before a reboot, captured the instant before onReboot
// clears them. onReboot must clear pan immediately (a stale limit is
// dangerous the moment the origin shifts, even before Delta-pan is known --
// see clearAxis's own doc comment), but the raw taught degrees are not
// meaningless once cleared: rezeroFromEnu needs exactly those numbers to
// shift by the now-known delta, or the operator would have to re-teach pan
// by hand after every single reboot even though nothing physically moved.
// In-memory only (not persisted -- if the daemon itself restarts between
// onReboot and the operator's re-zero, the stash is lost and pan stays
// untaught until re-taught by hand; that is a safe degradation, not silent
// corruption). Keyed by LimitsStore instance so independent stores/tests
// never see each other's stash.
const pendingPanEdges = new WeakMap<LimitsStore, { panMin?: number; panMax?: number }>();

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
  const finish = (r: RebootOutcome): RebootOutcome => {
    // Stash whatever is CURRENTLY taught before clearing it -- see
    // pendingPanEdges' doc comment. Only overwrite an existing stash when
    // there is something real to stash, so a second onReboot call (pan
    // already cleared from the first) can never clobber a good stash with
    // an empty one.
    const cur = a.limits.get();
    if (cur.panMin !== undefined || cur.panMax !== undefined) {
      pendingPanEdges.set(a.limits, { panMin: cur.panMin, panMax: cur.panMax });
    }
    a.limits.clearAxis("pan");        // unknown until Delta-pan is solved
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
  // applied to the stored edge must be the negated offset.
  a.limits.shiftAxis("tilt", -t.deltaTiltDeg);
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
  const R = a.calib.getOrientation(); const cHead = a.calib.getCHead();
  const imu = a.calib.getImuMounting();
  if (!R || !cHead || !imu) {
    return record(a.calib, "reference", { applied: false, reason: "no calibration to re-zero — solve one first" });
  }

  const tiltAt = (panDeg: number) =>
    solveTiltOffset(imu.rS, imu.dBase, panDeg, posture.tiltDeg, gravity, a.geoPanSign);

  // Pass 1: tilt from the reported pan (pan error still unknown).
  let t = tiltAt(posture.panDeg);
  if (t.residualDeg > MAX_TILT_RESIDUAL_DEG) {
    return record(a.calib, "reference", {
      applied: false, residualDeg: t.residualDeg,
      reason: `gravity does not fit an origin-only shift (residual ${t.residualDeg.toFixed(2)}deg) — the tripod appears to have moved; full recalibration required`,
    });
  }

  // Pass 2: pan, using a cHead corrected by that first tilt estimate.
  const p = solvePanOffset(R, applyTiltOffset(cHead, t.deltaTiltDeg), a.geoPanSign,
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

  a.calib.applyRezero(applyPanOffset(R, p.deltaPanDeg, a.geoPanSign),
                      applyTiltOffset(cHead, t.deltaTiltDeg), a.bootId);
  // Pan limits only. The tilt limits were already shifted by onReboot's
  // first-pass estimate and must NOT be shifted again here -- that would
  // double-apply. The refined Delta-tilt is worth having in cHead, where up
  // to 2deg matters for pointing, but not worth re-deriving in the limits,
  // where a 2deg difference is inside the margin a taught edge already
  // carries. Sign matches onReboot's tilt shift -- see its comment.
  //
  // shiftAxis alone cannot do this: onReboot already cleared pan (there was
  // nothing else it could safely do with Delta-pan still unknown), so there
  // is nothing left in the store to shift. Restore the pre-clear values from
  // the stash onReboot left behind and shift THOSE, then drop the stash --
  // it has done its job. No stash (pan was never taught, or the daemon
  // restarted since) means nothing to restore, same as shiftAxis's own
  // no-op-on-untaught behaviour.
  const stashed = pendingPanEdges.get(a.limits);
  if (stashed) {
    if (stashed.panMin !== undefined) a.limits.setEdge("panMin", stashed.panMin - p.deltaPanDeg);
    if (stashed.panMax !== undefined) a.limits.setEdge("panMax", stashed.panMax - p.deltaPanDeg);
    pendingPanEdges.delete(a.limits);
  }
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
      if (!deps.calib.isCalibrated()) {
        return errText("not calibrated — solve_calibration (or a gravity-anchored solve) first; a landmark recorded from an unsolved/provisional orientation would be untrustworthy");
      }
      const R = deps.calib.getOrientation()!;
      const cHead = deps.calib.getCHead() ?? [0, 1, 0];
      const { panDeg, tiltDeg } = await deps.posture();
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
      const lm = deps.calib.getLandmark();
      if (!lm) {
        return errText("no landmark recorded — call set_landmark while calibration is still trusted, or use rezero_from_aircraft <hex> instead");
      }
      const gravity = await deps.gravity();
      if (!gravity) return errText("no IMU gravity available — cannot solve a re-zero");
      const posture = await deps.posture();
      const res = await rezeroFromEnu(
        { calib: deps.calib, limits: deps.limits, geoPanSign: deps.cfg.geoPanSign, bootId: bootIdNow() },
        lm.enu, posture, gravity,
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
      const enu = await deps.aircraftEnu(hex);
      if (!enu) {
        return errText(`aircraft ${hex} is not usable as a re-zero reference — not currently visible, or its position report is stale/unknown`);
      }
      const gravity = await deps.gravity();
      if (!gravity) return errText("no IMU gravity available — cannot solve a re-zero");
      const posture = await deps.posture();
      const res = await rezeroFromEnu(
        { calib: deps.calib, limits: deps.limits, geoPanSign: deps.cfg.geoPanSign, bootId: bootIdNow() },
        enu, posture, gravity,
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
        "re-zero). Read-only.",
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
      }, null, 2));
    },
  );
}
