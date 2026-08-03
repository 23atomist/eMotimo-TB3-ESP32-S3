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
  bootId: z.number().optional(),
  appliedOffset: z.object({ panDeg: z.number(), tiltDeg: z.number() }).optional(),
  // The boot generation each edge was (re-)taught under -- see setEdge and
  // shiftToOffset. This is what lets an edge re-taught while a re-zero is
  // pending survive a later re-zero's shift: the edge is already expressed in
  // the CURRENT frame, and this stamp is the persisted signal that says so
  // (unlike the WeakMap snapshot Fix round 1 replaced, which only existed in
  // memory and could not survive a daemon restart).
  edgeBootId: z.object({
    panMin: z.number().optional(),
    panMax: z.number().optional(),
    tiltMin: z.number().optional(),
    tiltMax: z.number().optional(),
  }).optional(),
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
    return {
      ...this.limits,
      ...(this.limits.appliedOffset && { appliedOffset: { ...this.limits.appliedOffset } }),
      ...(this.limits.edgeBootId && { edgeBootId: { ...this.limits.edgeBootId } }),
    };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.limits, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  // Stamps the edge with the CURRENT boot generation (this.limits.bootId,
  // possibly still undefined if no reboot has happened yet) every time it is
  // (re-)taught -- see shiftToOffset's comment for why that stamp is what
  // protects a live re-teach from a later re-zero's shift.
  setEdge(edge: LimitEdge, value: number): void {
    this.limits = {
      ...this.limits, [edge]: value,
      edgeBootId: { ...this.limits.edgeBootId, [edge]: this.limits.bootId },
    };
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

  getBootId(): number | undefined {
    return this.limits.bootId;
  }

  setBootId(id: number): void {
    this.limits = { ...this.limits, bootId: id };
    this.save();
  }

  // Taught limits are stored in degrees against a step origin the firmware
  // does not persist. Once the origin shift is known, the limits move with it
  // -- so a reboot does not cost the operator a re-teach.
  shiftAxis(axis: "pan" | "tilt", deltaDeg: number): void {
    const lo = axis === "pan" ? "panMin" : "tiltMin";
    const hi = axis === "pan" ? "panMax" : "tiltMax";
    const next = { ...this.limits };
    if (next[lo] !== undefined) next[lo] = (next[lo] as number) + deltaDeg;
    if (next[hi] !== undefined) next[hi] = (next[hi] as number) + deltaDeg;
    this.limits = next;
    this.save();
  }

  // Used when an axis's origin shift is not yet known. A stale limit is worse
  // than none: it can block escape in one direction while permitting a drive
  // into the hard stop in the other.
  clearAxis(axis: "pan" | "tilt"): void {
    const next = { ...this.limits };
    if (axis === "pan") { delete next.panMin; delete next.panMax; }
    else { delete next.tiltMin; delete next.tiltMax; }
    this.limits = next;
    this.save();
  }

  getAppliedOffset(): { panDeg: number; tiltDeg: number } {
    return { ...(this.limits.appliedOffset ?? { panDeg: 0, tiltDeg: 0 }) };
  }

  setAppliedOffset(panDeg: number, tiltDeg: number): void {
    this.limits = { ...this.limits, appliedOffset: { panDeg, tiltDeg } };
    this.save();
  }

  // Shift every currently-taught edge to the given cumulative offset -- by
  // only the part it does not already carry (against getAppliedOffset(), read
  // fresh every call so a daemon restart can never lose track) -- EXCEPT an
  // edge stamped with THIS boot generation (see setEdge). That edge was
  // (re-)taught while this boot generation was already live, so its value is
  // already expressed in the CURRENT frame; shifting it again would silently
  // clobber a correct, freshly-taught reading.
  //
  // Fix round 1, Finding 1: the first delta-shift draft applied the same
  // delta to every taught edge unconditionally, on the theory that "nothing
  // to clear" meant "nothing further to protect." That reproduced the exact
  // clobber the old WeakMap stash existed to prevent (teach panMin=-90,
  // reboot, re-teach panMin=-70, re-zero -> unconditional shift produced
  // -86.4). Recording the offset in effect at teach time does not fix this
  // either -- the pan offset is genuinely unknown at teach time, before a
  // landmark has been sighted. What IS known immediately is which origin
  // generation the edge belongs to, which is exactly what this stamp
  // records, and it is persisted (unlike the old stash), so it survives a
  // daemon restart between teach and re-zero.
  shiftToOffset(panTotal: number, tiltTotal: number, bootId: number): void {
    const prev = this.getAppliedOffset();
    const stamp = this.limits.edgeBootId ?? {};
    const next = { ...this.limits };
    if (panTotal !== prev.panDeg) {
      const d = -(panTotal - prev.panDeg);
      if (next.panMin !== undefined && stamp.panMin !== bootId) next.panMin = next.panMin + d;
      if (next.panMax !== undefined && stamp.panMax !== bootId) next.panMax = next.panMax + d;
    }
    if (tiltTotal !== prev.tiltDeg) {
      const d = -(tiltTotal - prev.tiltDeg);
      if (next.tiltMin !== undefined && stamp.tiltMin !== bootId) next.tiltMin = next.tiltMin + d;
      if (next.tiltMax !== undefined && stamp.tiltMax !== bootId) next.tiltMax = next.tiltMax + d;
    }
    this.limits = { ...next, appliedOffset: { panDeg: panTotal, tiltDeg: tiltTotal } };
    this.save();
  }
}
