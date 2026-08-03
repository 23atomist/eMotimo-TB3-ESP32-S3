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
  setOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, solvedAt: solvedAtIso, cHead: undefined, orientationProvisional: undefined,
      // A fresh solve establishes a fresh baseline (zero offset) -- TRIAD-only,
      // so no cHead0 -- rather than leaving a prior one to be silently
      // shadowed-then-resurrected by migrateBaseline on the next reload. See
      // getCHead()'s comment on why cHead0 being absent still correctly
      // reports undefined rather than a fabricated vector.
      baseline: { R0: flat, cHead0: undefined }, originOffset: { panDeg: 0, tiltDeg: 0 },
    };
    this.save();
  }

  // set_north_zero's setter: the operator declares the CURRENT pointing as
  // true-north/level, combined with the characterized IMU gravity fix, into a
  // complete but PROVISIONAL orientation -- a seed for drift calibration, not
  // a solved one. No cHead (same no-offset default every pre-gravity-cHead
  // caller already uses): there is no second sighting here to solve it from.
  setProvisionalOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, orientationProvisional: true, solvedAt: solvedAtIso, cHead: undefined,
      // Same reasoning as setOrientation: establish a fresh (no-cHead)
      // baseline rather than clearing it.
      baseline: { R0: flat, cHead0: undefined }, originOffset: { panDeg: 0, tiltDeg: 0 },
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
  setBaseline(R0: Mat3, cHead0: Vec3, solvedAtIso: string): void {
    const flat = [R0[0][0], R0[0][1], R0[0][2], R0[1][0], R0[1][1], R0[1][2], R0[2][0], R0[2][1], R0[2][2]];
    this.profile = {
      ...this.profile,
      baseline: { R0: flat, cHead0: [cHead0[0], cHead0[1], cHead0[2]] },
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

  getOriginOffset(): { panDeg: number; tiltDeg: number } {
    return this.profile.originOffset ?? { panDeg: 0, tiltDeg: 0 };
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

  // rmsDeg is optional (not every caller has/needs it -- see test/calibration.test.ts's
  // existing 2-arg call sites) and purely informational: it never affects
  // R_s/d_base, only what get_calibration reports back.
  setImuMounting(rS: Mat3, dBase: Vec3, rmsDeg?: number): void {
    const flat = [rS[0][0], rS[0][1], rS[0][2], rS[1][0], rS[1][1], rS[1][2], rS[2][0], rS[2][1], rS[2][2]];
    this.profile = { ...this.profile, imuMounting: { rS: flat, dBase: [dBase[0], dBase[1], dBase[2]], rmsDeg } };
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

  setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string): void {
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
      baseline: { R0: flat, cHead0: cFlat }, originOffset: { panDeg: 0, tiltDeg: 0 },
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

  setLandmark(l: Landmark): void {
    this.profile = { ...this.profile, landmark: { ...l, enu: [l.enu[0], l.enu[1], l.enu[2]] } };
    this.save();
  }

  getLandmark(): Landmark | undefined {
    const l = this.profile.landmark;
    if (!l) return undefined;
    return { label: l.label, enu: [l.enu[0], l.enu[1], l.enu[2]], panDeg: l.panDeg, tiltDeg: l.tiltDeg, recordedAt: l.recordedAt };
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
