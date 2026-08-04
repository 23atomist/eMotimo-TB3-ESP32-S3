import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Mat3, Vec3 } from "./geo/vec3.js";
import { applyPanOffset, applyTiltOffset } from "./geo/rezero.js";

const SightingSchema = z.object({
  lat: z.number(), lon: z.number(), height: z.number(),
  label: z.string().optional(),
  panDeg: z.number(), tiltDeg: z.number(),
});
export type Sighting = z.infer<typeof SightingSchema>;

const ProfileSchema = z.object({
  version: z.literal(1),
  rig: z.object({ lat: z.number(), lon: z.number(), height: z.number() }).optional(),
  sightings: z.array(SightingSchema).max(2).default([]),
  orientation: z.array(z.number()).length(9).optional(),
  // True only for a seed orientation from set_north_zero (gravity fixes
  // level+roll; the operator declares heading rather than a solved TRIAD/
  // gravity fit from real sightings). Absent/false for every other
  // orientation-setting path -- see setProvisionalOrientation/isCalibrated.
  orientationProvisional: z.boolean().optional(),
  solvedAt: z.string().optional(),
  imuMounting: z.object({
    rS: z.array(z.number()).length(9),
    dBase: z.array(z.number()).length(3),
    // characterize_imu's residual RMS (degrees) -- purely informational (the
    // dashboard's calibration step-gate shows it as the "IMU characterised"
    // step's detail line, see get_calibration in geo-tools.ts). Optional so a
    // profile persisted before this field existed still parses.
    rmsDeg: z.number().optional(),
    // Origin generation this mounting was solved under -- see the top-level
    // `bootId` field comment. Optional so a profile persisted before this
    // stamp existed still parses; getImuMountingGeneration() reports
    // undefined for it rather than a fabricated generation.
    bootId: z.number().optional(),
  }).optional(),
  cHead: z.array(z.number()).length(3).optional(),
  // Origin generation this profile was solved under. The firmware does not
  // persist step position, so a reboot silently moves the origin; comparing
  // this against the live bootId is what makes that visible in the file
  // itself rather than inferred at read time.
  bootId: z.number().optional(),
  needsRezero: z.boolean().optional(),
  // A fixed distant object recorded while calibration was trusted. Stored as
  // an ENU DIRECTION, not lat/lon: a terrestrial reference only needs a
  // bearing, and requiring the operator to know a tower's coordinates would
  // make the feature unusable.
  landmark: z.object({
    label: z.string(),
    enu: z.array(z.number()).length(3),
    panDeg: z.number(), tiltDeg: z.number(),
    recordedAt: z.string(),
    // Origin generation this landmark was recorded under -- see the
    // top-level `bootId` field comment. Optional so a profile persisted
    // before this stamp existed still parses.
    bootId: z.number().optional(),
  }).optional(),
  // The calibration exactly as solved, in the step-origin frame that solve was
  // performed in. Immutable until the next real solve. Every re-zero measures
  // against THIS, which is what makes applying one an assignment rather than an
  // accumulation -- run it N times with the same inputs and the state matches.
  //
  // cHead0 is optional: a TRIAD-only or provisional solve has no boresight
  // vector at all (see setOrientation/setProvisionalOrientation), and that is
  // a real, load-bearing "no cHead" state -- not something to default away.
  baseline: z.object({
    R0: z.array(z.number()).length(9),
    cHead0: z.array(z.number()).length(3).optional(),
    // Origin generation this baseline was established under -- see the
    // top-level `bootId` field comment. Optional so a profile persisted
    // before this stamp existed still parses (and so migrateBaseline's
    // legacy-adoption path, which has no generation to attach, stays valid).
    bootId: z.number().optional(),
    // T(baseline_gen): the tilt-READING offset (solveTiltOffset's raw
    // deltaTiltDeg) that was in force, relative to characterize_imu's
    // generation, at the moment THIS baseline was solved. solveTiltOffset
    // always measures against imuMounting.dBase -- which characterize_imu
    // sets and a re-zero never refreshes -- so its raw result is cumulative
    // since characterize_imu, not since this baseline. Subtracting this
    // anchor (getTiltAnchorDeg()) is what converts that raw reading into an
    // offset FROM THIS BASELINE, which is what setOriginOffset must be given.
    // Optional/defaulted to 0 so a profile persisted before this field
    // existed -- or a baseline solved at the characterize generation itself,
    // where T(baseline_gen) is genuinely 0 -- still behaves exactly as before.
    tiltAnchorDeg: z.number().optional(),
  }).optional(),
  // Cumulative offset from the baseline's step origin to the current one.
  // Zero at solve time. ASSIGNED by a re-zero, never incremented.
  originOffset: z.object({ panDeg: z.number(), tiltDeg: z.number() }).optional(),
});
export type CalibrationProfile = z.infer<typeof ProfileSchema>;

export interface Landmark {
  label: string; enu: Vec3; panDeg: number; tiltDeg: number; recordedAt: string;
}

function empty(): CalibrationProfile {
  return { version: 1, sightings: [] };
}

export class CalibrationStore {
  private profile: CalibrationProfile = empty();
  // geoPanSign is needed to derive getOrientation()'s pan-offset fold-in (see
  // applyPanOffset). Defaulting to 1 keeps every pre-baseline construction
  // site compiling; the real rig passes cfg.geoPanSign (see server.ts).
  constructor(private readonly filePath: string, private readonly geoPanSign: number = 1) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.profile = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.profile = ProfileSchema.parse(raw);
      this.migrateBaseline();
    } catch {
      // Missing/corrupt/invalid → start uncalibrated. Never throw.
      this.profile = empty();
    }
  }

  // A profile written before the baseline existed carries orientation/cHead
  // directly. Adopt them as the baseline with a zero offset: exactly correct
  // for a freshly-solved calibration, and no worse than the previous
  // behaviour for anything else. No operator action, no re-solve.
  //
  // cHead0 comes along as whatever profile.cHead currently is, INCLUDING
  // undefined -- since cHead0 is optional (see ProfileSchema), a TRIAD-only/
  // provisional legacy profile with no cHead correctly migrates to a baseline
  // with no cHead0, and getCHead() keeps reporting undefined rather than a
  // fabricated vector.
  private migrateBaseline(): void {
    if (!this.profile.baseline && this.profile.orientation) {
      this.profile = {
        ...this.profile,
        baseline: { R0: this.profile.orientation, cHead0: this.profile.cHead },
        originOffset: this.profile.originOffset ?? { panDeg: 0, tiltDeg: 0 },
      };
    }
  }

  get(): CalibrationProfile {
    return JSON.parse(JSON.stringify(this.profile));
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.profile, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  setRigLocation(lat: number, lon: number, height: number): void {
    this.profile = { version: 1, rig: { lat, lon, height }, sightings: [] };
    this.save();
  }

  // A new sighting invalidates a SOLVED orientation -- that solve was computed
  // from the sighting pair this call is changing, so keeping it would leave a
  // stale R paired with fresh sightings.
  //
  // It must NOT invalidate a PROVISIONAL one. The set_north_zero seed is a
  // bootstrap that exists precisely so the rig can track well enough to
  // collect sightings; it is not derived from them, so a sighting cannot
  // stale it. Clearing it here broke the guided procedure outright (field,
  // 2026-07-29): taking sighting 1 left the store reporting "provisional"
  // with no orientation behind it, so every aircraft row's [Track] went dead
  // and there was no way to track the SECOND plane the procedure needs.
  // [Sight] stayed live because it only needs a rig location -- which is
  // exactly the asymmetry the operator saw.
  addSighting(s: Sighting): number {
    const sightings = [...this.profile.sightings, s].slice(-2);
    this.profile = this.profile.orientationProvisional === true
      ? { ...this.profile, sightings }
      : {
        ...this.profile, sightings, orientation: undefined, solvedAt: undefined, cHead: undefined,
        // A stale baseline must not outlive the solved values it derived
        // from -- otherwise getOrientation()/getCHead() would keep deriving
        // from it and silently ignore this clear.
        baseline: undefined, originOffset: undefined,
      };
    this.save();
    return sightings.length;
  }

  // Replace the whole sighting list. Used to UNDO a sighting the tools reject
  // after it has been stored (see sight_aircraft's degenerate-pair refusal in
  // geo-tools.ts): the alternative is validating before storing, which would
  // mean duplicating the ENU/separation math at every call site.
  //
  // Deliberately does NOT touch the orientation: it is used to roll back to a
  // state the caller already had, not to invalidate a solve.
  replaceSightings(sightings: Sighting[]): void {
    this.profile = { ...this.profile, sightings: sightings.slice(-2) };
    this.save();
  }

  // TRIAD-only setter (no camera offset solved) -- clear any stale cHead from
  // a prior gravity solve, or a later re-solve here would leave the OLD
  // c_head paired with a NEW R, decoupled from each other. setGravityCalibration
  // is the with-cHead setter and sets its own. Also clears orientationProvisional:
  // a real 2-sighting TRIAD solve always supersedes a set_north_zero seed.
  // bootId: the origin generation this solve was performed under -- stamped
  // onto the fresh baseline it establishes (see ProfileSchema's `baseline`
  // field comment) so getBaselineGeneration() is meaningful for this,
  // solve_calibration's REAL production path, not just the literal
  // setBaseline() call other tests use to seed one directly.
  setOrientation(R: Mat3, solvedAtIso: string, bootId: number): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, solvedAt: solvedAtIso, cHead: undefined, orientationProvisional: undefined,
      // A fresh solve establishes a fresh baseline (zero offset) -- TRIAD-only,
      // so no cHead0 -- rather than leaving a prior one to be silently
      // shadowed-then-resurrected by migrateBaseline on the next reload. See
      // getCHead()'s comment on why cHead0 being absent still correctly
      // reports undefined rather than a fabricated vector.
      baseline: { R0: flat, cHead0: undefined, bootId }, originOffset: { panDeg: 0, tiltDeg: 0 },
      // This is a REAL solve (solve_calibration's TRIAD-only branch), so it
      // supersedes any pending re-zero and the landmark recorded under the
      // calibration that solve replaces -- same reasoning as setBaseline/
      // setGravityCalibration (Task 4 / finding I2).
      needsRezero: undefined, landmark: undefined,
    };
    this.save();
  }

  // set_north_zero's setter: the operator declares the CURRENT pointing as
  // true-north/level, combined with the characterized IMU gravity fix, into a
  // complete but PROVISIONAL orientation -- a seed for drift calibration, not
  // a solved one. No cHead (same no-offset default every pre-gravity-cHead
  // caller already uses): there is no second sighting here to solve it from.
  // bootId: same reasoning as setOrientation's -- set_north_zero is the
  // operator's normal post-reboot recovery path, so its own fresh (seed)
  // baseline must be stamped too, not just a real solve's.
  // tiltAnchorDeg: T(bootId) at this solve -- same reasoning as setBaseline's
  // own parameter (see its comment and ProfileSchema's `baseline.tiltAnchorDeg`
  // comment). set_north_zero already reads gravity to seed R, so its caller
  // (imu-tools.ts) passes solveTiltOffset's own reading here rather than
  // leaving the default 0, which would only be correct at the characterize
  // generation itself.
  setProvisionalOrientation(R: Mat3, solvedAtIso: string, bootId: number, tiltAnchorDeg = 0): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, orientationProvisional: true, solvedAt: solvedAtIso, cHead: undefined,
      // Same reasoning as setOrientation: establish a fresh (no-cHead)
      // baseline rather than clearing it.
      baseline: { R0: flat, cHead0: undefined, bootId, tiltAnchorDeg }, originOffset: { panDeg: 0, tiltDeg: 0 },
      // Fix round 1 finding: onReboot marks needsRezero unconditionally, so
      // set_north_zero is the operator's normal post-reboot path -- it
      // replaces the baseline from the CURRENT origin exactly like
      // setOrientation/setGravityCalibration do, so stale re-zero bookkeeping
      // (and any landmark, recorded under the calibration this supersedes)
      // must not outlive it either. This is a state-integrity fix, separate
      // from the seed-vs-solve distinction isCalibrated() draws: a provisional
      // orientation still correctly reads as uncalibrated for precision
      // pointing, it just isn't stale re-zero bookkeeping anymore. Leaving
      // this uncleared stranded the operator: rezeroGuard kept blocking
      // start_tracking/track_aircraft (the step set_north_zero's own
      // description says to do next), and its message pointed at
      // rezero_from_landmark, which fails immediately for a provisional
      // baseline (no cHead0) -- a dead end in exactly the state that
      // produces it.
      needsRezero: undefined, landmark: undefined,
    };
    this.save();
  }

  isProvisional(): boolean {
    return this.profile.orientationProvisional === true;
  }

  // The calibration exactly as solved, in the step-origin frame that solve
  // was performed in -- see ProfileSchema's `baseline` field comment. Set
  // ONLY by a fresh solve; a re-zero (setOriginOffset) never touches it,
  // which is what makes re-zeroing an assignment against a fixed reference
  // rather than an accumulation.
  // bootId: the origin generation this baseline was established under -- see
  // ProfileSchema's `baseline` field comment and getBaselineGeneration().
  // tiltAnchorDeg: T(bootId) -- the raw solveTiltOffset() reading (cumulative
  // since characterize_imu) in force at THIS solve -- see ProfileSchema's
  // `baseline.tiltAnchorDeg` comment and getTiltAnchorDeg(). Defaults to 0,
  // which is the correct value for a baseline solved at the characterize
  // generation itself (T(characterize_gen) = 0) and keeps every call site
  // that predates this parameter compiling unchanged.
  setBaseline(R0: Mat3, cHead0: Vec3, solvedAtIso: string, bootId: number, tiltAnchorDeg = 0): void {
    const flat = [R0[0][0], R0[0][1], R0[0][2], R0[1][0], R0[1][1], R0[1][2], R0[2][0], R0[2][1], R0[2][2]];
    this.profile = {
      ...this.profile,
      baseline: { R0: flat, cHead0: [cHead0[0], cHead0[1], cHead0[2]], bootId, tiltAnchorDeg },
      originOffset: { panDeg: 0, tiltDeg: 0 },
      solvedAt: solvedAtIso,
      // A fresh solve supersedes any pending re-zero and any landmark recorded
      // under the calibration being replaced.
      needsRezero: undefined, landmark: undefined,
    };
    this.save();
  }

  // cHead0 is optional -- see ProfileSchema's `baseline` field comment. A
  // TRIAD-only/provisional baseline genuinely has no boresight vector; that
  // is not the same thing as "no baseline at all" (undefined return here).
  getBaseline(): { R0: Mat3; cHead0?: Vec3 } | undefined {
    const b = this.profile.baseline;
    if (!b) return undefined;
    return {
      R0: [[b.R0[0], b.R0[1], b.R0[2]], [b.R0[3], b.R0[4], b.R0[5]], [b.R0[6], b.R0[7], b.R0[8]]],
      cHead0: b.cHead0 ? [b.cHead0[0], b.cHead0[1], b.cHead0[2]] : undefined,
    };
  }

  // Which origin generation the live baseline was established under -- see
  // ProfileSchema's `baseline` field comment. Undefined for a baseline
  // adopted by migrateBaseline from a pre-stamp legacy profile (no generation
  // was ever recorded for it) or before any baseline exists at all.
  getBaselineGeneration(): number | undefined {
    return this.profile.baseline?.bootId;
  }

  // T(baseline_gen) -- see ProfileSchema's `baseline.tiltAnchorDeg` comment.
  // Defaults to 0 (not undefined) when the field is absent: a profile
  // persisted before this field existed, or a baseline established by
  // setOrientation/setProvisionalOrientation/setGravityCalibration (which do
  // not yet stamp it), behaves exactly as it did before this getter existed
  // -- inert rather than refusing.
  getTiltAnchorDeg(): number {
    return this.profile.baseline?.tiltAnchorDeg ?? 0;
  }

  getOriginOffset(): { panDeg: number; tiltDeg: number } {
    return this.profile.originOffset ?? { panDeg: 0, tiltDeg: 0 };
  }

  // characterize_imu re-solves dBase from a fresh sweep taken at the CURRENTLY
  // active origin, which redefines T's reference epoch to right now -- i.e.
  // T_new(current) = 0 -- rather than characterize_imu's previous run. Every
  // T(.) computed against the OLD dBase (most visibly the baseline's own
  // T(baseline_gen) = tiltAnchorDeg) is relative to that old epoch and must
  // shift by the same amount to stay meaningful under the new one:
  // T_new(g) = T_old(g) - T_old(current), for every g.
  //
  // getOriginOffset().tiltDeg is exactly T_old(current) - tiltAnchorDeg_old --
  // see setOriginOffset's call site (rezero-tools.ts's onReboot/rezeroFromEnu):
  // it is the live drift the CURRENTLY effective calibration (baseline +
  // applied offset) is built from, measured under the OLD dBase, whether that
  // came from the last completed re-zero or is still {0,0} because none has
  // run since the baseline was solved. Substituting g = baseline_gen into the
  // shift above and solving for tiltAnchorDeg_new:
  //   tiltAnchorDeg_new = tiltAnchorDeg_old - T_old(current)
  //                      = tiltAnchorDeg_old - (originOffset.tiltDeg + tiltAnchorDeg_old)
  //                      = -originOffset.tiltDeg
  // -- the old anchor cancels out entirely, which is why this needs no
  // argument: it is self-contained given the store's own current state.
  //
  // Distinct from setImuMounting itself (see imu-tools.ts's runCharacterizeImu
  // call site) rather than folded into it: setImuMounting is also the
  // low-level setter a test can call to seed a mounting directly (e.g.
  // "re-solve after a re-zero" above), where re-anchoring would silently
  // rewrite a tiltAnchorDeg the test set up on purpose.
  //
  // No-op when there is no baseline yet -- nothing stamped a tiltAnchorDeg to
  // shift, and getOriginOffset() would report the profile-default {0,0}
  // regardless.
  reanchorTiltForCharacterize(): void {
    if (!this.profile.baseline) return;
    const tiltAnchorDeg = -this.getOriginOffset().tiltDeg;
    this.profile = {
      ...this.profile,
      baseline: { ...this.profile.baseline, tiltAnchorDeg },
    };
    this.save();
  }

  // ASSIGN. Never increment: the offsets handed here are cumulative from the
  // baseline, so assigning is what makes a re-zero idempotent -- run it N
  // times with the same measured deltas and the profile matches exactly.
  //
  // Throws rather than silently writing an offset nothing derives from: every
  // setter that establishes a calibration (setBaseline, setOrientation,
  // setProvisionalOrientation, setGravityCalibration) now also establishes a
  // baseline, so reaching here with none means a re-zero was attempted before
  // any calibration existed at all -- a caller bug, not a state worth
  // persisting silently (see Fix round 1's finding: an offset written with no
  // baseline to read it against is invisible until the NEXT reload's
  // migration happens to adopt one, at which point it starts applying with
  // no corresponding event).
  setOriginOffset(panDeg: number, tiltDeg: number, bootId: number): void {
    if (!this.profile.baseline) {
      throw new Error(
        "setOriginOffset: no baseline to offset from -- solve a calibration " +
        "(setBaseline/setOrientation/setGravityCalibration) before re-zeroing",
      );
    }
    this.profile = {
      ...this.profile, originOffset: { panDeg, tiltDeg },
      bootId, needsRezero: undefined,
    };
    this.save();
  }

  // DERIVED from baseline + originOffset (see ProfileSchema's field comments)
  // -- that is the whole point of Task 1: a re-zero after this point is an
  // ASSIGNMENT to originOffset, not a rewrite of the calibration itself, so
  // replaying the same re-zero N times can never accumulate drift. Every
  // solve path (setBaseline/setOrientation/setProvisionalOrientation/
  // setGravityCalibration) now establishes a baseline, so this is the live
  // path in practice.
  //
  // Falls back to the legacy `orientation` field only for the genuinely
  // unmigrated case -- a profile from before this field existed, read before
  // load() has run its migration (migrateBaseline resolves this on the very
  // next load()). At a zero offset this returns the baseline verbatim rather
  // than routing it through applyPanOffset, so a freshly-set baseline
  // round-trips bit-exact (no incidental floating-point noise from a no-op
  // rotation).
  getOrientation(): Mat3 | undefined {
    const b = this.getBaseline();
    if (b) {
      const off = this.getOriginOffset();
      return off.panDeg === 0 ? b.R0 : applyPanOffset(b.R0, off.panDeg, this.geoPanSign);
    }
    const o = this.profile.orientation;
    if (!o) return undefined;
    return [[o[0], o[1], o[2]], [o[3], o[4], o[5]], [o[6], o[7], o[8]]];
  }

  // rmsDeg is purely informational: it never affects R_s/d_base, only what
  // get_calibration reports back. Typed `number | undefined` (not `rmsDeg?`)
  // rather than made truly optional, because a required bootId must follow
  // it -- TypeScript forbids a required parameter after an optional one; see
  // test/calibration.test.ts's "no rmsDeg this time" call site for the
  // 2-value (rmsDeg undefined) shape this still supports.
  //
  // bootId is the origin generation this mounting was solved under -- see
  // ProfileSchema's `imuMounting` field comment and getImuMountingGeneration().
  setImuMounting(rS: Mat3, dBase: Vec3, rmsDeg: number | undefined, bootId: number): void {
    const flat = [rS[0][0], rS[0][1], rS[0][2], rS[1][0], rS[1][1], rS[1][2], rS[2][0], rS[2][1], rS[2][2]];
    this.profile = {
      ...this.profile,
      imuMounting: { rS: flat, dBase: [dBase[0], dBase[1], dBase[2]], rmsDeg, bootId },
    };
    this.save();
  }

  getImuMounting(): { rS: Mat3; dBase: Vec3; rmsDeg?: number } | undefined {
    const m = this.profile.imuMounting;
    if (!m) return undefined;
    const r = m.rS;
    return {
      rS: [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]],
      dBase: [m.dBase[0], m.dBase[1], m.dBase[2]],
      rmsDeg: m.rmsDeg,
    };
  }

  // Which origin generation the live IMU mounting was solved under -- see
  // ProfileSchema's `imuMounting` field comment.
  getImuMountingGeneration(): number | undefined {
    return this.profile.imuMounting?.bootId;
  }

  // bootId: the origin generation this solve was performed under -- stamped
  // onto the fresh baseline (see ProfileSchema's `baseline` field comment).
  // This is solve_calibration's gravity-anchored production path, so the
  // OVERWHELMING majority of real baselines are stamped here.
  // tiltAnchorDeg: T(bootId) at this solve -- same reasoning as setBaseline's
  // own parameter (see its comment and ProfileSchema's `baseline.tiltAnchorDeg`
  // comment). This gravity-anchored path already reads gravity to solve dBase
  // for R/cHead, so its caller (geo-tools.ts) passes solveTiltOffset's own
  // reading here rather than leaving the default 0, which would only be
  // correct at the characterize generation itself.
  setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string, bootId: number, tiltAnchorDeg = 0): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    const cFlat: [number, number, number] = [cHead[0], cHead[1], cHead[2]];
    this.profile = {
      ...this.profile, orientation: flat, cHead: cFlat, solvedAt: solvedAtIso,
      orientationProvisional: undefined, // a real gravity+sightings solve supersedes a set_north_zero seed
      // A real solve establishes a fresh baseline (zero offset) rather than
      // clearing it -- this is the production solve path (solve_calibration's
      // gravity branch), so a subsequent setOriginOffset (a completed re-zero)
      // must have a live baseline to assign against, not just whatever
      // migrateBaseline happens to adopt on the NEXT reload. Regression:
      // "setGravityCalibration -> setOriginOffset" below pins exactly this.
      baseline: { R0: flat, cHead0: cFlat, bootId, tiltAnchorDeg }, originOffset: { panDeg: 0, tiltDeg: 0 },
      // A real solve supersedes any pending re-zero and the landmark recorded
      // under the calibration it replaces (Task 4 / finding I2): without
      // this, an operator told "full recalibration required" who did exactly
      // that was still refused, with a diagnosis that was no longer true.
      needsRezero: undefined, landmark: undefined,
    };
    this.save();
  }

  // See getOrientation()'s comment: same derive-with-legacy-fallback shape,
  // mirrored for cHead/tilt. A baseline with no cHead0 (TRIAD-only/
  // provisional -- see ProfileSchema's `baseline` comment) correctly reports
  // undefined here, same as the legacy path always has.
  getCHead(): Vec3 | undefined {
    const b = this.getBaseline();
    if (b) {
      if (!b.cHead0) return undefined;
      const off = this.getOriginOffset();
      return off.tiltDeg === 0 ? b.cHead0 : applyTiltOffset(b.cHead0, off.tiltDeg);
    }
    const c = this.profile.cHead;
    return c ? [c[0], c[1], c[2]] : undefined;
  }

  getBootId(): number | undefined { return this.profile.bootId; }

  needsRezero(): boolean { return this.profile.needsRezero === true; }

  markRezeroNeeded(bootId: number): void {
    this.profile = { ...this.profile, bootId, needsRezero: true };
    this.save();
  }

  // bootId: the origin generation this landmark was recorded under -- see
  // ProfileSchema's `landmark` field comment and getLandmarkGeneration().
  setLandmark(l: Landmark, bootId: number): void {
    this.profile = { ...this.profile, landmark: { ...l, enu: [l.enu[0], l.enu[1], l.enu[2]], bootId } };
    this.save();
  }

  getLandmark(): Landmark | undefined {
    const l = this.profile.landmark;
    if (!l) return undefined;
    return { label: l.label, enu: [l.enu[0], l.enu[1], l.enu[2]], panDeg: l.panDeg, tiltDeg: l.tiltDeg, recordedAt: l.recordedAt };
  }

  // Which origin generation the live landmark was recorded under -- see
  // ProfileSchema's `landmark` field comment.
  getLandmarkGeneration(): number | undefined {
    return this.profile.landmark?.bootId;
  }

  clear(): void {
    this.profile = empty();
    this.save();
  }

  // set_home re-zeros the step origin. R and the sightings were recorded against
  // the OLD zero, so both are now wrong; keep the rig location (the tripod did not
  // move) and force a re-calibration.
  invalidateCalibration(): void {
    this.profile = {
      ...this.profile, sightings: [], orientation: undefined, solvedAt: undefined, cHead: undefined,
      orientationProvisional: undefined,
      // The baseline is "the calibration exactly as solved" -- it is now
      // exactly as wrong as orientation/cHead and must not outlive them.
      baseline: undefined, originOffset: undefined,
      // Task 4 / finding I2: a pending re-zero, its boot generation, and any
      // landmark must not survive this. needsRezero/bootId describe a step
      // origin drift measured against the calibration THIS call just wiped,
      // so keeping them makes point_at/start_tracking/track_aircraft refuse
      // with a diagnosis that is no longer true once a fresh solve completes
      // -- and worse, point the operator at rezero_from_landmark using a
      // landmark ENU derived from the discarded calibration's frame, applying
      // a re-zero offset on top of a freshly-solved good one.
      needsRezero: undefined, bootId: undefined, landmark: undefined,
    };
    this.save();
  }

  // Deliberately excludes a provisional (set_north_zero) orientation: it is a
  // seed heading, not a solved calibration, and must never be mistaken for
  // one by callers that gate precision pointing (point_at/point_at_azel) on
  // this flag. Tools that only need SOME orientation to track/point roughly
  // (start_tracking, track_aircraft, the tracking tick) check getOrientation()
  // directly instead, which returns the provisional R just fine.
  isCalibrated(): boolean {
    return this.profile.rig !== undefined && this.profile.orientation !== undefined
      && this.profile.orientationProvisional !== true;
  }
}
