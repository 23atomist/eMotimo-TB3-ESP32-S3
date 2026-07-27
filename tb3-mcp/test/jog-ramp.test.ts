import { describe, it, expect } from "vitest";
import { jogRampDps, JOG_MIN_DPS_DEFAULT, JOG_RAMP_SECONDS_DEFAULT } from "../dashboard/public/jog-ramp.js";

const MAX_DPS = 19; // config.ts's maxJogDps default
const RAMP_MS = JOG_RAMP_SECONDS_DEFAULT * 1000; // config.ts's jogRampSeconds default, in ms

describe("jogRampDps", () => {
  it("starts at jogMinDps the instant the button is pressed (heldMs=0)", () => {
    expect(jogRampDps(0, MAX_DPS)).toBe(JOG_MIN_DPS_DEFAULT);
  });

  it("is monotonically non-decreasing as held-duration grows", () => {
    const samples = [0, 50, 100, 250, 500, 1000, 1500, 2000, RAMP_MS / 2, RAMP_MS, RAMP_MS + 500, 5000];
    let prev = -Infinity;
    for (const ms of samples) {
      const dps = jogRampDps(ms, MAX_DPS);
      expect(dps).toBeGreaterThanOrEqual(prev);
      prev = dps;
    }
  });

  it("clamps at maxDps and never exceeds it, even well past the ramp window", () => {
    expect(jogRampDps(RAMP_MS, MAX_DPS)).toBeCloseTo(MAX_DPS, 6);
    expect(jogRampDps(RAMP_MS + 1000, MAX_DPS)).toBeCloseTo(MAX_DPS, 6);
    expect(jogRampDps(60_000, MAX_DPS)).toBeLessThanOrEqual(MAX_DPS);
  });

  it("reaches (effectively) max by jogRampSeconds", () => {
    const dps = jogRampDps(RAMP_MS, MAX_DPS);
    expect(dps).toBeGreaterThanOrEqual(MAX_DPS - 1e-6);
    expect(dps).toBeLessThanOrEqual(MAX_DPS);
  });

  it("never exceeds maxDps for absurd held-duration inputs (huge, negative, NaN, Infinity)", () => {
    for (const ms of [-1, -1000, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const dps = jogRampDps(ms, MAX_DPS);
      expect(dps).toBeLessThanOrEqual(MAX_DPS);
      expect(dps).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(dps)).toBe(false);
    }
  });

  it("respects a different maxDps ceiling (not hardcoded to 19)", () => {
    expect(jogRampDps(0, 8)).toBeLessThanOrEqual(8);
    expect(jogRampDps(RAMP_MS, 8)).toBeCloseTo(8, 6);
    expect(jogRampDps(RAMP_MS * 2, 8)).toBeLessThanOrEqual(8);
  });

  // --- Follow-up operator feedback ("still ramps too fast") -- jogRampSeconds
  // and jogMinDps (config.ts) make the floor and duration tunable without a
  // frontend code edit. These assert the curve genuinely responds to both,
  // and stays sane (never NaN, never negative, never above maxDps) at their
  // degenerate extremes. ---

  it("a longer jogRampSeconds genuinely takes longer to reach max (two values)", () => {
    const heldMs = 2000;
    const fast = jogRampDps(heldMs, MAX_DPS, JOG_MIN_DPS_DEFAULT, 2); // 2s ramp: done by 2000ms
    const slow = jogRampDps(heldMs, MAX_DPS, JOG_MIN_DPS_DEFAULT, 8); // 8s ramp: nowhere near done
    expect(fast).toBeCloseTo(MAX_DPS, 6);
    expect(slow).toBeLessThan(fast);
  });

  it("a different jogMinDps changes the press-instant (heldMs=0) rate", () => {
    expect(jogRampDps(0, MAX_DPS, 1)).toBe(1);
    expect(jogRampDps(0, MAX_DPS, 5)).toBe(5);
  });

  it("clamps jogMinDps > maxJogDps down to maxJogDps, at every held-duration", () => {
    for (const ms of [0, 500, 2000, RAMP_MS, RAMP_MS + 5000]) {
      expect(jogRampDps(ms, MAX_DPS, MAX_DPS + 50)).toBe(MAX_DPS);
    }
  });

  it("negative jogMinDps floors at 0 rather than going negative", () => {
    expect(jogRampDps(0, MAX_DPS, -5)).toBe(0);
  });

  it("a zero, negative, or non-finite jogRampSeconds falls back to a sane default instead of NaN", () => {
    for (const rampSeconds of [0, -4, NaN, -Infinity]) {
      const dps = jogRampDps(2000, MAX_DPS, JOG_MIN_DPS_DEFAULT, rampSeconds);
      expect(Number.isNaN(dps)).toBe(false);
      expect(dps).toBeGreaterThanOrEqual(JOG_MIN_DPS_DEFAULT);
      expect(dps).toBeLessThanOrEqual(MAX_DPS);
    }
  });

  it("a very small (but valid) jogRampSeconds ramps to max almost immediately", () => {
    const dps = jogRampDps(50, MAX_DPS, JOG_MIN_DPS_DEFAULT, 0.01);
    expect(dps).toBeCloseTo(MAX_DPS, 6);
  });

  it("zero/negative/absurd hold durations stay within [jogMinDps, maxDps] and never produce NaN", () => {
    for (const ms of [0, -1, -9999, NaN]) {
      const dps = jogRampDps(ms, MAX_DPS, 3, 4);
      expect(Number.isNaN(dps)).toBe(false);
      expect(dps).toBeGreaterThanOrEqual(0);
      expect(dps).toBeLessThanOrEqual(MAX_DPS);
    }
  });
});
