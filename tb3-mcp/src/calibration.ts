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
  solvedAt: z.string().optional(),
  imuMounting: z.object({
    rS: z.array(z.number()).length(9),
    dBase: z.array(z.number()).length(3),
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

  addSighting(s: Sighting): number {
    const sightings = [...this.profile.sightings, s].slice(-2);
    this.profile = { ...this.profile, sightings, orientation: undefined, solvedAt: undefined, cHead: undefined };
    this.save();
    return sightings.length;
  }

  setOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, solvedAt: solvedAtIso };
    this.save();
  }

  getOrientation(): Mat3 | undefined {
    const o = this.profile.orientation;
    if (!o) return undefined;
    return [[o[0], o[1], o[2]], [o[3], o[4], o[5]], [o[6], o[7], o[8]]];
  }

  setImuMounting(rS: Mat3, dBase: Vec3): void {
    const flat = [rS[0][0], rS[0][1], rS[0][2], rS[1][0], rS[1][1], rS[1][2], rS[2][0], rS[2][1], rS[2][2]];
    this.profile = { ...this.profile, imuMounting: { rS: flat, dBase: [dBase[0], dBase[1], dBase[2]] } };
    this.save();
  }

  getImuMounting(): { rS: Mat3; dBase: Vec3 } | undefined {
    const m = this.profile.imuMounting;
    if (!m) return undefined;
    const r = m.rS;
    return { rS: [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]], dBase: [m.dBase[0], m.dBase[1], m.dBase[2]] };
  }

  setGravityCalibration(R: Mat3, cHead: Vec3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, cHead: [cHead[0], cHead[1], cHead[2]], solvedAt: solvedAtIso };
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
    this.profile = { ...this.profile, sightings: [], orientation: undefined, solvedAt: undefined, cHead: undefined };
    this.save();
  }

  isCalibrated(): boolean {
    return this.profile.rig !== undefined && this.profile.orientation !== undefined;
  }
}
