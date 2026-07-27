import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JogHold, holdIntervalMs } from "../dashboard/public/jog-hold.js";

const TTL_MS = 500; // config.ts's jogVectorTtlMs default
const MAX_DPS = 19; // config.ts's maxJogDps default

// A fake poster that records every call and resolves `true` (success) by
// default -- tests flip `okReturn`/`shouldThrow` to script a failure.
function fakePoster() {
  const calls: Array<{ panDps: number; tiltDps: number; durationMs: number }> = [];
  let okReturn = true;
  let shouldThrow = false;
  const post = vi.fn(async (panDps: number, tiltDps: number, durationMs: number) => {
    calls.push({ panDps, tiltDps, durationMs });
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

function makeHold(overrides: Partial<{ jogVectorTtlMs: number; maxJogDps: number; isGated: () => boolean }> = {}) {
  const poster = fakePoster();
  const onFailure = vi.fn();
  const hold = new JogHold({
    post: poster.post,
    jogVectorTtlMs: overrides.jogVectorTtlMs ?? TTL_MS,
    maxJogDps: overrides.maxJogDps ?? MAX_DPS,
    isGated: overrides.isGated ?? (() => false),
    onFailure,
  });
  return { hold, poster, onFailure };
}

describe("holdIntervalMs", () => {
  it("derives ~3 posts/sec (comfortably inside the TTL) for the default 500ms TTL", () => {
    const interval = holdIntervalMs(500);
    expect(interval).toBeLessThan(500);
    expect(interval).toBeGreaterThan(200);
  });

  it("stays inside the TTL across a range of configured TTLs", () => {
    for (const ttl of [100, 300, 500, 900, 2000]) {
      expect(holdIntervalMs(ttl)).toBeLessThan(ttl);
      expect(holdIntervalMs(ttl)).toBeGreaterThan(0);
    }
  });

  it("changes when jogVectorTtlMs changes", () => {
    const i1 = holdIntervalMs(500);
    const i2 = holdIntervalMs(900);
    expect(i2).not.toBe(i1);
    expect(i2).toBeGreaterThan(i1); // a larger TTL affords a larger (still-inside) interval
  });
});

describe("JogHold", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("posts immediately on start, then again at the derived interval while held", async () => {
    const { hold, poster } = makeHold();
    const interval = holdIntervalMs(TTL_MS);

    hold.start(0, 1); // jog-up: panMul=0, tiltMul=1
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(interval);
    expect(poster.calls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(interval);
    expect(poster.calls.length).toBe(3);
  });

  it("never posts a pulse longer than the configured TTL", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(holdIntervalMs(TTL_MS) * 3);
    for (const call of poster.calls) {
      expect(call.durationMs).toBeLessThan(TTL_MS);
    }
  });

  it("applies the ramp: dps grows with held-duration, direction stays fixed", async () => {
    const { hold, poster } = makeHold();
    hold.start(0, 1); // tilt only
    await vi.advanceTimersByTimeAsync(0);
    const first = poster.calls[0];
    expect(first.panDps).toBe(0);
    expect(first.tiltDps).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(1500);
    const later = poster.calls[poster.calls.length - 1];
    expect(later.tiltDps).toBeGreaterThan(first.tiltDps);
    expect(later.tiltDps).toBeLessThanOrEqual(MAX_DPS);
  });

  it("posts a zero/stop vector on release", async () => {
    const { hold, poster } = makeHold();
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    poster.calls.length = 0;

    hold.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(poster.calls.length).toBe(1);
    expect(poster.calls[0]).toMatchObject({ panDps: 0, tiltDps: 0 });
  });

  it("stops posting after release (no further interval ticks)", async () => {
    const { hold, poster } = makeHold();
    const interval = holdIntervalMs(TTL_MS);
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);

    hold.stop();
    const countAtStop = poster.calls.length;

    await vi.advanceTimersByTimeAsync(interval * 5);
    expect(poster.calls.length).toBe(countAtStop);
  });

  it("release resets the ramp: a fresh start() begins slow again", async () => {
    const { hold, poster } = makeHold();
    hold.start(0, 1);
    await vi.advanceTimersByTimeAsync(1500); // ramp to (near) max
    hold.stop();
    poster.calls.length = 0;

    hold.start(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls[0].tiltDps).toBeLessThan(MAX_DPS / 2);
  });

  it("a failed post halts the loop rather than continuing", async () => {
    const { hold, poster, onFailure } = makeHold();
    const interval = holdIntervalMs(TTL_MS);
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0); // first post ok

    poster.setOk(false);
    await vi.advanceTimersByTimeAsync(interval); // this post fails
    const countAfterFailure = poster.calls.length;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    await vi.advanceTimersByTimeAsync(interval * 5); // loop must not still be running
    expect(poster.calls.length).toBe(countAfterFailure);
  });

  it("a post that throws (e.g. a dropped connection) halts the loop the same way", async () => {
    const { hold, poster, onFailure } = makeHold();
    const interval = holdIntervalMs(TTL_MS);
    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);

    poster.setThrows(true);
    await vi.advanceTimersByTimeAsync(interval);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    const countAfterThrow = poster.calls.length;
    await vi.advanceTimersByTimeAsync(interval * 5);
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
    const interval = holdIntervalMs(TTL_MS);

    hold.start(1, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(poster.calls.length).toBe(1); // moving before the gate closes

    gated = true; // simulates an E-STOP landing mid-hold
    await vi.advanceTimersByTimeAsync(interval);
    const countAtGate = poster.calls.length;
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(hold.active).toBe(false);

    await vi.advanceTimersByTimeAsync(interval * 5);
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
