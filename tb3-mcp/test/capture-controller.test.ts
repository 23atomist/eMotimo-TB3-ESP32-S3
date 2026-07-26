import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";

function deps(over: Partial<CaptureDeps> = {}) {
  const calls = { record: [] as boolean[], snaps: [] as string[] };
  const d: CaptureDeps = {
    setRecord: async (on) => { calls.record.push(on); },
    snapshot: async (icao) => { calls.snaps.push(icao); return `/s/${icao}.jpg`; },
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    ...over,
  };
  return { d, calls };
}
const mk = (d: CaptureDeps, debounceMs = 5000) =>
  new CaptureController(d, { debounceMs, autoEnabled: true });

// onTrack() is deliberately fire-and-forget, so its work lands in the microtask
// queue rather than being awaitable. advanceTimersByTimeAsync(0) drains
// microtasks under fake timers; a bare vi.runAllTicks() does NOT and would
// make these assertions race.
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

describe("CaptureController", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("snapshots once and opens the recorder on entering tracking", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);
    expect(calls.record).toEqual([true]);
  });

  it("does NOT fire on acquiring -- the rig has not settled yet", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("acquiring", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("a brief flap to waiting does not re-snap or split the clip", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("waiting", "ABC123");
    vi.advanceTimersByTime(1000);
    c.onTrack("tracking", "ABC123");
    await flush();
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);   // ONE image
    expect(calls.record).toEqual([true]);      // ONE unbroken clip
  });

  it("closes the recorder once the debounce actually expires", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("waiting", "ABC123");
    vi.advanceTimersByTime(5001);
    await flush();
    expect(calls.record).toEqual([true, false]);
  });

  it("a different aircraft gets its own snapshot", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("tracking", "DEF456");
    await flush();
    expect(calls.snaps).toEqual(["ABC123", "DEF456"]);
  });

  it("re-acquiring the SAME aircraft after the valve closed is a new pass", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("stopped", null);
    vi.advanceTimersByTime(5001);
    await flush();
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123", "ABC123"]);
    expect(calls.record).toEqual([true, false, true]);
  });

  it("skips with a reason when the camera is disarmed, and never auto-arms", async () => {
    const { d, calls } = deps({ isArmed: async () => false });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
    expect(c.status().lastSkipReason).toMatch(/disarm/i);
  });

  it("does nothing at all when auto capture is off", async () => {
    const { d, calls } = deps();
    const c = mk(d);
    c.setAuto(false);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
  });

  it("surfaces a control-API failure instead of swallowing it", async () => {
    const { d } = deps({ setRecord: async () => { throw new Error("ECONNREFUSED"); } });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(c.status().lastError).toContain("ECONNREFUSED");
  });

  it("onTrack RETURNS SYNCHRONOUSLY even when capture hangs forever", () => {
    const { d } = deps({
      snapshot: () => new Promise<string>(() => { /* never resolves */ }),
      setRecord: () => new Promise<void>(() => { /* never resolves */ }),
    });
    const c = mk(d);
    const t0 = performance.now();
    c.onTrack("tracking", "ABC123");   // must not await anything
    expect(performance.now() - t0).toBeLessThan(50);
  });

  // --- Fix round: isArmed() rejection must not permanently stall a pass ---

  it("retries after a transient isArmed() rejection instead of stalling the pass", async () => {
    let call = 0;
    const { d, calls } = deps({
      isArmed: async () => {
        call++;
        if (call === 1) throw new Error("ECONNRESET");
        return true;
      },
    });
    const c = mk(d);

    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual([]);
    expect(calls.record).toEqual([]);
    expect(c.status().lastError).toContain("ECONNRESET");

    // Next tick for the SAME aircraft must retry, not be dedup-suppressed.
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);
    expect(calls.record).toEqual([true]);
  });

  // --- Fix round: manual stop suppresses auto re-engagement for the pass ---

  it("a manual stop suppresses automatic re-engagement for the rest of the pass", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.record).toEqual([true]);

    await c.setRecording(false);
    expect(calls.record).toEqual([true, false]);

    // Several more ticks for the SAME aircraft, still mid-pass -- none of
    // them should re-open the valve.
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("waiting", "ABC123");
    vi.advanceTimersByTime(1000);
    c.onTrack("tracking", "ABC123");
    await flush();

    expect(calls.record).toEqual([true, false]);
  });

  it("manual-stop suppression is scoped to the pass, not permanent", async () => {
    const { d, calls } = deps();
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    await c.setRecording(false);
    expect(calls.record).toEqual([true, false]);

    // The pass actually ends: target lost, debounce expires.
    c.onTrack("stopped", null);
    vi.advanceTimersByTime(5001);
    await flush();

    // Re-acquiring the SAME aircraft afterward is a fresh pass.
    c.onTrack("tracking", "ABC123");
    await flush();

    expect(calls.snaps).toEqual(["ABC123", "ABC123"]);
    expect(calls.record).toEqual([true, false, true]);
  });

  // --- Fix round: disarmed-camera warning throttled to once per pass ---

  it("warns once per pass when disarmed, not once per tick", async () => {
    const { d } = deps({ isArmed: async () => false });
    const c = mk(d);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    try {
      c.onTrack("tracking", "ABC123");
      await flush();
      c.onTrack("tracking", "ABC123");
      await flush();
      c.onTrack("tracking", "ABC123");
      await flush();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // A different aircraft is a different (disarmed) pass -- warns again.
      c.onTrack("tracking", "DEF456");
      await flush();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
