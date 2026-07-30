import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Mat3, Vec3 } from "./geo/vec3.js";

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
});
export type CalibrationProfile = z.infer<typeof ProfileSchema>;

function empty(): CalibrationProfile {
  return { version: 1, sightings: [] };
}

export class CalibrationStore {
  private profile: CalibrationProfile = empty();
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.profile = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.profile = ProfileSchema.parse(raw);
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
  addSighting(s: Sighting): number {
    const sightings = [...this.profile.sightings, s].slice(-2);
    this.profile = this.profile.orientationProvisional === true
      ? { ...this.profile, sightings }
      : { ...this.profile, sightings, orientation: undefined, solvedAt: undefined, cHead: undefined };
    this.save();
    return sightings.length;
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
