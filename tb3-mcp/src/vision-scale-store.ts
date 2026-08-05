// Persists calibrate_vision_scale's result (focalPx/latencyMs) across daemon
// restarts. Follows CalibrationStore/SectorStore/LimitsStore's own pattern
// exactly (this branch has no src/tuning-store.ts to follow instead): an
// atomic tmp-then-rename write, and load() collapsing any missing/corrupt/
// invalid file to "not yet calibrated" rather than throwing -- a corrupt
// file must never crash the daemon that owns tracking and drives the rig.
//
// Added in vision-lock fix round 2: the initial submission kept the scale in
// VisionRuntime, in memory only, which the reviewer correctly flagged --
// "persists the result" (the brief's own words) means surviving a restart,
// and every peer store in this codebase does. Without this, a restart
// silently drops back to no_scale until an operator re-runs a rig-moving
// calibration, with no indication anything was lost.
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistedVisionScale {
  focalPx: number;
  latencyMs: number;
}

// Shared by both the on-disk file schema (below) and set()'s own validation
// (fix round 3 / HIGH 2) -- one definition of "a scale that could actually
// have come out of a real calibration", not two that could drift apart.
// .finite() is not implied by z.number() alone (Infinity passes the bare
// type check). Mirrors solveStepResponse's own guard
// (`!Number.isFinite(focalPx) || focalPx <= 0` => refuse) so a value that
// could never have been PRODUCED by a real calibration can't be loaded (or
// written) as if it had been.
const PersistedVisionScaleSchema = z.object({
  focalPx: z.number().finite().positive(),
  latencyMs: z.number().finite().nonnegative(),
});

const VisionScaleFileSchema = PersistedVisionScaleSchema.extend({
  version: z.literal(1),
});

export class VisionScaleStore {
  private scale: PersistedVisionScale | null = null;
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.scale = null; return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      const parsed = VisionScaleFileSchema.parse(raw);
      this.scale = { focalPx: parsed.focalPx, latencyMs: parsed.latencyMs };
    } catch {
      // Missing/corrupt/invalid -> "not yet calibrated" (the corrector's
      // focalPx() reads null and refuses with "no_scale", same as a fresh
      // install that has never run calibrate_vision_scale). Never throw.
      this.scale = null;
    }
  }

  get(): PersistedVisionScale | null {
    return this.scale ? { ...this.scale } : null;
  }

  // FIX ROUND 3 / HIGH 2: the schema was load-only. Verified reachable:
  // set({focalPx: -5, latencyMs: 100}) used to succeed outright, overwriting
  // a previously-good calibration in BOTH memory and the file, silently --
  // the next boot's load() would then return null with no indication a good
  // calibration had ever existed. Not reachable from today's sole caller
  // (calibrate_vision_scale only ever passes solveStepResponse's own result,
  // which already guards !Number.isFinite(focalPx) || focalPx <= 0), but
  // this is shared public API and the validate-on-read-but-not-on-write
  // asymmetry is exactly what would bite the next caller. Validates and
  // THROWS before touching `this.scale` (unlike load(), which must never
  // throw): a rejected write must leave memory and the file both exactly as
  // they were, not silently drop a good calibration.
  set(scale: PersistedVisionScale): void {
    const validated = PersistedVisionScaleSchema.parse(scale);
    this.scale = { ...validated };
    this.save();
  }

  private save(): void {
    if (!this.scale) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.scale }, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }
}
