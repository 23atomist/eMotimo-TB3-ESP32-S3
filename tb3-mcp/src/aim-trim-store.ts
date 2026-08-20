import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { AimOffset, ZERO_OFFSET, MAX_OFFSET_DEG } from "./track/offset.js";

// The STANDING aim trim: a persisted (panDeg, tiltDeg) correction that every
// new tracking pass starts from, instead of starting from zero.
//
// Why this exists separately from the per-pass nudge (track/offset.ts): the
// rig has a fixed camera-boresight error that the calibration fit cannot yet
// solve -- identifying c_head needs sighting geometry spread wider in azimuth
// than this mount's pan limits have so far allowed, so the fit correctly
// refuses to guess (see geo/calibration-fit.ts's under-determined fallback).
// Until it can, the operator re-dials the SAME correction at the start of
// every single pass. This holds that constant so they do not have to.
//
// It is deliberately NOT written into the calibration profile: the store
// re-solves and overwrites c_head from the sightings on every load, so a
// hand-set c_head would not survive -- and should not, because it would be an
// unearned number sitting in the middle of a solved model. This is an
// operator trim, stored and reported as one, and it stays visible as such
// until the fit can replace it honestly.
const TrimSchema = z.object({
  version: z.literal(1),
  panDeg: z.number(),
  tiltDeg: z.number(),
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class AimTrimStore {
  private trim: AimOffset = ZERO_OFFSET;

  // maxDeg matches the per-pass nudge ceiling for the same reason (see
  // track/offset.ts's MAX_OFFSET_DEG): a trim above trackReacquireDeg would
  // read as "lost track" on every tick.
  constructor(private readonly filePath: string, private readonly maxDeg: number = MAX_OFFSET_DEG) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.trim = ZERO_OFFSET; return; }
      const p = TrimSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      // Clamp on the way IN as well as on the way out: the file is plain JSON
      // an operator can edit, and an out-of-range value must not reach the
      // setpoint just because it arrived from disk instead of from a tool.
      this.trim = this.clamped(p.panDeg, p.tiltDeg);
    } catch {
      this.trim = ZERO_OFFSET;   // missing/corrupt → no trim; never throw
    }
  }

  private clamped(panDeg: number, tiltDeg: number): AimOffset {
    return {
      panDeg: clamp(panDeg, -this.maxDeg, this.maxDeg),
      tiltDeg: clamp(tiltDeg, -this.maxDeg, this.maxDeg),
    };
  }

  get(): AimOffset { return { ...this.trim }; }

  set(trim: AimOffset): AimOffset {
    this.trim = this.clamped(trim.panDeg, trim.tiltDeg);
    this.save();
    return this.get();
  }

  clear(): void {
    this.trim = ZERO_OFFSET;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.trim }, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
