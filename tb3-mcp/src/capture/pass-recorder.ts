import { PassJournal, PassRecord } from "./pass-journal.js";
import { PassAggregator, PassSample } from "./pass-aggregate.js";
import type { Scheduler } from "../track/session.js";

export interface AircraftDetails {
  category: string | null;
  squawk: string | null;
  gsKt: number | null;
}

export interface PassRecorderDeps {
  /** One observation of the tracking session, right now. */
  sample(): PassSample;
  /** ADS-B identity fields for a hex, or null if it is not in the feed. */
  lookup(icao: string): AircraftDetails | null;
  /** The most recent snapshot path, used as the listing thumbnail. */
  lastSnapshot(): string | null;
  journal: Pick<PassJournal, "append" | "list">;
  now(): number;
  scheduler: Scheduler;
  sampleMs: number;
  /** MUST equal captureDebounceMs so the journal window matches the recording. */
  debounceMs: number;
  newId(): string;
}

interface OpenPass {
  id: string;
  icao: string;
  callsign: string | null;
  startedAtMs: number;
  agg: PassAggregator;
  details: AircraftDetails | null;
}

/**
 * Writes one journal record per pass, driven by the SAME
 * session.onStateChange seam CaptureController uses.
 *
 * Deliberately a separate listener rather than a hook inside
 * CaptureController: that class owns the record valve under a strict
 * never-await rule (it is called from the real-time tracking tick), and
 * metadata collection must not be able to destabilise it. The cost is that
 * the pass-bracketing debounce is implemented twice; both read the same
 * captureDebounceMs config value so they cannot drift.
 */
export class PassRecorder {
  private open: OpenPass | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private timer: { cancel(): void } | null = null;
  private lastSampleMs = 0;

  constructor(private readonly deps: PassRecorderDeps) {
    this.timer = deps.scheduler.every(deps.sampleMs, () => this.tick());
  }

  onTrack(state: string, icao: string | null, callsign: string | null = null): void {
    try {
      if (state === "tracking" && icao) {
        if (this.open && this.open.icao === icao) { this.cancelClose(); return; }
        if (this.open) this.finish();       // retargeted: close the old pass first
        this.begin(icao, callsign);
        return;
      }
      if (this.open !== null && this.closeTimer === null) {
        this.closeTimer = setTimeout(() => { this.closeTimer = null; this.finish(); }, this.deps.debounceMs);
      }
    } catch (e) {
      // Journalling must never break tracking. Report, never propagate.
      console.error("[tb3-pass] onTrack:", e instanceof Error ? e.message : String(e));
    }
  }

  dispose(): void {
    this.cancelClose();
    this.timer?.cancel();
    this.timer = null;
  }

  private begin(icao: string, callsign: string | null): void {
    this.cancelClose();
    const now = this.deps.now();
    this.lastSampleMs = now;
    this.open = {
      id: this.deps.newId(),
      icao,
      callsign,
      startedAtMs: now,
      agg: new PassAggregator(),
      details: this.deps.lookup(icao),
    };
  }

  private tick(): void {
    if (!this.open) return;
    try {
      const now = this.deps.now();
      const dt = Math.max(0, now - this.lastSampleMs);
      this.lastSampleMs = now;
      this.open.agg.sample(this.deps.sample(), dt);
      // Identity fields can arrive late (a callsign broadcast after lock), so
      // fill them in if they were absent at pass start.
      if (this.open.details === null) this.open.details = this.deps.lookup(this.open.icao);
    } catch (e) {
      console.error("[tb3-pass] sample:", e instanceof Error ? e.message : String(e));
    }
  }

  private finish(): void {
    const p = this.open;
    // Clear open-pass state BEFORE anything that can throw, so a failure
    // below can never wedge the recorder into believing a pass is still
    // open forever.
    this.open = null;
    this.cancelClose();
    if (!p) return;
    // The WHOLE body is guarded, not just journal.append(): this runs from
    // a bare setTimeout callback on the normal end-of-pass path (outside
    // onTrack's try/catch), and there is no process-level uncaughtException
    // handler in this daemon. lastSnapshot()/now() throwing here must not
    // become an uncaught exception that takes down the rig-controlling
    // process -- that would be strictly worse than the journalling failure
    // this guard exists to contain.
    try {
      const a = p.agg.result();
      const record: PassRecord = {
        id: p.id,
        icao: p.icao,
        callsign: p.callsign,
        startedAtMs: p.startedAtMs,
        endedAtMs: this.deps.now(),
        snapshotFile: this.deps.lastSnapshot(),
        category: p.details?.category ?? null,
        squawk: p.details?.squawk ?? null,
        gsKt: p.details?.gsKt ?? null,
        maxAltitudeM: a.maxAltitudeM,
        minRangeM: a.minRangeM,
        maxElevationDeg: a.maxElevationDeg,
        azStartDeg: a.azStartDeg,
        azEndDeg: a.azEndDeg,
        azArcDeg: a.azArcDeg,
        meanPointingErrorDeg: a.meanPointingErrorDeg,
        maxPointingErrorDeg: a.maxPointingErrorDeg,
        waitingMs: a.waitingMs,
        limitHitMs: a.limitHitMs,
        samples: a.samples,
      };
      this.deps.journal.append(record);
    } catch (e) {
      console.error("[tb3-pass] finish:", e instanceof Error ? e.message : String(e));
    }
  }

  private cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }
}
