# Recordings Index and Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every recorded pass queryable metadata — identity, framing geometry and tracking quality — and a browsable playback section with filters, streaming playback, and a keep action that survives MediaMTX's 7-day purge.

**Architecture:** The daemon writes an append-only pass journal (JSONL) driven by the existing `session.onStateChange` seam, sampling `TrackingSession.status()` at 2 Hz. A pure join function maps journal records to mp4 files by time window, so MediaMTX keeps owning its directory and its retention policy. The dashboard scans the media directories, runs the shared join, and serves listing/video/keep over HTTP. Keep is a hardlink — same filesystem, zero extra bytes.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Zod, Express 4, Vitest, Node 24 on the rig host. Vanilla JS + no build step for dashboard frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-recordings-index-design.md`

## Global Constraints

- Recording filenames are **host-local time** (`%Y-%m-%d_%H-%M-%S-%f`); snapshot filenames are **UTC ISO with colons replaced by dashes**. Never convert one with the other's rules.
- `snapshotPath` (src/capture/snapshot.ts) emits **two shapes**: `hex-CALLSIGN-iso.jpg` and `hex-iso.jpg` (callsign omitted when null, blank, or equal to the hex). The parser must accept both.
- `CaptureController` is **not modified**. It runs under a never-await rule from the real-time tracking tick.
- Never concatenate a client-supplied string into a filesystem path. Route `:id` values resolve through the scanned index or 404.
- `recordingRetentionHours` default `168`, mirroring the deployed `recordDeleteAfter: 168h`.
- Pass debounce must equal `captureDebounceMs` (5000) so the journal window matches the recording window.
- Run tests with `npm test` from `tb3-mcp/`. One file: `npx vitest run test/<file>.test.ts`.
- Conventional commits: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. Commit after every task.

## File Structure

| File | Responsibility |
|---|---|
| `src/capture/pass-journal.ts` | `PassRecord` type + append-only JSONL read/write |
| `src/capture/pass-aggregate.ts` | Folds `TrackStatus` samples into pass aggregates |
| `src/capture/pass-recorder.ts` | Brackets passes off `onStateChange`, drives sampling, writes the journal |
| `src/recordings/names.ts` | Filename parsing/formatting (recording, snapshot, keep) |
| `src/recordings/join.ts` | Pure `joinRecordings` |
| `src/recordings/scan.ts` | Directory scans → `RecordingFile[]`, snapshot → synthesised passes |
| `src/recordings/keep.ts` | Hardlink keep / unkeep with `EXDEV` fallback |
| `src/dashboard/recordings-routes.ts` | Express routes, id resolution, range streaming |
| `dashboard/public/playback.html` / `playback.js` / `playback.css` | The playback section |

---

### Task 1: Pass journal

**Files:**
- Create: `tb3-mcp/src/capture/pass-journal.ts`
- Test: `tb3-mcp/test/pass-journal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PassRecord` interface, `PassRecordSchema` (Zod), `class PassJournal { constructor(filePath: string); append(r: PassRecord): void; list(): PassRecord[] }`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/pass-journal.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { PassJournal, PassRecord } from "../src/capture/pass-journal.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3pass-"));
  return join(dir, "sub", "passes.jsonl");
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function rec(over: Partial<PassRecord> = {}): PassRecord {
  return {
    id: "p1", icao: "a082ac", callsign: "AAL556",
    startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_060_000,
    snapshotFile: "/var/lib/tb3/snapshots/a082ac-AAL556-x.jpg",
    category: "A3", squawk: "1200", gsKt: 240, maxAltitudeM: 3000,
    minRangeM: 5700, maxElevationDeg: 31.2,
    azStartDeg: 350, azEndDeg: 40, azArcDeg: 50,
    meanPointingErrorDeg: 1.3, maxPointingErrorDeg: 2.9,
    waitingMs: 0, limitHitMs: 0, samples: 120,
    ...over,
  };
}

describe("PassJournal", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(new PassJournal(tmpFile()).list()).toEqual([]);
  });

  it("appends and reads back in order, creating nested dirs", () => {
    const f = tmpFile();
    const j = new PassJournal(f);
    j.append(rec({ id: "p1" }));
    j.append(rec({ id: "p2" }));
    const got = new PassJournal(f).list();
    expect(got.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(got[0].callsign).toBe("AAL556");
  });

  it("skips a truncated final line instead of throwing", () => {
    const f = tmpFile();
    const j = new PassJournal(f);
    j.append(rec({ id: "p1" }));
    // Simulate a crash mid-write.
    writeFileSync(f, readFileSync(f, "utf8") + '{"id":"p2","icao":"aaa', { flag: "a" });
    const got = new PassJournal(f).list();
    expect(got.map((r) => r.id)).toEqual(["p1"]);
  });

  it("skips a record missing required fields rather than failing the whole read", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ id: "bad" }) + "\n" + JSON.stringify(rec({ id: "good" })) + "\n");
    expect(new PassJournal(f).list().map((r) => r.id)).toEqual(["good"]);
  });

  it("tolerates unknown fields from a future version", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ ...rec(), somethingNew: 42 }) + "\n");
    expect(new PassJournal(f).list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pass-journal.test.ts`
Expected: FAIL — cannot resolve `../src/capture/pass-journal.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/capture/pass-journal.ts`:

```ts
import { z } from "zod";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const PassRecordSchema = z.object({
  id: z.string(),
  icao: z.string(),
  callsign: z.string().nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  snapshotFile: z.string().nullable(),

  category: z.string().nullable(),
  squawk: z.string().nullable(),
  gsKt: z.number().nullable(),
  maxAltitudeM: z.number().nullable(),

  minRangeM: z.number().nullable(),
  maxElevationDeg: z.number().nullable(),
  azStartDeg: z.number().nullable(),
  azEndDeg: z.number().nullable(),
  azArcDeg: z.number().nullable(),

  meanPointingErrorDeg: z.number().nullable(),
  maxPointingErrorDeg: z.number().nullable(),
  waitingMs: z.number(),
  limitHitMs: z.number(),
  samples: z.number(),
});

export type PassRecord = z.infer<typeof PassRecordSchema>;

/**
 * Append-only JSONL of completed passes.
 *
 * Written once at pass END and never updated in place -- that is what keeps
 * the file append-only and safe to read while the daemon is running. The
 * IN-PROGRESS pass is served from CaptureStatus instead, so a crash mid-pass
 * loses exactly one record rather than corrupting mutable on-disk state.
 *
 * A few hundred bytes per pass: a year of flying is a couple of MB.
 */
export class PassJournal {
  constructor(private readonly filePath: string) {}

  append(r: PassRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(r) + "\n");
  }

  /**
   * Every well-formed record, in write order. A line that is truncated (crash
   * mid-append), malformed, or missing required fields is SKIPPED rather than
   * failing the whole read: one bad line must never hide every good pass
   * behind it.
   */
  list(): PassRecord[] {
    if (!existsSync(this.filePath)) return [];
    const out: PassRecord[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(PassRecordSchema.parse(JSON.parse(trimmed)));
      } catch {
        // Unparseable or incomplete -- skip.
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pass-journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/capture/pass-journal.ts tb3-mcp/test/pass-journal.test.ts
git commit -m "feat(capture): append-only pass journal

One record per completed pass, written at pass end. A truncated or
malformed line is skipped rather than failing the read, so a crash
mid-append cannot hide every good pass behind it."
```

---

### Task 2: Pass aggregation

**Files:**
- Create: `tb3-mcp/src/capture/pass-aggregate.ts`
- Test: `tb3-mcp/test/pass-aggregate.test.ts`

**Interfaces:**
- Consumes: `TrackStatus` from `src/track/session.js`.
- Produces: `class PassAggregator { sample(s: PassSample, dtMs: number): void; result(): PassAggregates }`, `interface PassSample`, `interface PassAggregates`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/pass-aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PassAggregator, PassSample } from "../src/capture/pass-aggregate.js";

const s = (over: Partial<PassSample> = {}): PassSample => ({
  state: "tracking",
  targetAzimuthDeg: 10, targetElevationDeg: 20, targetRangeM: 10000,
  pointingErrorDeg: 1, panLimited: false, tiltLimited: false,
  altitudeM: 3000,
  ...over,
});

describe("PassAggregator", () => {
  it("tracks the closest range and the highest elevation", () => {
    const a = new PassAggregator();
    a.sample(s({ targetRangeM: 12000, targetElevationDeg: 10 }), 500);
    a.sample(s({ targetRangeM: 5000, targetElevationDeg: 31 }), 500);
    a.sample(s({ targetRangeM: 8000, targetElevationDeg: 22 }), 500);
    const r = a.result();
    expect(r.minRangeM).toBe(5000);
    expect(r.maxElevationDeg).toBe(31);
  });

  it("accumulates azimuth arc across the north wrap", () => {
    const a = new PassAggregator();
    a.sample(s({ targetAzimuthDeg: 350 }), 500);
    a.sample(s({ targetAzimuthDeg: 355 }), 500);
    a.sample(s({ targetAzimuthDeg: 5 }), 500);   // wrapped past north
    a.sample(s({ targetAzimuthDeg: 20 }), 500);
    const r = a.result();
    expect(r.azStartDeg).toBe(350);
    expect(r.azEndDeg).toBe(20);
    expect(r.azArcDeg).toBeCloseTo(30, 6);   // 5 + 10 + 15, never 330
  });

  it("computes mean and max pointing error over samples that have one", () => {
    const a = new PassAggregator();
    a.sample(s({ pointingErrorDeg: 1 }), 500);
    a.sample(s({ pointingErrorDeg: 3 }), 500);
    a.sample(s({ pointingErrorDeg: null }), 500);   // ignored, not counted as 0
    const r = a.result();
    expect(r.meanPointingErrorDeg).toBeCloseTo(2, 6);
    expect(r.maxPointingErrorDeg).toBe(3);
  });

  it("counts time spent waiting and time spent against a limit", () => {
    const a = new PassAggregator();
    a.sample(s({ state: "tracking" }), 500);
    a.sample(s({ state: "waiting" }), 500);
    a.sample(s({ state: "waiting" }), 500);
    a.sample(s({ state: "tracking", tiltLimited: true }), 500);
    const r = a.result();
    expect(r.waitingMs).toBe(1000);
    expect(r.limitHitMs).toBe(500);
  });

  it("returns nulls rather than NaN when nothing was sampled", () => {
    const r = new PassAggregator().result();
    expect(r.minRangeM).toBeNull();
    expect(r.maxElevationDeg).toBeNull();
    expect(r.meanPointingErrorDeg).toBeNull();
    expect(r.azArcDeg).toBeNull();
    expect(r.samples).toBe(0);
  });

  it("keeps the highest altitude seen", () => {
    const a = new PassAggregator();
    a.sample(s({ altitudeM: 2000 }), 500);
    a.sample(s({ altitudeM: 4200 }), 500);
    expect(a.result().maxAltitudeM).toBe(4200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pass-aggregate.test.ts`
Expected: FAIL — cannot resolve `../src/capture/pass-aggregate.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/capture/pass-aggregate.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pass-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/capture/pass-aggregate.ts tb3-mcp/test/pass-aggregate.test.ts
git commit -m "feat(capture): fold pass samples into framing and quality aggregates

Azimuth arc accumulates the short-way step between samples, so a pass
crossing north reads 30 degrees rather than 330. Every accumulator is
null-safe: a missing field contributes nothing rather than zero."
```

---

### Task 3: Pass recorder

**Files:**
- Create: `tb3-mcp/src/capture/pass-recorder.ts`
- Test: `tb3-mcp/test/pass-recorder.test.ts`

**Interfaces:**
- Consumes: `PassJournal`, `PassRecord` (Task 1); `PassAggregator`, `PassSample` (Task 2); `Scheduler` from `src/track/session.js`.
- Produces: `class PassRecorder { onTrack(state: string, icao: string | null, callsign?: string | null): void; dispose(): void }`, `interface PassRecorderDeps`, `interface AircraftDetails`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/pass-recorder.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { PassRecorder, PassRecorderDeps } from "../src/capture/pass-recorder.js";
import { PassRecord } from "../src/capture/pass-journal.js";
import { PassSample } from "../src/capture/pass-aggregate.js";

function harness(sample: () => PassSample) {
  let now = 1_000_000;
  const written: PassRecord[] = [];
  const ticks: (() => void)[] = [];
  const deps: PassRecorderDeps = {
    sample,
    lookup: () => ({ category: "A3", squawk: "1200", gsKt: 240 }),
    lastSnapshot: () => "/snap/a082ac-AAL556-x.jpg",
    journal: { append: (r: PassRecord) => { written.push(r); }, list: () => written },
    now: () => now,
    scheduler: { every: (_ms, fn) => { ticks.push(fn); return { cancel: () => {} }; } },
    sampleMs: 500,
    debounceMs: 5000,
    newId: () => "pass-1",
  };
  return {
    written,
    rec: new PassRecorder(deps),
    tick: (n = 1) => { for (let i = 0; i < n; i++) { now += 500; ticks.forEach((f) => f()); } },
    advance: (ms: number) => { now += ms; },
  };
}

const base: PassSample = {
  state: "tracking", targetAzimuthDeg: 10, targetElevationDeg: 20,
  targetRangeM: 8000, pointingErrorDeg: 1.2, panLimited: false, tiltLimited: false,
  altitudeM: 3000,
};

describe("PassRecorder", () => {
  it("writes one record when a pass ends", () => {
    vi.useFakeTimers();
    const h = harness(() => base);
    h.rec.onTrack("tracking", "a082ac", "AAL556");
    h.tick(4);
    h.rec.onTrack("stopped", null);
    vi.advanceTimersByTime(5000);
    expect(h.written).toHaveLength(1);
    expect(h.written[0].icao).toBe("a082ac");
    expect(h.written[0].callsign).toBe("AAL556");
    expect(h.written[0].samples).toBe(4);
    expect(h.written[0].minRangeM).toBe(8000);
    expect(h.written[0].category).toBe("A3");
    expect(h.written[0].snapshotFile).toBe("/snap/a082ac-AAL556-x.jpg");
    vi.useRealTimers();
  });

  it("does not fragment a pass that flaps through waiting", () => {
    vi.useFakeTimers();
    const h = harness(() => base);
    h.rec.onTrack("tracking", "a082ac", "AAL556");
    h.tick(2);
    h.rec.onTrack("waiting", "a082ac");
    vi.advanceTimersByTime(1000);            // under the debounce
    h.rec.onTrack("tracking", "a082ac", "AAL556");
    h.tick(2);
    h.rec.onTrack("stopped", null);
    vi.advanceTimersByTime(5000);
    expect(h.written).toHaveLength(1);
    vi.useRealTimers();
  });

  it("starts a new record when the target changes", () => {
    vi.useFakeTimers();
    const h = harness(() => base);
    h.rec.onTrack("tracking", "aaa111", "ONE");
    h.tick(2);
    h.rec.onTrack("tracking", "bbb222", "TWO");
    h.tick(2);
    h.rec.onTrack("stopped", null);
    vi.advanceTimersByTime(5000);
    expect(h.written.map((r) => r.icao)).toEqual(["aaa111", "bbb222"]);
    vi.useRealTimers();
  });

  it("never throws out of onTrack when the journal fails", () => {
    vi.useFakeTimers();
    const h = harness(() => base);
    // Replace append with a thrower AFTER construction.
    (h.rec as unknown as { deps: PassRecorderDeps }).deps.journal.append = () => { throw new Error("disk full"); };
    h.rec.onTrack("tracking", "a082ac", "AAL556");
    h.tick(1);
    expect(() => { h.rec.onTrack("stopped", null); vi.advanceTimersByTime(5000); }).not.toThrow();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pass-recorder.test.ts`
Expected: FAIL — cannot resolve `../src/capture/pass-recorder.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/capture/pass-recorder.ts`:

```ts
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
    this.open = null;
    this.cancelClose();
    if (!p) return;
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
    try {
      this.deps.journal.append(record);
    } catch (e) {
      console.error("[tb3-pass] journal append:", e instanceof Error ? e.message : String(e));
    }
  }

  private cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pass-recorder.test.ts`
Expected: PASS. If the "never throws" test cannot reach `deps` (it is private), change that test to build its own throwing `journal` in the harness instead of mutating after construction.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/capture/pass-recorder.ts tb3-mcp/test/pass-recorder.test.ts
git commit -m "feat(capture): pass recorder writing one journal record per pass

Rides the same session.onStateChange seam CaptureController uses, as a
separate listener: CaptureController owns the record valve under a
never-await rule from the real-time tick, and metadata collection must
not be able to destabilise it. Both debounces read captureDebounceMs so
the journal window matches the recording window."
```

---

### Task 4: Filename parsing

**Files:**
- Create: `tb3-mcp/src/recordings/names.ts`
- Test: `tb3-mcp/test/recording-names.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRecordingName(name: string): number | null`, `parseSnapshotName(name: string): { icao: string; callsign: string | null; atMs: number } | null`, `keepFileName(startedAtMs: number, callsign: string | null, icao: string): string`, `parseKeepName(name: string): { atMs: number; callsign: string | null; icao: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/recording-names.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRecordingName, parseSnapshotName, keepFileName } from "../src/recordings/names.js";

describe("parseRecordingName", () => {
  it("parses MediaMTX's %Y-%m-%d_%H-%M-%S-%f as LOCAL time", () => {
    const ms = parseRecordingName("2026-08-16_19-16-12-734710.mp4");
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);        // August
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(19);       // LOCAL hours, not UTC
    expect(d.getMinutes()).toBe(16);
    expect(d.getSeconds()).toBe(12);
  });

  it("includes the microsecond field as milliseconds", () => {
    const ms = parseRecordingName("2026-08-16_19-16-12-734710.mp4");
    expect(new Date(ms!).getMilliseconds()).toBe(734);
  });

  it("rejects anything that is not a recording name", () => {
    expect(parseRecordingName("notes.txt")).toBeNull();
    expect(parseRecordingName("2026-08-16.mp4")).toBeNull();
    expect(parseRecordingName("../../etc/passwd")).toBeNull();
  });
});

describe("parseSnapshotName", () => {
  it("parses the hex-CALLSIGN-iso form as UTC", () => {
    const got = parseSnapshotName("a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg");
    expect(got).not.toBeNull();
    expect(got!.icao).toBe("a082ac");
    expect(got!.callsign).toBe("AAL556");
    expect(got!.atMs).toBe(Date.parse("2026-08-17T02:09:37.664Z"));
  });

  it("parses the hex-iso form, where no callsign was broadcast", () => {
    const got = parseSnapshotName("ab627c-2026-08-17T02-09-37.664Z.jpg");
    expect(got).not.toBeNull();
    expect(got!.icao).toBe("ab627c");
    expect(got!.callsign).toBeNull();
  });

  it("does not confuse the date's dashes with the field separators", () => {
    // The ISO segment itself contains dashes; a naive split on "-" breaks here.
    const got = parseSnapshotName("0d1139-AMX792-2026-08-16T00-41-44.768Z.jpg");
    expect(got!.icao).toBe("0d1139");
    expect(got!.callsign).toBe("AMX792");
    expect(got!.atMs).toBe(Date.parse("2026-08-16T00:41:44.768Z"));
  });

  it("rejects non-snapshot names", () => {
    expect(parseSnapshotName("manual.jpg")).toBeNull();
    expect(parseSnapshotName("2026-08-16_19-16-12-734710.mp4")).toBeNull();
  });
});

describe("local/UTC asymmetry", () => {
  it("treats identical clock text differently for the two schemes", () => {
    // Same wall-clock text; recording names are LOCAL, snapshots are UTC, so
    // these must NOT be equal unless the host runs UTC.
    const rec = parseRecordingName("2026-08-16_12-00-00-000000.mp4")!;
    const snap = parseSnapshotName("aaa111-2026-08-16T12-00-00.000Z.jpg")!.atMs;
    const offsetMs = new Date(2026, 7, 16, 12).getTimezoneOffset() * 60_000;
    expect(snap - rec).toBe(-offsetMs);
  });
});

describe("keepFileName", () => {
  it("builds a sortable, self-describing name", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, "AAL556", "a082ac")).toBe("2026-08-16T19-16-12_AAL556_a082ac.mp4");
  });

  it("omits the callsign when there is none", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, null, "a082ac")).toBe("2026-08-16T19-16-12_a082ac.mp4");
  });

  it("sanitises identity segments so they cannot escape the directory", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, "../../etc", "a/b")).toBe("2026-08-16T19-16-12_etc_ab.mp4");
  });
});

describe("parseKeepName", () => {
  it("round-trips keepFileName, recovering the ORIGINAL start time", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const got = parseKeepName(keepFileName(ms, "AAL556", "a082ac"));
    expect(got).not.toBeNull();
    expect(got!.atMs).toBe(ms);
    expect(got!.callsign).toBe("AAL556");
    expect(got!.icao).toBe("a082ac");
  });

  it("round-trips the no-callsign form", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const got = parseKeepName(keepFileName(ms, null, "a082ac"));
    expect(got!.callsign).toBeNull();
    expect(got!.icao).toBe("a082ac");
    expect(got!.atMs).toBe(ms);
  });

  it("rejects a MediaMTX name and anything else", () => {
    expect(parseKeepName("2026-08-16_19-16-12-734710.mp4")).toBeNull();
    expect(parseKeepName("whatever.mp4")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/recording-names.test.ts`
Expected: FAIL — cannot resolve `../src/recordings/names.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/recordings/names.ts`:

```ts
// MediaMTX recordPath is "%Y-%m-%d_%H-%M-%S-%f", rendered in HOST-LOCAL time.
const RECORDING_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{1,6})\.mp4$/;

// src/capture/snapshot.ts writes "<hex>[-<CALLSIGN>]-<iso>.jpg" where <iso> is
// a UTC ISO string with every ":" replaced by "-". The ISO segment contains
// its own dashes, so this is anchored on the ISO shape rather than split on
// "-": the date part would otherwise be indistinguishable from a separator.
const SNAPSHOT_RE =
  /^([0-9a-fA-F]+?)(?:-([A-Za-z0-9_]+))?-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z)\.jpg$/;

/**
 * Epoch ms for a MediaMTX recording filename, or null if it is not one.
 *
 * Constructed with the local-time Date constructor ON PURPOSE: MediaMTX
 * renders strftime in the host's timezone, and the deployed host runs MST.
 * Parsing these as UTC would shift every recording by the UTC offset and
 * silently mis-associate passes near the boundary.
 */
export function parseRecordingName(name: string): number | null {
  const m = RECORDING_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  // %f is microseconds, left-padded to 6; take the leading 3 as milliseconds.
  const ms = Number(frac.padEnd(6, "0").slice(0, 3));
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Identity and UTC instant from a snapshot filename, or null. */
export function parseSnapshotName(
  name: string,
): { icao: string; callsign: string | null; atMs: number } | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, icao, callsign, isoDashed] = m;
  // Undo snapshot.ts's ":" -> "-" substitution: only the TIME part's two
  // separators were colons; the date's dashes are original.
  const [datePart, timePart] = isoDashed.split("T");
  const iso = `${datePart}T${timePart.replace("-", ":").replace("-", ":")}`;
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return null;
  return { icao, callsign: callsign ?? null, atMs };
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Name for a kept recording: sortable, and identifiable outside the dashboard
 * entirely. Local time, matching the recording name it came from.
 */
export function keepFileName(startedAtMs: number, callsign: string | null, icao: string): string {
  const d = new Date(startedAtMs);
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const cs = callsign ? sanitizeSegment(callsign) : "";
  const hex = sanitizeSegment(icao) || "unknown";
  return cs === "" ? `${stamp}_${hex}.mp4` : `${stamp}_${cs}_${hex}.mp4`;
}

// keepFileName's own shape, read back. Segments are [A-Za-z0-9_]-sanitized, so
// the LAST underscore-separated field is the hex and anything between it and
// the timestamp is the callsign.
const KEEP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})_(?:([A-Za-z0-9]+)_)?([A-Za-z0-9]+)\.mp4$/;

/**
 * Recover a kept file's ORIGINAL pass start time and identity.
 *
 * Without this, a kept file would fall back to its mtime for a start time --
 * and mtime is when the LINK was made, not when the pass happened, so every
 * kept recording would drift out of its pass's window and show up
 * unattributed. The keep name is the only surviving record of the original
 * instant once MediaMTX has purged the source.
 */
export function parseKeepName(
  name: string,
): { atMs: number; callsign: string | null; icao: string } | null {
  const m = KEEP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, callsign, icao] = m;
  const atMs = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  if (!Number.isFinite(atMs)) return null;
  return { atMs, callsign: callsign ?? null, icao };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/recordings/names.ts tb3-mcp/test/recording-names.test.ts
git commit -m "feat(recordings): filename parsing for both naming schemes

MediaMTX recording names are host-LOCAL strftime; snapshot names are UTC
ISO with colons replaced by dashes. Parsing either with the other's rules
shifts every timestamp by the UTC offset, so the asymmetry is pinned by a
test. The snapshot pattern is anchored on the ISO shape rather than split
on '-', since the date part is otherwise indistinguishable from a field
separator."
```

---

### Task 5: The join

**Files:**
- Create: `tb3-mcp/src/recordings/join.ts`
- Test: `tb3-mcp/test/recording-join.test.ts`

**Interfaces:**
- Consumes: `PassRecord` (Task 1).
- Produces: `interface RecordingFile`, `type PassSource`, `type VideoState`, `interface PassListing`, `joinRecordings(passes: PassRecord[], files: RecordingFile[], opts: JoinOptions): PassListing[]`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/recording-join.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { joinRecordings, RecordingFile } from "../src/recordings/join.js";
import { PassRecord } from "../src/capture/pass-journal.js";

const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function pass(over: Partial<PassRecord> = {}): PassRecord {
  return {
    id: "p1", icao: "a082ac", callsign: "AAL556",
    startedAtMs: T, endedAtMs: T + 2 * MIN, snapshotFile: null,
    category: null, squawk: null, gsKt: null, maxAltitudeM: null,
    minRangeM: null, maxElevationDeg: null,
    azStartDeg: null, azEndDeg: null, azArcDeg: null,
    meanPointingErrorDeg: null, maxPointingErrorDeg: null,
    waitingMs: 0, limitHitMs: 0, samples: 0,
    ...over,
  };
}

function file(over: Partial<RecordingFile> = {}): RecordingFile {
  return {
    id: "f1", path: "/rec/a.mp4", name: "a.mp4",
    startedAtMs: T + 1000, endedAtMs: T + 2 * MIN, sizeBytes: 1000, kept: false,
    ...over,
  };
}

const opts = { graceMs: 7000, retentionMs: 168 * HOUR, nowMs: T + 10 * MIN };

describe("joinRecordings", () => {
  it("attaches a file that starts inside the pass window", () => {
    const out = joinRecordings([pass()], [file()], opts);
    expect(out).toHaveLength(1);
    expect(out[0].videoState).toBe("present");
    expect(out[0].files.map((f) => f.id)).toEqual(["f1"]);
    expect(out[0].pass!.id).toBe("p1");
  });

  it("attaches a file starting just inside the grace window after the pass ends", () => {
    const out = joinRecordings([pass()], [file({ startedAtMs: T + 2 * MIN + 6000 })], opts);
    expect(out[0].videoState).toBe("present");
  });

  it("does not attach a file starting beyond the grace window", () => {
    const out = joinRecordings([pass()], [file({ startedAtMs: T + 2 * MIN + 9000 })], opts);
    expect(out[0].videoState).toBe("not-recorded");
    expect(out.find((l) => l.pass === null)!.files).toHaveLength(1);
  });

  it("marks a recent pass with no file as not-recorded", () => {
    const out = joinRecordings([pass()], [], opts);
    expect(out[0].videoState).toBe("not-recorded");
    expect(out[0].files).toEqual([]);
  });

  it("marks a pass older than the retention window as expired", () => {
    const old = pass({ startedAtMs: T - 200 * HOUR, endedAtMs: T - 200 * HOUR + MIN });
    const out = joinRecordings([old], [], opts);
    expect(out[0].videoState).toBe("expired");
  });

  it("attaches every file of a pass that rolled over a segment boundary", () => {
    const long = pass({ startedAtMs: T, endedAtMs: T + 90 * MIN });
    const files = [
      file({ id: "f1", startedAtMs: T + 1000 }),
      file({ id: "f2", startedAtMs: T + 60 * MIN }),
    ];
    const out = joinRecordings([long], files, opts);
    expect(out[0].files.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("reports a file matching no pass as unattributed", () => {
    const out = joinRecordings([], [file()], opts);
    expect(out).toHaveLength(1);
    expect(out[0].pass).toBeNull();
    expect(out[0].source).toBeNull();
    expect(out[0].videoState).toBe("present");
  });

  it("gives a file to the pass it started inside when windows overlap", () => {
    const a = pass({ id: "pa", startedAtMs: T, endedAtMs: T + 2 * MIN });
    const b = pass({ id: "pb", startedAtMs: T + MIN, endedAtMs: T + 3 * MIN });
    const out = joinRecordings([a, b], [file({ startedAtMs: T + 90_000 })], opts);
    const withFile = out.filter((l) => l.files.length > 0);
    expect(withFile).toHaveLength(1);
    expect(withFile[0].pass!.id).toBe("pb");   // the LATEST pass it fits
  });

  it("sorts newest first", () => {
    const a = pass({ id: "pa", startedAtMs: T });
    const b = pass({ id: "pb", startedAtMs: T + 5 * MIN, endedAtMs: T + 6 * MIN });
    const out = joinRecordings([a, b], [], opts);
    expect(out.map((l) => l.pass!.id)).toEqual(["pb", "pa"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/recording-join.test.ts`
Expected: FAIL — cannot resolve `../src/recordings/join.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/recordings/join.ts`:

```ts
import { PassRecord } from "../capture/pass-journal.js";

export interface RecordingFile {
  /** Opaque server-issued handle. NEVER a client-supplied path. */
  id: string;
  path: string;
  name: string;
  startedAtMs: number;   // parsed from the filename (host-local)
  endedAtMs: number;     // file mtime
  sizeBytes: number;
  kept: boolean;
}

export type PassSource = "journal" | "snapshot";
export type VideoState = "present" | "expired" | "not-recorded";

export interface PassListing {
  pass: PassRecord | null;    // null for a file that matched no pass
  source: PassSource | null;
  files: RecordingFile[];
  videoState: VideoState;
}

export interface JoinOptions {
  graceMs: number;
  retentionMs: number;
  nowMs: number;
  /** Where these passes came from; null entries are always "journal". */
  source?: PassSource;
}

/**
 * Map passes to the recording files that belong to them.
 *
 * The association is a VIEW, not a rename: MediaMTX keeps owning its
 * directory and its retention policy, and the journal outlives the footage,
 * so a purged pass still appears in the listing as one the operator missed.
 *
 * A file belongs to the pass whose [startedAtMs, endedAtMs + graceMs] window
 * contains the file's start. When windows overlap (a retarget inside the
 * grace period) the LATEST qualifying pass wins -- the file was opened after
 * that pass began, so it is that pass's footage.
 */
export function joinRecordings(
  passes: PassRecord[], files: RecordingFile[], opts: JoinOptions,
): PassListing[] {
  const source: PassSource = opts.source ?? "journal";
  const byPass = new Map<string, RecordingFile[]>();
  const unattributed: RecordingFile[] = [];

  // Latest-first so the first match is the latest qualifying pass.
  const ordered = [...passes].sort((a, b) => b.startedAtMs - a.startedAtMs);

  for (const f of files) {
    const owner = ordered.find(
      (p) => f.startedAtMs >= p.startedAtMs && f.startedAtMs <= p.endedAtMs + opts.graceMs,
    );
    if (!owner) { unattributed.push(f); continue; }
    const list = byPass.get(owner.id);
    if (list) list.push(f); else byPass.set(owner.id, [f]);
  }

  const listings: PassListing[] = passes.map((p) => {
    const owned = (byPass.get(p.id) ?? []).sort((a, b) => a.startedAtMs - b.startedAtMs);
    let videoState: VideoState = "present";
    if (owned.length === 0) {
      // Distinguishing "purged" from "never recorded" needs MediaMTX's
      // retention window, which lives in mediamtx.yml and is mirrored into
      // config. Drift only ever mislabels a row, never resolves a wrong file.
      videoState = opts.nowMs - p.startedAtMs > opts.retentionMs ? "expired" : "not-recorded";
    }
    return { pass: p, source, files: owned, videoState };
  });

  for (const f of unattributed) {
    listings.push({ pass: null, source: null, files: [f], videoState: "present" });
  }

  return listings.sort((a, b) => startOf(b) - startOf(a));
}

function startOf(l: PassListing): number {
  return l.pass ? l.pass.startedAtMs : (l.files[0]?.startedAtMs ?? 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-join.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/recordings/join.ts tb3-mcp/test/recording-join.test.ts
git commit -m "feat(recordings): pure time-window join of passes to files

The association is a view rather than a rename, so MediaMTX keeps owning
its directory and recordDeleteAfter keeps bounding disk use. All three
outcomes stay visible: pass with file, pass whose video was purged, and
file with no pass."
```

---

### Task 6: Directory scan and snapshot backfill

**Files:**
- Create: `tb3-mcp/src/recordings/scan.ts`
- Test: `tb3-mcp/test/recording-scan.test.ts`

**Interfaces:**
- Consumes: `parseRecordingName`, `parseSnapshotName` (Task 4); `RecordingFile` (Task 5); `PassRecord` (Task 1).
- Produces: `scanRecordings(dirs: { recordings: string; keep: string }): RecordingFile[]`, `scanSnapshots(dir: string): SnapshotFile[]`, `passesFromSnapshots(snaps: SnapshotFile[], files: RecordingFile[], graceMs: number): PassRecord[]`, `interface SnapshotFile`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/recording-scan.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { scanRecordings, scanSnapshots, passesFromSnapshots } from "../src/recordings/scan.js";
import { RecordingFile } from "../src/recordings/join.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function tmpRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3rec-"));
  mkdirSync(join(dir, "recordings"), { recursive: true });
  mkdirSync(join(dir, "keep"), { recursive: true });
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  return dir;
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function put(path: string, bytes = 10, mtimeMs?: number): void {
  writeFileSync(path, Buffer.alloc(bytes));
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe("scanRecordings", () => {
  it("returns parsed mp4s from both directories, marking kept ones", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"), 100);
    put(join(root, "keep", "2026-08-16T17-04-21_AAL556_a082ac.mp4"), 200);
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "keep") });
    expect(got).toHaveLength(2);
    expect(got.filter((f) => f.kept)).toHaveLength(1);
    expect(got.every((f) => f.id.length > 0)).toBe(true);
  });

  it("ignores non-recording files and missing directories", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "notes.txt"));
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"));
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "nope") });
    expect(got).toHaveLength(1);
  });

  it("gives distinct ids to files with the same basename in different dirs", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"));
    put(join(root, "keep", "2026-08-16_19-16-12-734710.mp4"));
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "keep") });
    expect(new Set(got.map((f) => f.id)).size).toBe(2);
  });
});

describe("passesFromSnapshots", () => {
  it("synthesises a pass for a snapshot falling inside a file's window", () => {
    const start = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const files: RecordingFile[] = [{
      id: "f1", path: "/rec/a.mp4", name: "a.mp4",
      startedAtMs: start, endedAtMs: start + 300_000, sizeBytes: 1, kept: false,
    }];
    const snaps = [{ name: "a082ac-AAL556-x.jpg", path: "/s/a082ac-AAL556-x.jpg", icao: "a082ac", callsign: "AAL556", atMs: start + 2000 }];
    const got = passesFromSnapshots(snaps, files, 7000);
    expect(got).toHaveLength(1);
    expect(got[0].icao).toBe("a082ac");
    expect(got[0].callsign).toBe("AAL556");
    expect(got[0].snapshotFile).toBe("/s/a082ac-AAL556-x.jpg");
    expect(got[0].startedAtMs).toBe(start);
    expect(got[0].samples).toBe(0);
    expect(got[0].minRangeM).toBeNull();
  });

  it("ignores a snapshot that matches no recording", () => {
    const got = passesFromSnapshots(
      [{ name: "x.jpg", path: "/s/x.jpg", icao: "aaa", callsign: null, atMs: 1 }], [], 7000,
    );
    expect(got).toEqual([]);
  });

  it("keeps only the first snapshot per file", () => {
    const start = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const files: RecordingFile[] = [{
      id: "f1", path: "/rec/a.mp4", name: "a.mp4",
      startedAtMs: start, endedAtMs: start + 300_000, sizeBytes: 1, kept: false,
    }];
    const snaps = [
      { name: "b.jpg", path: "/s/b.jpg", icao: "bbb", callsign: null, atMs: start + 9000 },
      { name: "a.jpg", path: "/s/a.jpg", icao: "aaa", callsign: null, atMs: start + 2000 },
    ];
    const got = passesFromSnapshots(snaps, files, 7000);
    expect(got).toHaveLength(1);
    expect(got[0].icao).toBe("aaa");
  });
});

describe("scanSnapshots", () => {
  it("parses identity out of snapshot filenames", () => {
    const root = tmpRoot();
    put(join(root, "snapshots", "a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg"));
    put(join(root, "snapshots", "readme.md"));
    const got = scanSnapshots(join(root, "snapshots"));
    expect(got).toHaveLength(1);
    expect(got[0].callsign).toBe("AAL556");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/recording-scan.test.ts`
Expected: FAIL — cannot resolve `../src/recordings/scan.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/recordings/scan.ts`:

```ts
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseRecordingName, parseSnapshotName, parseKeepName } from "./names.js";
import { RecordingFile } from "./join.js";
import { PassRecord } from "../capture/pass-journal.js";

export interface SnapshotFile {
  name: string;
  path: string;
  icao: string;
  callsign: string | null;
  atMs: number;
}

/**
 * Opaque handle for a file. Derived from the ABSOLUTE path, so two files
 * sharing a basename across the recordings and keep directories never
 * collide. The client only ever sends this back, never a path.
 */
function fileId(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 16);
}

function scanDir(dir: string, kept: boolean): RecordingFile[] {
  if (!existsSync(dir)) return [];
  const out: RecordingFile[] = [];
  for (const name of readdirSync(dir)) {
    // Kept files carry keepFileName's shape, not MediaMTX's. Their mtime is
    // when the LINK was made, not when the pass happened, so parse the
    // original instant out of the name -- otherwise every kept recording
    // drifts out of its pass's window and shows up unattributed.
    const parsed = parseRecordingName(name) ?? (kept ? parseKeepName(name)?.atMs ?? null : null);
    if (parsed === null) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({
      id: fileId(path),
      path,
      name,
      startedAtMs: parsed,
      endedAtMs: Math.max(st.mtimeMs, parsed),
      sizeBytes: st.size,
      kept,
    });
  }
  return out;
}

export function scanRecordings(dirs: { recordings: string; keep: string }): RecordingFile[] {
  return [...scanDir(dirs.recordings, false), ...scanDir(dirs.keep, true)];
}

export function scanSnapshots(dir: string): SnapshotFile[] {
  if (!existsSync(dir)) return [];
  const out: SnapshotFile[] = [];
  for (const name of readdirSync(dir)) {
    const p = parseSnapshotName(name);
    if (!p) continue;
    out.push({ name, path: join(dir, name), icao: p.icao, callsign: p.callsign, atMs: p.atMs });
  }
  return out;
}

/**
 * Synthesise passes for recordings that predate the journal.
 *
 * CaptureController.beginPass() dispatches the snapshot immediately on lock,
 * so a snapshot landing inside a recording's window identifies that
 * recording. These records exist only for the lifetime of one listing request
 * and are NEVER written to the journal -- they carry identity and nothing
 * else, because nothing else was measured at the time.
 */
export function passesFromSnapshots(
  snaps: SnapshotFile[], files: RecordingFile[], graceMs: number,
): PassRecord[] {
  const byFile = new Map<string, SnapshotFile>();
  for (const s of [...snaps].sort((a, b) => a.atMs - b.atMs)) {
    const f = files.find((x) => s.atMs >= x.startedAtMs - graceMs && s.atMs <= x.endedAtMs);
    if (!f) continue;
    if (!byFile.has(f.id)) byFile.set(f.id, s);   // first snapshot wins
  }
  const out: PassRecord[] = [];
  for (const [fid, s] of byFile) {
    const f = files.find((x) => x.id === fid)!;
    out.push({
      id: `snap-${fid}`,
      icao: s.icao,
      callsign: s.callsign,
      startedAtMs: f.startedAtMs,
      endedAtMs: f.endedAtMs,
      snapshotFile: s.path,
      category: null, squawk: null, gsKt: null, maxAltitudeM: null,
      minRangeM: null, maxElevationDeg: null,
      azStartDeg: null, azEndDeg: null, azArcDeg: null,
      meanPointingErrorDeg: null, maxPointingErrorDeg: null,
      waitingMs: 0, limitHitMs: 0, samples: 0,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/recordings/scan.ts tb3-mcp/test/recording-scan.test.ts
git commit -m "feat(recordings): directory scan and snapshot backfill

File ids are hashes of the ABSOLUTE path, so a basename shared between the
recordings and keep directories cannot collide -- and the client only ever
echoes an id back, never a path. Backfill identifies pre-journal
recordings from the snapshot taken at lock."
```

---

### Task 7: Keep

**Files:**
- Create: `tb3-mcp/src/recordings/keep.ts`
- Test: `tb3-mcp/test/recording-keep.test.ts`

**Interfaces:**
- Consumes: `keepFileName` (Task 4), `RecordingFile` (Task 5).
- Produces: `keepRecording(file: RecordingFile, keepDir: string, callsign: string | null, icao: string): { path: string; method: "link" | "copy" }`, `unkeepRecording(file: RecordingFile): void`, `keepDirUsage(keepDir: string): { files: number; bytes: number }`.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/recording-keep.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { keepRecording, unkeepRecording, keepDirUsage } from "../src/recordings/keep.js";
import { RecordingFile } from "../src/recordings/join.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function root(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3keep-"));
  mkdirSync(join(dir, "recordings"), { recursive: true });
  return dir;
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function src(r: string, name = "2026-08-16_19-16-12-734710.mp4"): RecordingFile {
  const path = join(r, "recordings", name);
  writeFileSync(path, "video-bytes");
  return {
    id: "f1", path, name,
    startedAtMs: new Date(2026, 7, 16, 19, 16, 12).getTime(),
    endedAtMs: Date.now(), sizeBytes: 11, kept: false,
  };
}

describe("keepRecording", () => {
  it("hardlinks rather than copying, so the data is shared", () => {
    const r = root();
    const f = src(r);
    const out = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    expect(out.method).toBe("link");
    expect(out.path.endsWith("2026-08-16T19-16-12_AAL556_a082ac.mp4")).toBe(true);
    expect(statSync(out.path).ino).toBe(statSync(f.path).ino);
    expect(statSync(out.path).nlink).toBe(2);
  });

  it("survives deletion of the original, which is the whole point", () => {
    const r = root();
    const f = src(r);
    const out = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    rmSync(f.path);                       // MediaMTX's 7-day purge
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path, "utf8")).toBe("video-bytes");
  });

  it("is idempotent", () => {
    const r = root();
    const f = src(r);
    const a = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    const b = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    expect(b.path).toBe(a.path);
    expect(keepDirUsage(join(r, "keep")).files).toBe(1);
  });

  it("creates the keep directory when missing", () => {
    const r = root();
    const out = keepRecording(src(r), join(r, "keep", "nested"), null, "a082ac");
    expect(existsSync(out.path)).toBe(true);
  });
});

describe("unkeepRecording", () => {
  it("drops the keep link without touching the original", () => {
    const r = root();
    const f = src(r);
    const out = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    unkeepRecording({ ...f, id: "k1", path: out.path, name: "x.mp4", kept: true });
    expect(existsSync(out.path)).toBe(false);
    expect(existsSync(f.path)).toBe(true);
  });

  it("refuses to unkeep a file that is not marked kept", () => {
    const r = root();
    const f = src(r);
    expect(() => unkeepRecording(f)).toThrow(/not a kept/i);
    expect(existsSync(f.path)).toBe(true);
  });
});

describe("keepDirUsage", () => {
  it("reports zero for a missing directory", () => {
    expect(keepDirUsage(join(root(), "nope"))).toEqual({ files: 0, bytes: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/recording-keep.test.ts`
Expected: FAIL — cannot resolve `../src/recordings/keep.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/recordings/keep.ts`:

```ts
import { linkSync, copyFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { keepFileName } from "./names.js";
import { RecordingFile } from "./join.js";

/**
 * Rescue a recording from MediaMTX's retention purge.
 *
 * A HARDLINK, not a copy: every media directory is on one filesystem, so this
 * is instantaneous and costs zero additional bytes -- the file simply gains a
 * second name pointing at the same data. When MediaMTX unlinks the original
 * at recordDeleteAfter, the data survives because this link still references
 * it. Copying a 388MB file would instead take real time and double its
 * footprint for the week the original still lives.
 *
 * Falls back to a copy on EXDEV so this keeps working if the keep directory
 * is later moved to another volume.
 */
export function keepRecording(
  file: RecordingFile, keepDir: string, callsign: string | null, icao: string,
): { path: string; method: "link" | "copy" } {
  mkdirSync(keepDir, { recursive: true });
  const dest = join(keepDir, keepFileName(file.startedAtMs, callsign, icao));
  if (existsSync(dest)) return { path: dest, method: "link" };   // idempotent
  try {
    linkSync(file.path, dest);
    return { path: dest, method: "link" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw e;
    copyFileSync(file.path, dest);
    return { path: dest, method: "copy" };
  }
}

/** Drop a keep link. The original (if it still exists) is untouched. */
export function unkeepRecording(file: RecordingFile): void {
  if (!file.kept) throw new Error("refusing to delete: not a kept recording");
  if (existsSync(file.path)) unlinkSync(file.path);
}

export function keepDirUsage(keepDir: string): { files: number; bytes: number } {
  if (!existsSync(keepDir)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const name of readdirSync(keepDir)) {
    try {
      const st = statSync(join(keepDir, name));
      if (!st.isFile()) continue;
      files++; bytes += st.size;
    } catch { /* vanished mid-scan */ }
  }
  return { files, bytes };
}

/**
 * Free bytes on the volume holding `path`, or null if it cannot be read.
 *
 * The keep directory is the ONE unbounded thing here -- recordings stay
 * capped by MediaMTX's own purge -- so this has to be visible in the UI
 * rather than discovered when the disk that also runs rig control fills up.
 */
export function diskFreeBytes(path: string): number | null {
  try {
    const st = statfsSync(path);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}
```

Add `statfsSync` to the `node:fs` import at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-keep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/recordings/keep.ts tb3-mcp/test/recording-keep.test.ts
git commit -m "feat(recordings): keep by hardlink, surviving the retention purge

All media dirs are on one filesystem, so link() is instant and costs zero
bytes -- the data survives MediaMTX unlinking the original because the
keep link still references it. Falls back to copy on EXDEV. Unkeep
refuses anything not marked kept, so it can never delete an original."
```

---

### Task 8: HTTP surface

**Files:**
- Create: `tb3-mcp/src/dashboard/recordings-routes.ts`
- Modify: `tb3-mcp/src/dashboard/server.ts` (register routes), `tb3-mcp/src/config.ts` (new keys)
- Test: `tb3-mcp/test/recordings-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `registerRecordingsRoutes(app: Express, deps: RecordingsDeps): void`, `interface RecordingsDeps`, `buildListing(deps): PassListing[]` (exported for tests).

- [ ] **Step 1: Add config keys**

In `tb3-mcp/src/config.ts`, beside `captureSnapshotDir`:

```ts
    captureRecordingsDir: z.string().min(1).default("/var/lib/tb3/recordings/tb3"),
    captureKeepDir: z.string().min(1).default("/var/lib/tb3/keep"),
    passJournalFile: z.string().min(1).default("/var/lib/tb3/passes.jsonl"),
    // Mirrors mediamtx.yml's recordDeleteAfter (deployed: 168h). Used ONLY to
    // label a pass with no file as "expired" vs "not-recorded"; drift
    // mislabels a row, never resolves a wrong file.
    recordingRetentionHours: z.number().positive().default(168),
    passSampleMs: z.number().int().positive().default(500),
```

and in `loadConfig`:

```ts
  set("captureRecordingsDir", env.TB3_CAPTURE_RECORDINGS_DIR);
  set("captureKeepDir", env.TB3_CAPTURE_KEEP_DIR);
  set("passJournalFile", env.TB3_PASS_JOURNAL_FILE);
  set("recordingRetentionHours", num(env.TB3_RECORDING_RETENTION_HOURS));
  set("passSampleMs", num(env.TB3_PASS_SAMPLE_MS));
```

- [ ] **Step 2: Write the failing test**

Create `tb3-mcp/test/recordings-routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "node:http";
import { registerRecordingsRoutes, RecordingsDeps } from "../src/dashboard/recordings-routes.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "tb3routes-"));
  const rec = join(dir, "recordings"), keep = join(dir, "keep"), snap = join(dir, "snapshots");
  for (const d of [rec, keep, snap]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rec, "2026-08-16_19-16-12-734710.mp4"), "0123456789");
  const deps: RecordingsDeps = {
    recordingsDir: rec, keepDir: keep, snapshotsDir: snap,
    journalFile: join(dir, "passes.jsonl"),
    graceMs: 7000, retentionMs: 168 * 3_600_000, now: () => Date.now(),
  };
  const app = express();
  app.use(express.json());
  registerRecordingsRoutes(app, deps);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { deps, server, port };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, unknown> }));
    }).on("error", reject);
  });
}

describe("recordings routes", () => {
  it("lists the scanned recordings", async () => {
    const { server, port } = setup();
    const r = await get(port, "/api/passes");
    server.close();
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0].files[0].name).toBe("2026-08-16_19-16-12-734710.mp4");
    expect(body.keepUsage).toBeDefined();
  });

  it("streams a video by its issued id", async () => {
    const { server, port } = setup();
    const list = JSON.parse((await get(port, "/api/passes")).body);
    const id = list.listings[0].files[0].id;
    const r = await get(port, `/api/recordings/${id}/video`);
    server.close();
    expect(r.status).toBe(200);
    expect(r.body).toBe("0123456789");
  });

  it("honours a range request with 206 and Content-Range", async () => {
    const { server, port } = setup();
    const list = JSON.parse((await get(port, "/api/passes")).body);
    const id = list.listings[0].files[0].id;
    const r = await get(port, `/api/recordings/${id}/video`, { Range: "bytes=2-5" });
    server.close();
    expect(r.status).toBe(206);
    expect(r.body).toBe("2345");
    expect(String(r.headers["content-range"])).toBe("bytes 2-5/10");
  });

  it("404s every traversal attempt instead of resolving a path", async () => {
    const { server, port } = setup();
    for (const bad of [
      "..%2F..%2Fetc%2Fpasswd",
      "%2Fetc%2Fpasswd",
      "2026-08-16_19-16-12-734710.mp4",   // a real basename is NOT an id
      "0000000000000000",
    ]) {
      const r = await get(port, `/api/recordings/${bad}/video`);
      expect(r.status).toBe(404);
    }
    server.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/recordings-routes.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard/recordings-routes.js`.

- [ ] **Step 4: Implement**

Create `tb3-mcp/src/dashboard/recordings-routes.ts`:

```ts
import type { Express, Request, Response } from "express";
import { PassJournal } from "../capture/pass-journal.js";
import { scanRecordings, scanSnapshots, passesFromSnapshots } from "../recordings/scan.js";
import { joinRecordings, PassListing, RecordingFile } from "../recordings/join.js";
import { keepRecording, unkeepRecording, keepDirUsage, diskFreeBytes } from "../recordings/keep.js";

export interface RecordingsDeps {
  recordingsDir: string;
  keepDir: string;
  snapshotsDir: string;
  journalFile: string;
  graceMs: number;
  retentionMs: number;
  now(): number;
}

interface Built {
  listings: PassListing[];
  files: Map<string, RecordingFile>;
  snapshots: Map<string, string>;   // id -> absolute path
}

/**
 * Scan, join, and index by id.
 *
 * Rebuilt per request rather than cached: the directories change underneath
 * us constantly (MediaMTX writing, the purge deleting), and a few hundred
 * readdir entries is far cheaper than reasoning about cache invalidation
 * against a process that does not tell us when it writes.
 */
function build(deps: RecordingsDeps): Built {
  const files = scanRecordings({ recordings: deps.recordingsDir, keep: deps.keepDir });
  const journalPasses = new PassJournal(deps.journalFile).list();
  const opts = { graceMs: deps.graceMs, retentionMs: deps.retentionMs, nowMs: deps.now() };

  const listings = joinRecordings(journalPasses, files, opts);

  // Backfill: any file no journal pass claimed may still be identifiable from
  // the snapshot taken at lock.
  const claimed = new Set(listings.flatMap((l) => (l.pass ? l.files.map((f) => f.id) : [])));
  const orphans = files.filter((f) => !claimed.has(f.id));
  const snaps = scanSnapshots(deps.snapshotsDir);
  const synthesised = passesFromSnapshots(snaps, orphans, deps.graceMs);
  const backfilled = joinRecordings(synthesised, orphans, { ...opts, source: "snapshot" });

  const merged = [
    ...listings.filter((l) => l.pass !== null),
    ...backfilled,
  ].sort((a, b) => (b.pass?.startedAtMs ?? b.files[0]?.startedAtMs ?? 0) - (a.pass?.startedAtMs ?? a.files[0]?.startedAtMs ?? 0));

  return {
    listings: merged,
    files: new Map(files.map((f) => [f.id, f])),
    snapshots: new Map(snaps.map((s) => [s.name, s.path])),
  };
}

export function registerRecordingsRoutes(app: Express, deps: RecordingsDeps): void {
  app.get("/api/passes", (_req: Request, res: Response) => {
    try {
      const b = build(deps);
      res.json({
        listings: b.listings,
        keepUsage: keepDirUsage(deps.keepDir),
        diskFreeBytes: diskFreeBytes(deps.recordingsDir),
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // res.sendFile implements HTTP range requests (206 / Content-Range /
  // If-Range / ETag). Mandatory, not an optimisation: without it every scrub
  // of a 388MB file re-downloads from byte zero.
  app.get("/api/recordings/:id/video", (req: Request, res: Response) => {
    const f = build(deps).files.get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    res.sendFile(f.path, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such recording" });
    });
  });

  app.get("/api/snapshots/:id", (req: Request, res: Response) => {
    const p = build(deps).snapshots.get(req.params.id);
    if (!p) { res.status(404).json({ error: "no such snapshot" }); return; }
    res.sendFile(p, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such snapshot" });
    });
  });

  app.post("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const b = build(deps);
    const f = b.files.get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    const owner = b.listings.find((l) => l.files.some((x) => x.id === f.id))?.pass ?? null;
    try {
      const out = keepRecording(f, deps.keepDir, owner?.callsign ?? null, owner?.icao ?? "unknown");
      res.json({ kept: true, ...out });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const f = build(deps).files.get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    try {
      unkeepRecording(f);
      res.json({ kept: false });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
```

- [ ] **Step 5: Wire into the dashboard**

In `tb3-mcp/src/dashboard/server.ts`, after the existing `/api` routes (and therefore behind the same `authGate` registered at `app.use("/api", authGate)`), add:

```ts
  registerRecordingsRoutes(app, {
    recordingsDir: cfg.captureRecordingsDir,
    keepDir: cfg.captureKeepDir,
    snapshotsDir: cfg.captureSnapshotDir,
    journalFile: cfg.passJournalFile,
    graceMs: cfg.captureDebounceMs + 2000,
    retentionMs: cfg.recordingRetentionHours * 3_600_000,
    now: () => Date.now(),
  });

  app.get("/playback", (_req: Request, res: Response) => {
    res.sendFile(join(publicDir, "playback.html"));
  });
```

with `import { registerRecordingsRoutes } from "./recordings-routes.js";` at the top.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS. If `express` types complain about the `sendFile` callback signature, type it as `(err: Error | null) => void`.

- [ ] **Step 7: Commit**

```bash
git add tb3-mcp/src/dashboard/recordings-routes.ts tb3-mcp/src/dashboard/server.ts tb3-mcp/src/config.ts tb3-mcp/test/recordings-routes.test.ts
git commit -m "feat(dashboard): recordings listing, streaming and keep routes

Video goes through res.sendFile so HTTP range requests work -- without
206 support every scrub of a 388MB file re-downloads from zero.

Route :id values are server-issued handles looked up in the scanned index;
no client string is ever concatenated into a path, so traversal is
unrepresentable rather than filtered. Pinned by a test that feeds encoded
traversal, absolute paths and a real basename, all of which must 404."
```

---

### Task 9: Wire the pass recorder into the daemon

**Files:**
- Modify: `tb3-mcp/src/server.ts`
- Modify: `tb3-mcp/src/tools.ts` (add `list_passes`)
- Test: `tb3-mcp/test/pass-recorder-wiring.test.ts`

**Interfaces:**
- Consumes: `PassRecorder`, `PassRecorderDeps` (Task 3); `PassJournal` (Task 1).
- Produces: MCP tool `list_passes` returning `{ passes: PassRecord[] }`.

- [ ] **Step 1: Construct and wire the recorder**

In `tb3-mcp/src/server.ts`, beside the existing capture wiring:

```ts
  const journal = new PassJournal(cfg.passJournalFile);
  const passRecorder = new PassRecorder({
    sample: () => {
      const s = session.status();
      const hex = session.currentIcao();
      const ac = hex ? source.getSnapshot().aircraft.find((a) => a.hex === hex) : undefined;
      return {
        state: s.state,
        targetAzimuthDeg: s.targetAzimuthDeg,
        targetElevationDeg: s.targetElevationDeg,
        targetRangeM: s.targetRangeM,
        pointingErrorDeg: s.pointingErrorDeg,
        panLimited: s.panLimited,
        tiltLimited: s.tiltLimited,
        altitudeM: ac ? aircraftAltitudeM(ac, cfg.adsbAltSource) : null,
      };
    },
    lookup: (icao: string) => {
      const ac = source.getSnapshot().aircraft.find((a) => a.hex === icao);
      return ac ? { category: ac.category ?? null, squawk: ac.squawk ?? null, gsKt: ac.gsKt ?? null } : null;
    },
    lastSnapshot: () => captureController.status().lastSnapshot,
    journal,
    now: () => Date.now(),
    scheduler: realScheduler,
    sampleMs: cfg.passSampleMs,
    debounceMs: cfg.captureDebounceMs,
    newId: () => `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
  });
```

Then add a SECOND listener alongside the existing capture one — do not replace it:

```ts
  session.onStateChange((state, icao) => {
    const callsign = session.status().label;
    passRecorder.onTrack(state, icao, callsign);
  });
```

Use the variable names already present in `server.ts` for the session, ADS-B source and capture controller; the names above are indicative.

- [ ] **Step 2: Add the `list_passes` tool**

In `tb3-mcp/src/tools.ts`:

```ts
  server.registerTool(
    "list_passes",
    {
      description: "List recorded tracking passes with identity, framing geometry and tracking quality. Newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(2000).optional().describe("max rows (default 500)"),
      },
    },
    async ({ limit }) => {
      const all = journal.list();
      const rows = all.slice(-(limit ?? 500)).reverse();
      return text(JSON.stringify({ count: rows.length, total: all.length, passes: rows }, null, 2));
    },
  );
```

Thread `journal` into `registerTools` the same way the other stores are.

- [ ] **Step 3: Write the wiring test**

Create `tb3-mcp/test/pass-recorder-wiring.test.ts` asserting that a `PassRecorder` built with a journal writing to a temp file produces a readable record end-to-end:

```ts
import { describe, it, expect, vi } from "vitest";
import { PassRecorder } from "../src/capture/pass-recorder.js";
import { PassJournal } from "../src/capture/pass-journal.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pass recorder end-to-end against a real journal", () => {
  it("writes a readable record for a completed pass", () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "tb3wire-"));
    const journal = new PassJournal(join(dir, "passes.jsonl"));
    let now = 5_000_000;
    const ticks: (() => void)[] = [];
    const rec = new PassRecorder({
      sample: () => ({
        state: "tracking", targetAzimuthDeg: 10, targetElevationDeg: 22,
        targetRangeM: 6000, pointingErrorDeg: 1.1, panLimited: false, tiltLimited: false,
        altitudeM: 2500,
      }),
      lookup: () => ({ category: "A3", squawk: "1200", gsKt: 250 }),
      lastSnapshot: () => "/snap/x.jpg",
      journal,
      now: () => now,
      scheduler: { every: (_ms, fn) => { ticks.push(fn); return { cancel: () => {} }; } },
      sampleMs: 500, debounceMs: 5000,
      newId: () => "wire-1",
    });

    rec.onTrack("tracking", "a082ac", "AAL556");
    for (let i = 0; i < 6; i++) { now += 500; ticks.forEach((f) => f()); }
    rec.onTrack("stopped", null);
    vi.advanceTimersByTime(5000);

    const got = journal.list();
    expect(got).toHaveLength(1);
    expect(got[0].icao).toBe("a082ac");
    expect(got[0].maxElevationDeg).toBe(22);
    expect(got[0].meanPointingErrorDeg).toBeCloseTo(1.1, 6);
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 4: Run the tests and build**

Run: `npm test && npm run build`
Expected: PASS, `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src tb3-mcp/test
git commit -m "feat(capture): wire the pass recorder and add list_passes

A SECOND onStateChange listener alongside the capture one, never a
replacement -- CaptureController keeps its own bracketing untouched."
```

---

### Task 10: Playback section

**Files:**
- Create: `tb3-mcp/dashboard/public/playback.html`, `playback.js`, `playback.css`
- Modify: `tb3-mcp/dashboard/public/index.html` (nav link)

**Interfaces:**
- Consumes: `GET /api/passes`, `GET /api/recordings/:id/video`, `GET /api/snapshots/:id`, `POST|DELETE /api/recordings/:id/keep`.
- Produces: no JS exports; a standalone page.

- [ ] **Step 1: Build the page shell**

`playback.html`: a filter bar and a results container, loading `playback.css` and `playback.js` as a module. Follow `index.html`'s existing head/link conventions (no build step, no framework, plain `<script type="module">`).

```html
<h1>Recordings</h1>
<div id="filters">
  <input id="f-text" type="search" placeholder="callsign or hex">
  <select id="f-range">
    <option value="1">last 24h</option>
    <option value="7" selected>last 7 days</option>
    <option value="0">all</option>
  </select>
  <label>min max-elevation <input id="f-el" type="range" min="0" max="90" value="0"><span id="f-el-v">0°</span></label>
  <label>max mean error <input id="f-err" type="range" min="0" max="20" step="0.5" value="20"><span id="f-err-v">any</span></label>
  <label><input id="f-video" type="checkbox"> has video</label>
  <label><input id="f-kept" type="checkbox"> kept only</label>
  <select id="f-sort">
    <option value="new">newest</option>
    <option value="el">highest elevation</option>
    <option value="qual">best tracked</option>
  </select>
</div>
<div id="usage"></div>
<div id="results"></div>
```

- [ ] **Step 2: Implement filtering and rendering**

`playback.js`: fetch once on load, then filter/sort client-side (the listing is a few hundred rows at most, so re-fetching per keystroke would be waste).

```js
const state = { listings: [], keepUsage: null };

async function load() {
  const r = await fetch("/api/passes");
  if (!r.ok) { document.getElementById("results").textContent = `failed: HTTP ${r.status}`; return; }
  const body = await r.json();
  state.listings = body.listings;
  state.keepUsage = body.keepUsage;
  render();
}

function passes(l) {
  const f = readFilters();
  const p = l.pass;
  if (f.text) {
    const hay = `${p?.callsign ?? ""} ${p?.icao ?? ""}`.toLowerCase();
    if (!hay.includes(f.text)) return false;
  }
  if (f.days > 0 && startOf(l) < Date.now() - f.days * 86400000) return false;
  if (f.minEl > 0 && !(p && p.maxElevationDeg !== null && p.maxElevationDeg >= f.minEl)) return false;
  if (f.maxErr < 20 && !(p && p.meanPointingErrorDeg !== null && p.meanPointingErrorDeg <= f.maxErr)) return false;
  if (f.hasVideo && l.files.length === 0) return false;
  if (f.keptOnly && !l.files.some((x) => x.kept)) return false;
  return true;
}
```

The card renderer:

```js
function base(p) { return p ? p.split("/").pop() : null; }
function km(m) { return m === null ? "–" : `${(m / 1000).toFixed(1)} km`; }
function deg(d) { return d === null ? "–" : `${d.toFixed(0)}°`; }

// Quality bands: the 2026-08-16 calibration fix landed the rig at ~1.3°, so
// "good" is anything holding under 2°, and >5° means the target left frame.
function qualityClass(e) {
  if (e === null) return "q-unknown";
  return e <= 2 ? "q-good" : e <= 5 ? "q-fair" : "q-poor";
}

function card(l) {
  const p = l.pass;
  const f = l.files[0] ?? null;
  const el = document.createElement("div");
  el.className = `card ${l.videoState !== "present" ? "no-video" : ""}`;

  const thumb = base(p?.snapshotFile);
  const dur = p ? Math.round((p.endedAtMs - p.startedAtMs) / 1000) : null;
  const inferred = l.source === "snapshot";

  el.innerHTML = `
    <div class="thumb">${thumb ? `<img loading="lazy" src="/api/snapshots/${encodeURIComponent(thumb)}"
       onerror="this.style.display='none'">` : ""}</div>
    <div class="meta">
      <div class="title">${p?.callsign ?? p?.icao ?? "unattributed"}
        ${p?.category ? `<span class="chip">${p.category}</span>` : ""}
        ${inferred ? `<span class="chip inferred" title="identified from the snapshot; nothing else was measured">inferred</span>` : ""}
      </div>
      <div class="when">${p ? new Date(p.startedAtMs).toLocaleString() : new Date(f.startedAtMs).toLocaleString()}
        ${dur !== null ? `· ${dur}s` : ""}</div>
      ${p && !inferred ? `<div class="chips">
        <span class="chip">closest ${km(p.minRangeM)}</span>
        <span class="chip">max el ${deg(p.maxElevationDeg)}</span>
        <span class="chip">arc ${deg(p.azArcDeg)}</span>
        <span class="chip ${qualityClass(p.meanPointingErrorDeg)}">
          err ${p.meanPointingErrorDeg === null ? "–" : p.meanPointingErrorDeg.toFixed(1) + "°"}</span>
      </div>` : ""}
      <div class="actions"></div>
    </div>`;

  const actions = el.querySelector(".actions");
  if (l.videoState !== "present") {
    actions.textContent = l.videoState === "expired" ? "video expired" : "not recorded";
  } else {
    const play = document.createElement("button");
    play.textContent = "Play";
    play.onclick = () => {
      const v = document.createElement("video");
      v.controls = true; v.preload = "metadata";
      v.src = `/api/recordings/${f.id}/video`;
      el.querySelector(".thumb").replaceChildren(v);
    };
    const keep = document.createElement("button");
    keep.textContent = f.kept ? "Un-keep" : "Keep";
    keep.onclick = async () => {
      keep.disabled = true;
      await fetch(`/api/recordings/${f.id}/keep`, { method: f.kept ? "DELETE" : "POST" });
      await load();
    };
    const dl = document.createElement("a");
    dl.textContent = "Download";
    dl.download = ""; dl.href = `/api/recordings/${f.id}/video`;
    actions.append(play, keep, dl);
  }
  return el;
}
```

A listing with `videoState !== "present"` renders greyed with `video expired` or `not recorded` and no Play/Keep. A `source === "snapshot"` listing shows an `inferred` badge and omits the geometry and quality chips, because none of that was measured at the time — showing empty chips there would imply the pass was tracked badly rather than simply unmeasured.

`render()` sorts by the `#f-sort` value (`new` → `startedAtMs` desc; `el` → `maxElevationDeg` desc, nulls last; `qual` → `meanPointingErrorDeg` asc, nulls last), filters with `passes(l)`, and writes `#usage` as kept file count, kept bytes, and `diskFreeBytes` in GB.

- [ ] **Step 3: Add the nav link**

In `index.html`, add a link to `/playback` in the existing nav block area (`section.navblock`), styled like the other chips.

- [ ] **Step 4: Verify against the daemon**

Run `npm run dashboard` locally pointed at the rig, open `/playback`.
Expected: passes list newest-first, thumbnails render, filters narrow the list, a video plays AND seeks (scrub to the middle and confirm playback resumes there without a full reload), Keep flips the row to kept.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/dashboard/public
git commit -m "feat(dashboard): playback section with filters and inline player

A separate page rather than a tab in the cockpit: the live view is
real-time control of a physical rig and gains nothing from view-switching
state. Passes whose video was purged still render, greyed and labelled."
```

---

### Task 11: Deploy and verify

- [ ] **Step 1: Full verification**

```bash
cd tb3-mcp && npm test && npm run build
```
Expected: all tests pass, `tsc` clean.

- [ ] **Step 2: Create the runtime directories on the host**

```bash
ssh atomist@192.168.4.71 'mkdir -p /var/lib/tb3/keep && ls -ld /var/lib/tb3/keep'
```

- [ ] **Step 3: Push and deploy**

```bash
git push -u origin feat/recordings-index
ssh atomist@192.168.4.71 'cd ~/TB3-ESP32 && git fetch origin && git checkout feat/recordings-index && cd tb3-mcp && npm ci && npm run build'
```

The host carries load-bearing uncommitted edits to `tb3-mcp/deploy/*.service` and `config.json`. Do NOT check them out, stash them, or clean the tree. If git refuses the branch switch, stop and report rather than forcing it.

- [ ] **Step 4: Restart (operator — sudo needs a password)**

```
sudo systemctl restart tb3-mcp tb3-dashboard
```

- [ ] **Step 5: Verify on the rig**

```bash
ssh atomist@192.168.4.71 'curl -s --max-time 8 http://127.0.0.1:8788/api/passes | head -c 600'
```

Expected: the 68 existing recordings listed, most carrying a callsign from snapshot backfill with `source: "snapshot"`. Then open `/playback` in a browser, confirm a video plays and seeks, and press Keep on one — verify with:

```bash
ssh atomist@192.168.4.71 'ls -l /var/lib/tb3/keep/ && stat -c "%h %n" /var/lib/tb3/keep/*'
```

Expected: the kept file has link count 2, confirming the hardlink rather than a copy.

- [ ] **Step 6: Track one aircraft and confirm a journal record appears**

```bash
ssh atomist@192.168.4.71 'tail -2 /var/lib/tb3/passes.jsonl'
```

Expected: a record with icao, callsign, `minRangeM`, `maxElevationDeg` and `meanPointingErrorDeg` populated.
