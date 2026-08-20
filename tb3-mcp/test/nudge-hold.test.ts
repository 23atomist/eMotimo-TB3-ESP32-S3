import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NudgeHold, NUDGE_STEP_DEG, NUDGE_INTERVAL_MS, NUDGE_MAX_STEP_DEG, NUDGE_RAMP_MS, NUDGE_SENSITIVITY } from "../dashboard/public/nudge-hold.js";

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

  // This used to assert a FIXED step forever ("no ramp, unlike JogHold").
  // That was a deliberate choice and it was wrong in the field (2026-07-29):
  // 0.2deg/200ms is 1deg/s, so a several-degree seed error could not be
  // trimmed out inside a pass. The property worth keeping is that a TAP is
  // still fine-grained; only a HELD press accelerates.
  it("starts at the fine step and ramps only while held, capped at the max", async () => {
    const { hold, poster } = makeHold();
    hold.start(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls[0].deltaTiltDeg).toBe(NUDGE_STEP_DEG);

    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 5);
    const later = poster.calls[poster.calls.length - 1].deltaTiltDeg;
    expect(later).toBeGreaterThan(NUDGE_STEP_DEG);
    expect(later).toBeLessThanOrEqual(NUDGE_MAX_STEP_DEG + 1e-9);
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

// FIELD 2026-07-29: a rough set_north_zero seed left planes several degrees
// off ("10 clicks to the left and 10 clicks up... impossible to catch them
// even with the drift correction"). The fixed 0.2deg/200ms step is 1deg/s --
// right for the last fraction of a degree, far too slow for the first few
// when a pass lasts seconds.
describe("NudgeHold ramp (field fix 2026-07-29)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the FIRST step fine, so a tap still trims precisely", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    hold.stop();
    expect(poster.calls[0].deltaPanDeg).toBeCloseTo(NUDGE_STEP_DEG, 9);
  });

  it("accelerates while held, so a gross error closes in about a second", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 10);
    hold.stop();
    const steps = poster.calls.map((c) => c.deltaPanDeg);
    expect(steps.length).toBeGreaterThan(5);
    expect(steps[steps.length - 1]).toBeGreaterThan(steps[0] * 2);
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(NUDGE_MAX_STEP_DEG + 1e-9);
    // The point of the change: enough total travel to cross a multi-degree
    // gap inside a pass. The old fixed step gave 0.2 * 11 = 2.2deg here.
    expect(steps.reduce((a, b) => a + b, 0)).toBeGreaterThan(4);
  });

  it("resets the ramp on release, so the next tap is fine again", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(NUDGE_INTERVAL_MS * 8);
    hold.stop();
    const grown = poster.calls[poster.calls.length - 1].deltaPanDeg;
    expect(grown).toBeGreaterThan(NUDGE_STEP_DEG);

    const before = poster.calls.length;
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    hold.stop();
    expect(poster.calls[before].deltaPanDeg).toBeCloseTo(NUDGE_STEP_DEG, 9);
  });
});

// Sensitivity levels. The field complaint (2026-08-19): "often a nudge
// overshoots the goal so a half nudge would be perfect, and it never centers,
// especially at distance" -- one fixed 0.2° step is too coarse to converge on
// a distant target, which subtends less angle per unit of miss.
describe("NudgeHold sensitivity", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("exposes fine/normal/coarse, with normal matching the historical feel", () => {
    expect(NUDGE_SENSITIVITY.normal.stepDeg).toBe(NUDGE_STEP_DEG);
    expect(NUDGE_SENSITIVITY.normal.maxStepDeg).toBe(NUDGE_MAX_STEP_DEG);
    expect(NUDGE_SENSITIVITY.fine.stepDeg).toBeLessThan(NUDGE_SENSITIVITY.normal.stepDeg);
    expect(NUDGE_SENSITIVITY.coarse.stepDeg).toBeGreaterThan(NUDGE_SENSITIVITY.normal.stepDeg);
  });

  it("the FIRST step of a press uses the selected level's step size", async () => {
    const p = fakePoster();
    const n = new NudgeHold({ post: p.post });
    n.setSensitivity("fine");
    n.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.calls[0].deltaPanDeg).toBeCloseTo(NUDGE_SENSITIVITY.fine.stepDeg, 9);
    n.stop();
  });

  it("switching level takes effect on the NEXT press, and the ramp scales with it", async () => {
    const p = fakePoster();
    const n = new NudgeHold({ post: p.post });
    n.setSensitivity("coarse");
    n.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.calls[0].deltaPanDeg).toBeCloseTo(NUDGE_SENSITIVITY.coarse.stepDeg, 9);
    // Held long past the ramp: the step must top out at coarse's own ceiling,
    // not at the shared default -- otherwise "coarse" would be slower than
    // normal once a press is held.
    await vi.advanceTimersByTimeAsync(NUDGE_RAMP_MS + NUDGE_INTERVAL_MS * 2);
    const last = p.calls[p.calls.length - 1].deltaPanDeg;
    expect(last).toBeCloseTo(NUDGE_SENSITIVITY.coarse.maxStepDeg, 6);
    n.stop();
  });

  it("ignores an unknown level rather than zeroing the step", () => {
    const n = new NudgeHold({ post: async () => true });
    n.setSensitivity("nonsense");
    expect(n.stepDeg).toBe(NUDGE_STEP_DEG);
    expect(n.sensitivity).toBe("normal");
  });
});
