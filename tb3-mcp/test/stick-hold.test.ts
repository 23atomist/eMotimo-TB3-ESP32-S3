import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StickHold, TRIM_SENSITIVITY, holdIntervalMs } from "../dashboard/public/stick-hold.js";

// Same fake-timers + fake-poster pattern the old jog-hold.test.ts /
// nudge-hold.test.ts used: pure logic, no DOM, deterministic cadence.

let nowMs: number;
const now = () => nowMs;

function makeHold(overrides: Record<string, unknown> = {}) {
  const jogPosts: Array<{ panDps: number; tiltDps: number; durationMs: number }> = [];
  const trimPosts: Array<{ dPan: number; dTilt: number }> = [];
  let gated = false;
  const hold = new StickHold({
    postJog: vi.fn(async (panDps: number, tiltDps: number, durationMs: number) => {
      jogPosts.push({ panDps, tiltDps, durationMs });
      return !gated;
    }),
    postTrim: vi.fn(async (dPan: number, dTilt: number) => {
      trimPosts.push({ dPan, dTilt });
      return !gated;
    }),
    jogVectorTtlMs: 500,
    maxJogDps: 19,
    isGated: () => gated,
    now,
    ...overrides,
  });
  return { hold, jogPosts, trimPosts, setGated: (v: boolean) => { gated = v; } };
}

beforeEach(() => { nowMs = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("holdIntervalMs", () => {
  it("stays comfortably inside the dead-man TTL", () => {
    expect(holdIntervalMs(500)).toBeLessThan(500);
    expect(holdIntervalMs(500)).toBeGreaterThan(0);
  });
});

describe("StickHold jog mode", () => {
  it("posts a proportional rate immediately and on the keep-alive cadence", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", -1, 0);   // full push LEFT

    // First post is immediate.
    await vi.runOnlyPendingTimersAsync();
    // Screen-left (-x) is POSITIVE pan per the rig's convention (left = +).
    expect(jogPosts[0].panDps).toBe(19);
    expect(jogPosts[0].tiltDps).toBeCloseTo(0, 9);
    expect(jogPosts[0].durationMs).toBe(holdIntervalMs(500));

    nowMs += holdIntervalMs(500);
    await vi.advanceTimersByTimeAsync(holdIntervalMs(500));
    expect(jogPosts.length).toBeGreaterThanOrEqual(2);

    hold.release();
  });

  it("half deflection is half rate -- proportionality IS the throttle", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", -0.5, 0);
    await vi.runOnlyPendingTimersAsync();
    expect(jogPosts[0].panDps).toBeCloseTo(9.5, 9);
    hold.release();
  });

  it("release posts an explicit zero vector so the rig halts now, not at TTL expiry", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", 1, -1);
    await vi.runOnlyPendingTimersAsync();
    jogPosts.length = 0;
    hold.release();
    expect(jogPosts).toEqual([{ panDps: 0, tiltDps: 0, durationMs: 0 }]);
    expect(hold.active).toBe(false);
  });

  it("stops posting once released -- no keep-alive survives the finger", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", 0, -1);
    await vi.runOnlyPendingTimersAsync();
    hold.release();
    jogPosts.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(jogPosts.length).toBe(0);
  });

  it("clamps out-of-range fractions to ±1 rather than commanding beyond max", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", 5, -5);
    await vi.runOnlyPendingTimersAsync();
    expect(Math.abs(jogPosts[0].panDps)).toBeLessThanOrEqual(19);
    expect(Math.abs(jogPosts[0].tiltDps)).toBeLessThanOrEqual(19);
    hold.release();
  });

  it("ignores non-finite input instead of poisoning the loop with NaN", () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("jog", Number.NaN, 0);
    expect(hold.active).toBe(false);
    expect(jogPosts.length).toBe(0);
  });
});

describe("StickHold trim mode", () => {
  it("repeats proportional aim-offset deltas at the trim cadence", async () => {
    const { hold, trimPosts } = makeHold();
    hold.setVector("trim", 0, -1);   // full push UP
    await vi.runOnlyPendingTimersAsync();

    // Full deflection, normal sensitivity: 1 deg/s -> 0.2 deg per 200ms tick,
    // UP is -y so tilt delta is positive (+).
    expect(trimPosts[0].dTilt).toBeCloseTo(0.2, 9);
    expect(trimPosts[0].dPan).toBeCloseTo(0, 9);

    nowMs += 200;
    await vi.advanceTimersByTimeAsync(200);
    expect(trimPosts.length).toBeGreaterThanOrEqual(2);
    hold.release();
  });

  it("sensitivity scales the trim rate; half push halves it again", async () => {
    const { hold, trimPosts } = makeHold();
    hold.setSensitivity("coarse");
    hold.setVector("trim", 0.5, 0);
    await vi.runOnlyPendingTimersAsync();
    // coarse = 4 deg/s at full deflection; a half push scales the RATE to
    // 2 deg/s -> 0.4 deg/s of offset per... no: 2 deg/s * 0.2s = 0.4 total,
    // applied along the pushed axis with its sign: -0.5 * 2 * 0.2 = -0.2.
    expect(trimPosts[0].dPan).toBeCloseTo(-0.2, 9);
    hold.release();
  });

  it("setSensitivity ignores unknown levels and returns the live one", () => {
    const { hold } = makeHold();
    expect(hold.setSensitivity("turbo")).toBe("normal");
    expect(hold.setSensitivity("fine")).toBe("fine");
  });

  it("exposes the documented sensitivity table", () => {
    expect(TRIM_SENSITIVITY.fine.degPerSec).toBeLessThan(TRIM_SENSITIVITY.normal.degPerSec);
    expect(TRIM_SENSITIVITY.normal.degPerSec).toBeLessThan(TRIM_SENSITIVITY.coarse.degPerSec);
  });

  it("a trim release sends NO stop POST -- each nudge is a completed bounded shift", async () => {
    const { hold, jogPosts } = makeHold();
    hold.setVector("trim", 0, -1);
    await vi.runOnlyPendingTimersAsync();
    hold.release();
    expect(jogPosts.length).toBe(0);
    expect(hold.active).toBe(false);
  });
});

describe("StickHold gating and failure handling", () => {
  it("refuses to start while gated (E-STOP/sun-lock)", async () => {
    const { hold, jogPosts, setGated } = makeHold();
    setGated(true);
    hold.setVector("jog", 1, 0);
    expect(hold.active).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(jogPosts.length).toBe(0);
  });

  it("halts mid-push when the gate closes -- no further posts after an E-STOP lands", async () => {
    const { hold, jogPosts, setGated } = makeHold();
    hold.setVector("jog", 1, 0);
    await vi.runOnlyPendingTimersAsync();
    setGated(true);
    const before = jogPosts.length;
    nowMs += holdIntervalMs(500);
    await vi.advanceTimersByTimeAsync(holdIntervalMs(500));
    expect(jogPosts.length).toBe(before); // gated tick posted nothing
    expect(hold.active).toBe(false);
  });

  it("halts mid-push on a failed POST and reports it via onFailure", async () => {
    const onFailure = vi.fn();
    const failingPost = vi.fn(async () => false);
    const hold = new StickHold({
      postJog: failingPost as unknown as (p: number, t: number, d: number) => Promise<boolean>,
      postTrim: vi.fn(async () => true),
      jogVectorTtlMs: 500,
      maxJogDps: 19,
      isGated: () => false,
      now,
      onFailure,
    });
    hold.setVector("jog", 1, 0);
    await vi.runOnlyPendingTimersAsync();
    expect(failingPost).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalled();
    expect(hold.active).toBe(false);
  });

  it("switching mode mid-push restarts cleanly under the new mode (no double loops)", async () => {
    const { hold, jogPosts, trimPosts } = makeHold();
    hold.setVector("jog", 1, 0);
    await vi.runOnlyPendingTimersAsync();
    hold.setVector("trim", 1, 0);   // tracking started under the held stick
    const trimsAtSwitch = trimPosts.length;   // >= 1: the immediate switch tick
    const before = jogPosts.length;
    nowMs += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(jogPosts.length).toBe(before); // jog loop did not survive the flip
    expect(trimPosts.length).toBeGreaterThan(trimsAtSwitch);
    hold.release();
  });
});
