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
