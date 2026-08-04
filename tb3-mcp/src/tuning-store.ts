// Operator-adjustable runtime tuning: values an operator discovers are wrong
// WHILE using the rig (aim-trim clamp, video-latency compensation, tracking
// lead, snapshot timeout) — previously only changeable via deploy config +
// SSH + daemon restart. Persisted the same way SectorStore/LimitsStore are:
// an atomic tmp+rename write, missing/corrupt file collapses to "no
// overrides" rather than throwing.
//
// Every field is optional and absent means "fall through to the config
// value" — resolving overrides against config is a later task's job, not
// this store's, so no defaults are introduced here. That would make "unset"
// indistinguishable from "set to the default".
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const TuningSchema = z.object({
  maxAimOffsetDeg: z.number().positive().max(45).optional(),
  calibVideoLatencyMs: z.number().positive().max(5000).optional(),
  trackLeadMs: z.number().nonnegative().max(5000).optional(),
  captureTimeoutMs: z.number().int().positive().max(60000).optional(),
});

export type Tuning = z.infer<typeof TuningSchema>;

function empty(): Tuning {
  return {};
}

export class TuningStore {
  private tuning: Tuning = empty();
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.tuning = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.tuning = TuningSchema.parse(raw);
    } catch {
      // Missing/corrupt/invalid → no overrides (falls back to config
      // everywhere). Never throw.
      this.tuning = empty();
    }
  }

  get(): Tuning {
    return { ...this.tuning };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.tuning, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  // Merge-then-validate: the patch is applied to a candidate copy and
  // validated there first, so a rejected patch (e.g. maxAimOffsetDeg over
  // the schema's 45-degree ceiling) throws before touching either the
  // in-memory state or the file. A previously-good value must survive a
  // rejected patch untouched.
  set(patch: Tuning): void {
    const merged = { ...this.tuning, ...patch };
    this.tuning = TuningSchema.parse(merged);
    this.save();
  }

  clear(field: keyof Tuning): void {
    const next = { ...this.tuning };
    delete next[field];
    this.tuning = next;
    this.save();
  }
}
