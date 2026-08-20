import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const RangeSchema = z.object({ maxRangeKm: z.number().positive() });

/**
 * The operator's maximum tracking range, in km. Daemon-side rather than
 * dashboard-side on purpose: the autonomous agent runs in its own process and
 * must apply the same bound the operator set in the browser, so this has to be
 * one shared source of truth. Same shape as SectorStore.
 */
export class RangeStore {
  private maxRangeKm: number;
  constructor(private readonly filePath: string, private readonly defaultKm: number) {
    this.maxRangeKm = defaultKm;
  }

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.maxRangeKm = this.defaultKm; return; }
      this.maxRangeKm = RangeSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))).maxRangeKm;
    } catch {
      this.maxRangeKm = this.defaultKm;   // missing/corrupt → default; never throw
    }
  }

  get(): number { return this.maxRangeKm; }

  set(km: number): void {
    const parsed = RangeSchema.parse({ maxRangeKm: km });
    this.maxRangeKm = parsed.maxRangeKm;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ maxRangeKm: this.maxRangeKm }, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
