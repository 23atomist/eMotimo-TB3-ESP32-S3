export interface Posture { panDeg: number; tiltDeg: number }

interface Sample { tMs: number; panDeg: number; tiltDeg: number }

const DEFAULT_CAPACITY = 600; // 60s at the 10Hz telemetry rate

export class PostureHistory {
  private buf: Sample[] = [];
  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  record(tMs: number, panDeg: number, tiltDeg: number): void {
    const newest = this.buf[this.buf.length - 1];
    // Out-of-order arrivals are dropped: an unsorted buffer would make the
    // binary search below return neighbours that do not bracket tMs.
    if (newest !== undefined && tMs <= newest.tMs) return;
    this.buf.push({ tMs, panDeg, tiltDeg });
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  oldestMs(): number | null { return this.buf.length ? this.buf[0].tMs : null; }
  newestMs(): number | null { return this.buf.length ? this.buf[this.buf.length - 1].tMs : null; }

  postureAt(tMs: number): Posture | null {
    // NaN defeats BOTH range comparisons below (NaN < a and NaN > b are each
    // false), so without this a NaN exposure time interpolates to a NaN
    // posture that looks like a successful lookup.
    if (!Number.isFinite(tMs)) return null;
    if (this.buf.length === 0) return null;
    // Refuse outside the recorded span. Clamping to an end would hand back a
    // posture from a different pointing direction and look like success.
    if (tMs < this.buf[0].tMs) return null;
    if (tMs > this.buf[this.buf.length - 1].tMs) return null;

    let lo = 0, hi = this.buf.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[mid].tMs <= tMs) lo = mid; else hi = mid;
    }
    const a = this.buf[lo], b = this.buf[hi];
    if (tMs === a.tMs) return { panDeg: a.panDeg, tiltDeg: a.tiltDeg };
    if (tMs === b.tMs) return { panDeg: b.panDeg, tiltDeg: b.tiltDeg };
    const f = (tMs - a.tMs) / (b.tMs - a.tMs);
    return {
      panDeg: a.panDeg + f * (b.panDeg - a.panDeg),
      tiltDeg: a.tiltDeg + f * (b.tiltDeg - a.tiltDeg),
    };
  }
}
