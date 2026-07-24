export interface TrackSector { enabled: boolean; startDeg: number; endDeg: number; }

export const DISABLED_SECTOR: TrackSector = { enabled: false, startDeg: 0, endDeg: 360 };

// Normalize any angle to [0, 360).
function norm360(deg: number): number { return ((deg % 360) + 360) % 360; }

// True if azDeg falls within the open arc that sweeps clockwise from startDeg
// to endDeg. A disabled sector admits everything. When start <= end the arc is
// the simple interval; when start > end the arc wraps through north (360/0).
export function inArc(azDeg: number, sector: TrackSector): boolean {
  if (!sector.enabled) return true;
  // A span of a full turn (e.g. start 0, end 360) is semantically "the whole
  // circle" — but norm360(360) collapses to 0, which would otherwise make
  // start<=end (0<=0) admit only bearing 0, indistinguishable from a genuine
  // zero-width arc (start === end). Guard on the *raw* span before normalizing
  // so a real zero-width arc (span 0) is unaffected.
  if (Math.abs(sector.endDeg - sector.startDeg) >= 360) return true;
  const az = norm360(azDeg);
  const start = norm360(sector.startDeg);
  const end = norm360(sector.endDeg);
  if (start <= end) return az >= start && az <= end;
  return az >= start || az <= end;
}
