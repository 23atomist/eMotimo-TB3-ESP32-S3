import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { TrackSector, DISABLED_SECTOR } from "./track/sector.js";

const SectorSchema = z.object({
  enabled: z.boolean(),
  startDeg: z.number(),
  endDeg: z.number(),
});

export class SectorStore {
  private sector: TrackSector = { ...DISABLED_SECTOR };
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.sector = { ...DISABLED_SECTOR }; return; }
      this.sector = SectorSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      this.sector = { ...DISABLED_SECTOR };   // missing/corrupt → disabled; never throw
    }
  }

  get(): TrackSector { return { ...this.sector }; }

  set(sector: TrackSector): void {
    this.sector = { enabled: sector.enabled, startDeg: sector.startDeg, endDeg: sector.endDeg };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.sector, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
