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
