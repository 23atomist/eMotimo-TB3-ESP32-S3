import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Mat3, Vec3 } from "./geo/vec3.js";
import { fitCalibration, FitSighting, CalibrationFit, DEFAULT_SIGHTING_SIGMA_DEG } from "./geo/calibration-fit.js";
import { enuDirection } from "./geo/wgs84.js";

const SightingSchema = z.object({
  lat: z.number(), lon: z.number(), height: z.number(),
  label: z.string().optional(),
  panDeg: z.number(), tiltDeg: z.number(),
  // All three are optional so a profile written before this existed parses
  // unchanged; load() backfills `id` and leaves the rest absent.
  id: z.string().optional(),
  atIso: z.string().optional(),
  // 1σ expected angular error, computed once at sighting time from slant
  // range, ground speed and ADS-B report age. Absent → DEFAULT_SIGHTING_SIGMA_DEG.
  sigmaDeg: z.number().positive().optional(),
});
export type Sighting = z.infer<typeof SightingSchema>;

const ProfileSchema = z.object({
  version: z.literal(1),
  rig: z.object({ lat: z.number(), lon: z.number(), height: z.number() }).optional(),
  // Was .max(2). The two-sighting cap could not identify the camera boresight
  // and is the root cause of the 2026-08-16 43° cHead — see
  // docs/superpowers/specs/2026-08-16-n-sighting-calibration-design.md.
  // 200 is a file-size/solve-time bound, not a modelling one.
  sightings: z.array(SightingSchema).max(200).default([]),
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
  // The gravity anchor solve_calibration verified, in the mount frame.
  // Recorded separately from imuMounting.dBase so that characterize_imu's own
  // record stays untouched and its "live read disagrees with the stored
  // characterization" staleness check keeps its exact meaning.
  baseDown: z.array(z.number()).length(3).optional(),
  cHead: z.array(z.number()).length(3).optional(),
});
export type CalibrationProfile = z.infer<typeof ProfileSchema>;

// Monotonic within a process, random across processes: enough to key a
// dashboard delete button, and it never collides inside one profile.
let sightingSeq = 0;
function newSightingId(): string {
  sightingSeq += 1;
  return `s${Date.now().toString(36)}${sightingSeq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function empty(): CalibrationProfile {
  return { version: 1, sightings: [] };
}

export class CalibrationStore {
  private profile: CalibrationProfile = empty();
  private lastFit: CalibrationFit | null = null;
  // geoPanSign is needed to re-solve; defaulted so existing tests that
  // construct a store with just a path keep compiling.
  constructor(private readonly filePath: string, private readonly geoPanSign: number = 1) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.profile = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      const parsed = ProfileSchema.parse(raw);
      this.profile = {
        ...parsed,
        sightings: parsed.sightings.map((s) => (s.id ? s : { ...s, id: newSightingId() })),
      };
      this.resolve();
    } catch {
      // Missing/corrupt/invalid → start uncalibrated. Never throw.
      this.profile = empty();
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
  // Appends. Unlike the old two-sighting version this does NOT clear a solved
  // orientation: callers re-solve from the full list instead (see resolve()),
  // so there is never a window with sightings but no orientation. That window
  // was the 2026-07-29 field bug — taking a sighting killed every [Track]
  // button.
  addSighting(s: Sighting): number {
    const stamped: Sighting = {
      ...s,
      id: s.id ?? newSightingId(),
      atIso: s.atIso ?? new Date().toISOString(),
    };
    this.profile = { ...this.profile, sightings: [...this.profile.sightings, stamped] };
    this.save();
    this.resolve();
    return this.profile.sightings.length;
  }

  /** Remove one sighting by id. Returns false when nothing matched. */
  removeSighting(id: string): boolean {
    const before = this.profile.sightings.length;
    const sightings = this.profile.sightings.filter((s) => s.id !== id);
    if (sightings.length === before) return false;
    this.profile = { ...this.profile, sightings };
    this.save();
    this.resolve();
    return true;
  }

  /** Drop every sighting, keeping the rig location. The "rig moved" action. */
  clearSightings(): void {
    this.profile = { ...this.profile, sightings: [] };
    this.save();
    // An empty list makes resolve() a no-op, so the cached fit would otherwise
    // outlive the sightings it was computed from.
    this.lastFit = null;
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
    this.profile = { ...this.profile, orientation: flat, solvedAt: solvedAtIso, cHead: undefined, orientationProvisional: undefined };
    this.save();
  }

  // set_north_zero's setter: the operator declares the CURRENT pointing as
  // true-north/level, combined with the characterized IMU gravity fix, into a
  // complete but PROVISIONAL orientation -- a seed for drift calibration, not
  // a solved one. No cHead (same no-offset default every pre-gravity-cHead
  // caller already uses): there is no second sighting here to solve it from.
  setProvisionalOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, orientationProvisional: true, solvedAt: solvedAtIso, cHead: undefined };
    this.save();
  }

  isProvisional(): boolean {
    return this.profile.orientationProvisional === true;
  }

  getOrientation(): Mat3 | undefined {
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

  setBaseDown(v: Vec3): void {
    this.profile = { ...this.profile, baseDown: [v[0], v[1], v[2]] };
    this.save();
    this.resolve();
  }

  /** baseDown if solve_calibration has verified one, else characterize_imu's. */
  private gravityAnchor(): Vec3 | null {
    const b = this.profile.baseDown;
    if (b) return [b[0], b[1], b[2]];
    const m = this.getImuMounting();
    return m ? m.dBase : null;
  }

  getLastFit(): CalibrationFit | null { return this.lastFit; }

  /**
   * Re-fit heading and cHead from every stored sighting and persist the
   * result. The stored R/cHead are a cache of this fit, never independent
   * state, so this is the ONE place a calibration is produced.
   *
   * A no-op (returns null, touches nothing) without a rig location, without
   * sightings, or without a gravity anchor -- a profile carrying only a
   * set_north_zero provisional seed is left exactly as it is.
   */
  resolve(): CalibrationFit | null {
    const rig = this.profile.rig;
    const anchor = this.gravityAnchor();
    if (!rig || anchor === null || this.profile.sightings.length === 0) return null;

    const fitInput: FitSighting[] = this.profile.sightings.map((s) => ({
      panDeg: s.panDeg,
      tiltDeg: s.tiltDeg,
      enuUnit: enuDirection(rig, { lat: s.lat, lon: s.lon, height: s.height }).unit,
      sigmaDeg: s.sigmaDeg ?? DEFAULT_SIGHTING_SIGMA_DEG,
    }));

    let fit: CalibrationFit;
    try {
      fit = fitCalibration(anchor, fitInput, this.geoPanSign);
    } catch {
      return null;   // a degenerate list must never destroy a working profile
    }
    this.lastFit = fit;
    this.setGravityCalibration(fit.R, fit.cHead, new Date().toISOString());
    return fit;
  }

  setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = {
      ...this.profile, orientation: flat, cHead: [cHead[0], cHead[1], cHead[2]], solvedAt: solvedAtIso,
      orientationProvisional: undefined, // a real gravity+sightings solve supersedes a set_north_zero seed
    };
    this.save();
  }

  getCHead(): Vec3 | undefined {
    const c = this.profile.cHead;
    return c ? [c[0], c[1], c[2]] : undefined;
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
