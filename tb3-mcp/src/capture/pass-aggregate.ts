import { wrapDeg180 } from "../track/control.js";

/** One 2Hz observation of a pass in progress. */
export interface PassSample {
  state: string;
  targetAzimuthDeg: number | null;
  targetElevationDeg: number | null;
  targetRangeM: number | null;
  pointingErrorDeg: number | null;
  panLimited: boolean;
  tiltLimited: boolean;
  altitudeM: number | null;
}

export interface PassAggregates {
  minRangeM: number | null;
  maxElevationDeg: number | null;
  azStartDeg: number | null;
  azEndDeg: number | null;
  azArcDeg: number | null;
  maxAltitudeM: number | null;
  meanPointingErrorDeg: number | null;
  maxPointingErrorDeg: number | null;
  waitingMs: number;
  limitHitMs: number;
  samples: number;
}

/**
 * Folds 2Hz samples of a pass into the numbers the playback listing filters
 * on. Every accumulator is null-safe: a sample missing a field contributes
 * nothing to that field rather than being treated as zero, so a few null
 * pointing errors cannot drag the mean down.
 */
export class PassAggregator {
  private minRange: number | null = null;
  private maxEl: number | null = null;
  private azStart: number | null = null;
  private azLast: number | null = null;
  private azArc = 0;
  private maxAlt: number | null = null;
  private errSum = 0;
  private errCount = 0;
  private maxErr: number | null = null;
  private waitingMs = 0;
  private limitHitMs = 0;
  private count = 0;

  sample(s: PassSample, dtMs: number): void {
    this.count++;

    if (s.targetRangeM !== null && (this.minRange === null || s.targetRangeM < this.minRange)) {
      this.minRange = s.targetRangeM;
    }
    if (s.targetElevationDeg !== null && (this.maxEl === null || s.targetElevationDeg > this.maxEl)) {
      this.maxEl = s.targetElevationDeg;
    }
    if (s.altitudeM !== null && (this.maxAlt === null || s.altitudeM > this.maxAlt)) {
      this.maxAlt = s.altitudeM;
    }

    // Arc accumulates the SHORT-WAY step between consecutive samples, so a
    // pass crossing north reads 30 degrees rather than 330.
    if (s.targetAzimuthDeg !== null) {
      if (this.azStart === null) this.azStart = s.targetAzimuthDeg;
      if (this.azLast !== null) this.azArc += Math.abs(wrapDeg180(s.targetAzimuthDeg - this.azLast));
      this.azLast = s.targetAzimuthDeg;
    }

    if (s.pointingErrorDeg !== null) {
      this.errSum += s.pointingErrorDeg;
      this.errCount++;
      if (this.maxErr === null || s.pointingErrorDeg > this.maxErr) this.maxErr = s.pointingErrorDeg;
    }

    if (s.state === "waiting") this.waitingMs += dtMs;
    if (s.panLimited || s.tiltLimited) this.limitHitMs += dtMs;
  }

  result(): PassAggregates {
    return {
      minRangeM: this.minRange,
      maxElevationDeg: this.maxEl,
      azStartDeg: this.azStart,
      azEndDeg: this.azLast,
      azArcDeg: this.azStart === null ? null : this.azArc,
      maxAltitudeM: this.maxAlt,
      meanPointingErrorDeg: this.errCount === 0 ? null : this.errSum / this.errCount,
      maxPointingErrorDeg: this.maxErr,
      waitingMs: this.waitingMs,
      limitHitMs: this.limitHitMs,
      samples: this.count,
    };
  }
}
