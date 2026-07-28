import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NudgeHold, NUDGE_STEP_DEG, NUDGE_INTERVAL_MS } from "../dashboard/public/nudge-hold.js";

// A fake poster that records every call and resolves `true` (success) by
// default -- tests flip `okReturn`/`shouldThrow` to script a failure. Mirrors
// jog-hold.test.ts's fakePoster, adapted to NudgeHold's two-argument post.
function fakePoster() {
  const calls: Array<{ deltaPanDeg: number; deltaTiltDeg: number }> = [];
  let okReturn = true;
  let shouldThrow = false;
  const post = vi.fn(async (deltaPanDeg: number, deltaTiltDeg: number) => {
    calls.push({ deltaPanDeg, deltaTiltDeg });
    if (shouldThrow) throw new Error("network connection was lost");
    return okReturn;
  });
  return {
    post,
    calls,
    setOk: (v: boolean) => { okReturn = v; },
    setThrows: (v: boolean) => { shouldThrow = v; },
  };
}

function makeHold(overrides: Partial<{
  stepDeg: number; intervalMs: number; isGated: () => boolean;
}> = {}) {
  const poster = fakePoster();
  const onFailure = vi.fn();
  const hold = new NudgeHold({
    post: poster.post,
    ...(overrides.stepDeg !== undefined ? { stepDeg: overrides.stepDeg } : {}),
    ...(overrides.intervalMs !== undefined ? { intervalMs: overrides.intervalMs } : {}),
    isGated: overrides.isGated ?? (() => false),
    onFailure,
  });
  return { hold, poster, onFailure };
}

describe("NudgeHold", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("posts immediately on start, then again at the configured interval while held", async () => {
    const { hold, poster } = makeHold();
    hold.start(0, 1); // "up": panMul=0, tiltMul=1
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS);
    expect(poster.calls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS);
    expect(poster.calls.length).toBe(3);
  });

  it("posts a FIXED step every time — no ramp, unlike JogHold", async () => {
    const { hold, poster } = makeHold();
    hold.start(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    const first = poster.calls[0].deltaTiltDeg;
    expect(first).toBe(NUDGE_STEP_DEG);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5); // held much longer
    const later = poster.calls[poster.calls.length - 1].deltaTiltDeg;
    expect(later).toBe(NUDGE_STEP_DEG); // identical magnitude, no ramp-up
  });

  it("panMul/tiltMul scale and sign the step correctly for all four directions", async () => {
    for (const [panMul, tiltMul] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const { hold, poster } = makeHold();
      hold.start(panMul, tiltMul);
      await vi.advanceTimersByTimeAsync(0);
      expect(poster.calls[0].deltaPanDeg).toBeCloseTo(panMul * NUDGE_STEP_DEG, 9);
      expect(poster.calls[0].deltaTiltDeg).toBeCloseTo(tiltMul * NUDGE_STEP_DEG, 9);
    }
  });

  it("threads a configured stepDeg/intervalMs through", async () => {
    const { hold, poster } = makeHold({ stepDeg: 0.5, intervalMs: 100 });
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls[0].deltaPanDeg).toBe(0.5);

    await vi.advanceTimersByTimeAsync(100);
    expect(poster.calls.length).toBe(2);
  });

  it("stop() halts the loop WITHOUT posting a further correction — a nudge has no standing rate to cancel", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    const countAtStop = poster.calls.length;

    hold.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(poster.calls.length).toBe(countAtStop); // no extra "zero" post, unlike JogHold
    expect(hold.active).toBe(false);
  });

  it("stops posting after release (no further interval ticks)", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    hold.stop();
    const countAtStop = poster.calls.length;

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5);
    expect(poster.calls.length).toBe(countAtStop);
  });

  it("a failed post halts the loop rather than continuing", async () => {
    const { hold, poster, onFailure } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0); // first post ok

    poster.setOk(false);
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS); // this post fails
    const countAfterFailure = poster.calls.length;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5); // loop must not still be running
    expect(poster.calls.length).toBe(countAfterFailure);
  });

  it("a post that throws (e.g. a dropped connection) halts the loop the same way", async () => {
    const { hold, poster, onFailure } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);

    poster.setThrows(true);
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    const countAfterThrow = poster.calls.length;
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5);
    expect(poster.calls.length).toBe(countAfterThrow);
  });

  it("refuses to start while gated (E-STOP / sun-lock)", async () => {
    const { hold, poster } = makeHold({ isGated: () => true });
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(0);
    expect(hold.active).toBe(false);
  });

  it("a gate that closes mid-hold halts the loop on the next tick, with no further posts", async () => {
    let gated = false;
    const { hold, poster, onFailure } = makeHold({ isGated: () => gated });

    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(1); // moving before the gate closes

    gated = true; // simulates an E-STOP landing mid-hold
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS);
    const countAtGate = poster.calls.length;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5);
    expect(poster.calls.length).toBe(countAtGate); // never posted again through the gate
  });

  it("starting a second hold while one is active is a no-op", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    const countAfterFirstStart = poster.calls.length;

    hold.start(0, 1); // ignored: a hold is already active
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(countAfterFirstStart);
  });
});
