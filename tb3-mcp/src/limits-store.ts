// Operator-taught travel limits: a tighter, per-edge override of the
// configured pan/tilt ceiling (config.ts's panMin/panMax/tiltMin/tiltMax),
// captured by jogging the rig to where a cable just begins to tension and
// recording that position (see limits-tools.ts's teach_limit). Persisted the
// same way CalibrationStore/SectorStore are: an atomic tmp+rename write,
// missing/corrupt file collapses to "nothing taught" rather than throwing.
//
// The config ceiling is the hardware-agnostic bound an operator picks from a
// spec sheet; the taught limit is what THIS rig's wiring actually tolerates,
// found by feel. A taught edge may only ever narrow the ceiling, never widen
// it — effectiveLimits() below is the one place that combines the two, and
// every caller that needs to know how far the rig may actually travel (rate
// jog, absolute moves, tracking, pointing) must go through it rather than
// reading config.ts's panMin/panMax/tiltMin/tiltMax directly. A limit
// enforced against only the config ceiling in some path and the effective
// value in another is exactly the gap this store exists to close.
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export type LimitEdge = "panMin" | "panMax" | "tiltMin" | "tiltMax";

const TaughtLimitsSchema = z.object({
  version: z.literal(1),
  panMin: z.number().optional(),
  panMax: z.number().optional(),
  tiltMin: z.number().optional(),
  tiltMax: z.number().optional(),
});
export type TaughtLimits = z.infer<typeof TaughtLimitsSchema>;

// The subset effectiveLimits()/LimitsStore actually need — deliberately NOT
// TaughtLimits (which also carries `version`), so a caller (TrackingSession's
// default limitsProvider, SunSupervisor's) can hand back a bare `{}` without
// having to fabricate a schema version for a value that is never persisted.
export interface TaughtEdges {
  panMin?: number;
  panMax?: number;
  tiltMin?: number;
  tiltMax?: number;
}

export interface CeilingLimits {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
}

function empty(): TaughtLimits {
  return { version: 1 };
}

// The effective pan/tilt range enforced everywhere: a taught edge if present,
// else the config ceiling on that side. Re-clamped to the ceiling HERE (not
// just at teach time in limits-tools.ts) so a config edit after teaching can
// only ever tighten what is enforced, never let a stale taught value silently
// widen past a newly-lowered ceiling.
export function effectiveLimits(ceiling: CeilingLimits, taught: TaughtEdges): CeilingLimits {
  return {
    panMin: taught.panMin !== undefined ? Math.max(taught.panMin, ceiling.panMin) : ceiling.panMin,
    panMax: taught.panMax !== undefined ? Math.min(taught.panMax, ceiling.panMax) : ceiling.panMax,
    tiltMin: taught.tiltMin !== undefined ? Math.max(taught.tiltMin, ceiling.tiltMin) : ceiling.tiltMin,
    tiltMax: taught.tiltMax !== undefined ? Math.min(taught.tiltMax, ceiling.tiltMax) : ceiling.tiltMax,
  };
}

export class LimitsStore {
  private limits: TaughtLimits = empty();
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.limits = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.limits = TaughtLimitsSchema.parse(raw);
    } catch {
      // Missing/corrupt/invalid → nothing taught (falls back to the config
      // ceiling everywhere). Never throw.
      this.limits = empty();
    }
  }

  get(): TaughtLimits {
    return { ...this.limits };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.limits, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  setEdge(edge: LimitEdge, value: number): void {
    this.limits = { ...this.limits, [edge]: value };
    this.save();
  }

  // set_home re-zeros the step origin (see tools.ts's set_home): every taught
  // edge was captured against the OLD zero and is now meaningless (possibly
  // dangerously so — a "tighter" limit under the old origin could sit
  // anywhere under the new one), so it must be invalidated exactly the way
  // set_home already invalidates CalibrationStore's orientation.
  clear(): void {
    this.limits = empty();
    this.save();
  }
}
