export interface TrackSector { enabled: boolean; startDeg: number; endDeg: number; }

export const DISABLED_SECTOR: TrackSector = { enabled: false, startDeg: 0, endDeg: 360 };

// Normalize any angle to [0, 360).
function norm360(deg: number): number { return ((deg % 360) + 360) % 360; }

// True if azDeg falls within the open arc that sweeps clockwise from startDeg
// to endDeg. A disabled sector admits everything. When start <= end the arc is
// the simple interval; when start > end the arc wraps through north (360/0).
export function inArc(azDeg: number, sector: TrackSector): boolean {
  if (!sector.enabled) return true;
  const az = norm360(azDeg);
  const start = norm360(sector.startDeg);
  const end = norm360(sector.endDeg);
  if (start <= end) return az >= start && az <= end;
  return az >= start || az <= end;
}
