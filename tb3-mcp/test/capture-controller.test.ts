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

  it("warns again after a genuine loss and reacquire of the SAME aircraft, still disarmed", async () => {
    const { d } = deps({ isArmed: async () => false });
    const c = mk(d, 5000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
    try {
      c.onTrack("tracking", "ABC123");
      await flush();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Genuine loss: leaves "tracking" and the debounce actually expires --
      // NOT a brief flap that comes back before the timer fires.
      c.onTrack("stopped", null);
      vi.advanceTimersByTime(5001);
      await flush();

      // Reacquiring the SAME aircraft afterward, still disarmed, is a new
      // pass and must warn again -- a repeat-visitor aircraft on a
      // disarmed camera cannot go permanently silent after its first pass.
      c.onTrack("tracking", "ABC123");
      await flush();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // --- Fix round: a stale pass must not mislabel a snapshot (final review #3) ---

  // isArmed() is a real network round-trip (MediaMTX path-ready check), and
  // the tracking tick that drives onTrack() runs at ~10Hz -- many ticks, and
  // therefore many possible retargets, can land inside that latency window.
  // Identity (icao/callsign) was already correctly frozen in beginPass()'s
  // closure -- but the IMAGE is grabbed from the live RTSP stream only once
  // isArmed() resolves, by which point the rig may have already slewed to a
  // different target. Freezing identity while grabbing a picture of
  // whatever the rig is NOW pointed at is silently wrong evidence: an
  // A-CALLSIGN-X-<iso>.jpg containing aircraft B. A stale pass must be
  // dropped entirely, not completed under the old identity.
  it("drops a stale pass instead of mislabeling a snapshot when retargeted during isArmed()'s await", async () => {
    const snaps: { icao: string; callsign: string | null }[] = [];
    let resolveArmedForA: ((armed: boolean) => void) | undefined;
    let armedCalls = 0;
    const { d, calls } = deps({
      isArmed: () => {
        armedCalls++;
        // Pass A's isArmed() check hangs until resolved explicitly below,
        // simulating a slow MediaMTX round-trip. Every subsequent pass's
        // isArmed() resolves immediately.
        if (armedCalls === 1) return new Promise<boolean>((resolve) => { resolveArmedForA = resolve; });
        return Promise.resolve(true);
      },
      snapshot: async (icao, callsign) => { snaps.push({ icao, callsign }); return `/s/${icao}.jpg`; },
    });
    const c = mk(d);

    // Pass begins for hex A with callsign X. isArmed() is now pending.
    c.onTrack("tracking", "A", "CALLSIGN-X");
    await flush();
    expect(snaps).toEqual([]);   // still waiting on A's isArmed()

    // While A's isArmed() is still in flight, the session is retargeted to a
    // different aircraft (autonomous-agent retask, or an operator switching
    // targets) -- a different hex AND a different callsign.
    c.onTrack("tracking", "B", "CALLSIGN-Y");
    await flush();
    expect(snaps).toEqual([{ icao: "B", callsign: "CALLSIGN-Y" }]);

    // NOW A's isArmed() finally resolves -- long after the retarget away
    // from A. The rig is pointed at B; a snapshot taken now under A's
    // identity would be wrong. The stale pass must be dropped, producing
    // NOTHING -- not a snapshot, not a record-on call, not a skip reason.
    resolveArmedForA!(true);
    await flush();

    expect(snaps).toEqual([{ icao: "B", callsign: "CALLSIGN-Y" }]);   // unchanged -- A produced nothing
    expect(calls.record).toEqual([true]);                             // only B's record-on, not a second for A
  });
});

// --- Fix round: lastError must not outrank a subsequent success forever
// (final review #5) -- a single failed snapshot must not stick "ERROR" on
// the chip all day while capture is actually working fine again. Contrast
// with lastSkipReason, which IS already cleared on a successful arm. ---
describe("CaptureController clears a stale lastError on the next success", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a successful manual snapshot clears a lastError left by an earlier SNAPSHOT failure", async () => {
    // Same category (snapshot) on both ends -- see the
    // "scopes lastError to its own subsystem" describe block below for the
    // cross-category case (a manual snapshot must NOT clear an unrelated
    // isArmed/record failure).
    let snapshotShouldFail = true;
    const { d } = deps({
      snapshot: async (icao) => {
        if (snapshotShouldFail) throw new Error("ECONNRESET");
        return `/s/${icao}.jpg`;
      },
    });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(c.status().lastError).toContain("ECONNRESET");

    snapshotShouldFail = false;
    const p = await c.manualSnapshot("XYZ789");
    expect(p).toBe("/s/XYZ789.jpg");
    expect(c.status().lastError).toBeNull();
  });

  it("a successful auto-capture pass clears a lastError left by an earlier failure", async () => {
    let armedCalls = 0;
    const { d, calls } = deps({
      isArmed: async () => { armedCalls++; if (armedCalls === 1) throw new Error("ECONNRESET"); return true; },
    });
    const c = mk(d);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(c.status().lastError).toContain("ECONNRESET");

    // passIcao was cleared by the rejection, so this is a fresh pass (same
    // icao) that retries rather than hitting the same-icao dedup branch.
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(calls.snaps).toEqual(["ABC123"]);
    expect(c.status().lastError).toBeNull();
  });

  it("a successful setRecording() clears a lastError left by an earlier failure", async () => {
    // reportError() is the same hook a startup preflight failure uses (see
    // item 6, src/server.ts's captureFfmpegBin check) to light the SAME
    // "Capture: ERROR" chip a runtime failure would -- prove a later
    // successful setRecording() clears it, exactly like a runtime error.
    const { d } = deps();
    const c = mk(d);
    c.reportError("record", "record on", new Error("mediamtx unreachable"));
    expect(c.status().lastError).toContain("mediamtx unreachable");

    await c.setRecording(true);
    expect(c.status().lastError).toBeNull();
  });
});

// --- Fix round: a failed valve-close retries instead of leaving `recording`
// (and MediaMTX) stuck open forever (the deferred item folded into #5). ---
describe("CaptureController retries a failed valve-close", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a transient setRecord(false) failure retries after debounceMs and eventually closes", async () => {
    let closeAttempts = 0;
    const { d, calls } = deps({
      setRecord: async (on) => {
        calls.record.push(on);
        if (!on) {
          closeAttempts++;
          if (closeAttempts === 1) throw new Error("ECONNRESET");
        }
      },
    });
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    expect(c.status().recording).toBe(true);

    c.onTrack("stopped", null);
    vi.advanceTimersByTime(5001);
    await flush();
    expect(c.status().recording).toBe(true);           // the close attempt failed
    expect(c.status().lastError).toContain("ECONNRESET");

    // The retry fires after another debounceMs and succeeds.
    vi.advanceTimersByTime(5000);
    await flush();
    expect(c.status().recording).toBe(false);
    expect(c.status().lastError).toBeNull();
    expect(closeAttempts).toBe(2);
  });

  it("a superseded close-retry does not clobber a newer pass's valve", async () => {
    let closeAttempts = 0;
    const { d } = deps({
      setRecord: async (on) => {
        if (!on) {
          closeAttempts++;
          if (closeAttempts === 1) throw new Error("ECONNRESET"); // first close fails
        }
      },
    });
    const c = mk(d, 5000);
    c.onTrack("tracking", "ABC123");
    await flush();
    c.onTrack("stopped", null);
    vi.advanceTimersByTime(5001);
    await flush();
    expect(c.status().recording).toBe(true); // close failed; a retry is pending

    // A brand new pass begins (re-acquire, or a different aircraft) before
    // that retry fires.
    c.onTrack("tracking", "DEF456");
    await flush();
    expect(c.status().recording).toBe(true); // opened fresh for the new pass

    // The stale retry from the OLD pass's failed close must NOT fire at
    // all -- it would otherwise turn recording off underneath the new pass.
    vi.advanceTimersByTime(5000);
    await flush();
    expect(c.status().recording).toBe(true);
    expect(closeAttempts).toBe(1); // no second setRecord(false) call was ever made
  });
});

// --- Fix round: NEW-1, second final-review pass (2026-07-26) ---
//
// clearError() used to be unconditional, so ANY success cleared lastError --
// including a success in a DIFFERENT subsystem than the one that failed.
// beginPass dispatches snapshot() and setRecord(true) CONCURRENTLY: with a
// broken captureFfmpegBin, every snapshot fails while the record-valve PATCH
// keeps succeeding a few ms later, and the record success was wiping the
// snapshot error -- a rig writing ZERO evidence photos displayed a green
// "Capture: REC" with no error shown. clearError() is now scoped per
// category (see ErrorCategory in controller.ts); a success only clears an
// error from its OWN subsystem.
describe("CaptureController scopes lastError to its own subsystem", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a snapshot failure survives a concurrent setRecord(true) success, and only a later successful snapshot clears it", async () => {
    let snapshotShouldFail = true;
    const { d, calls } = deps({
      snapshot: async (icao) => {
        if (snapshotShouldFail) throw new Error("ENOENT: captureFfmpegBin");
        calls.snaps.push(icao);
        return `/s/${icao}.jpg`;
      },
    });
    const c = mk(d);

    c.onTrack("tracking", "ABC123");
    await flush();
    // The valve opened fine (setRecord(true) is a separate, successful call)...
    expect(c.status().recording).toBe(true);
    expect(calls.record).toEqual([true]);
    // ...but the snapshot failure must still be visible, NOT masked by that
    // concurrent success. This is the exact bug: without category scoping,
    // lastError would already be null here.
    expect(c.status().lastError).toContain("ENOENT");

    // A setRecord success alone (e.g. a later manual re-arm) must NOT clear
    // a live snapshot-category error -- it's a different subsystem.
    await c.setRecording(true);
    expect(c.status().lastError).toContain("ENOENT");

    // Only a successful snapshot clears the snapshot-category error.
    snapshotShouldFail = false;
    const p = await c.manualSnapshot("XYZ789");
    expect(p).toBe("/s/XYZ789.jpg");
    expect(c.status().lastError).toBeNull();
  });

  it("a setRecord(true) failure survives a concurrent successful snapshot, and only a later successful setRecord clears it", async () => {
    let recordShouldFail = true;
    const { d, calls } = deps({
      setRecord: async (on) => {
        if (on && recordShouldFail) throw new Error("mediamtx unreachable");
        calls.record.push(on);
      },
    });
    const c = mk(d);

    c.onTrack("tracking", "ABC123");
    await flush();
    // The snapshot succeeded (a separate, successful call)...
    expect(calls.snaps).toEqual(["ABC123"]);
    // ...but the record-on failure must still be visible.
    expect(c.status().lastError).toContain("mediamtx unreachable");
    expect(c.status().recording).toBe(false);

    // A successful manual snapshot alone must NOT clear a live
    // record-category error.
    await c.manualSnapshot("DEF456");
    expect(c.status().lastError).toContain("mediamtx unreachable");

    // Only a successful setRecord clears the record-category error.
    recordShouldFail = false;
    await c.setRecording(true);
    expect(c.status().lastError).toBeNull();
  });
});
