import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { TrackFloor, DISABLED_FLOOR } from "./track/floor.js";

// z.number() already rejects NaN/Infinity only if asked -- .finite() is the
// ask. A non-finite floor would make aboveFloor()'s comparison meaningless
// (everything below +Infinity is refused; nothing is below -Infinity), so it
// must never reach the gate.
const FloorSchema = z.object({
  enabled: z.boolean(),
  minElevationDeg: z.number().finite(),
});

/**
 * Persistence for the tracking elevation floor. Deliberately a straight copy
 * of SectorStore's shape and failure behaviour -- the two are siblings (both
 * are tracking-only geometric gates) and an operator reasoning about one
 * should not have to learn different rules for the other.
 */
export class FloorStore {
  private floor: TrackFloor = { ...DISABLED_FLOOR };
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.floor = { ...DISABLED_FLOOR }; return; }
      this.floor = FloorSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      this.floor = { ...DISABLED_FLOOR };   // missing/corrupt → disabled; never throw
    }
  }

  get(): TrackFloor { return { ...this.floor }; }

  set(floor: TrackFloor): void {
    this.floor = { enabled: floor.enabled, minElevationDeg: floor.minElevationDeg };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.floor, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
