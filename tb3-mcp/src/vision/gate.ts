import { PixelOffset } from "./geometry.js";

export interface Candidate { dxPx: number; dyPx: number; conf: number }
export type GateReject = "no_candidates" | "none_near_prediction" | "ambiguous";
export type GateResult = { accepted: Candidate } | { rejected: GateReject };

export function gateDetections(
  cands: Candidate[], predicted: PixelOffset, radiusPx: number, minConf: number,
): GateResult {
  const confident = cands.filter((c) => c.conf >= minConf);
  if (confident.length === 0) return { rejected: "no_candidates" };

  const near = confident.filter((c) => {
    const dx = c.dxPx - predicted.dxPx, dy = c.dyPx - predicted.dyPx;
    return Math.hypot(dx, dy) <= radiusPx;
  });
  if (near.length === 0) return { rejected: "none_near_prediction" };
  // Two survivors give no basis to choose. Guessing is how a wrong lock
  // persists across cycles; contributing nothing costs one cycle.
  if (near.length > 1) return { rejected: "ambiguous" };
  return { accepted: near[0] };
}
