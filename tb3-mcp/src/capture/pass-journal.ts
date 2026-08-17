import { z } from "zod";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PassRecordSchema = z.object({
  id: z.string(),
  icao: z.string(),
  callsign: z.string().nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  snapshotFile: z.string().nullable(),

  category: z.string().nullable(),
  squawk: z.string().nullable(),
  gsKt: z.number().nullable(),
  maxAltitudeM: z.number().nullable(),

  minRangeM: z.number().nullable(),
  maxElevationDeg: z.number().nullable(),
  azStartDeg: z.number().nullable(),
  azEndDeg: z.number().nullable(),
  azArcDeg: z.number().nullable(),

  meanPointingErrorDeg: z.number().nullable(),
  maxPointingErrorDeg: z.number().nullable(),
  waitingMs: z.number(),
  limitHitMs: z.number(),
  samples: z.number(),
});

export type PassRecord = z.infer<typeof PassRecordSchema>;

/**
 * Append-only JSONL of completed passes.
 *
 * Written once at pass END and never updated in place -- that is what keeps
 * the file append-only and safe to read while the daemon is running. The
 * IN-PROGRESS pass is served from CaptureStatus instead, so a crash mid-pass
 * loses exactly one record rather than corrupting mutable on-disk state.
 *
 * A few hundred bytes per pass: a year of flying is a couple of MB.
 */
export class PassJournal {
  constructor(private readonly filePath: string) {}

  append(r: PassRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(r) + "\n");
  }

  /**
   * Every well-formed record, in write order. A line that is truncated (crash
   * mid-append), malformed, or missing required fields is SKIPPED rather than
   * failing the whole read: one bad line must never hide every good pass
   * behind it.
   */
  list(): PassRecord[] {
    if (!existsSync(this.filePath)) return [];
    const out: PassRecord[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(PassRecordSchema.parse(JSON.parse(trimmed)));
      } catch {
        // Unparseable or incomplete -- skip.
      }
    }
    return out;
  }
}
