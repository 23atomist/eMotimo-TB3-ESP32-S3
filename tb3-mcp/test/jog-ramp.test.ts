import { describe, it, expect } from "vitest";
import { jogRampDps, JOG_RAMP_START_DPS, JOG_RAMP_MS } from "../dashboard/public/jog-ramp.js";

const MAX_DPS = 19; // config.ts's maxJogDps default

describe("jogRampDps", () => {
  it("starts at the slow rate the instant the button is pressed (heldMs=0)", () => {
    expect(jogRampDps(0, MAX_DPS)).toBe(JOG_RAMP_START_DPS);
  });

  it("is monotonically non-decreasing as held-duration grows", () => {
    const samples = [0, 50, 100, 250, 400, 600, 800, 1000, 1200, 1500, 2000, 5000];
    let prev = -Infinity;
    for (const ms of samples) {
      const dps = jogRampDps(ms, MAX_DPS);
      expect(dps).toBeGreaterThanOrEqual(prev);
      prev = dps;
    }
  });

  it("clamps at maxDps and never exceeds it, even well past the ramp window", () => {
    expect(jogRampDps(JOG_RAMP_MS, MAX_DPS)).toBeCloseTo(MAX_DPS, 6);
    expect(jogRampDps(JOG_RAMP_MS + 1000, MAX_DPS)).toBeCloseTo(MAX_DPS, 6);
    expect(jogRampDps(60_000, MAX_DPS)).toBeLessThanOrEqual(MAX_DPS);
  });

  it("reaches (effectively) max by ~1.5s", () => {
    const dps = jogRampDps(JOG_RAMP_MS, MAX_DPS);
    expect(dps).toBeGreaterThanOrEqual(MAX_DPS - 1e-6);
    expect(dps).toBeLessThanOrEqual(MAX_DPS);
  });

  it("never exceeds maxDps for absurd inputs (huge, negative, NaN, Infinity)", () => {
    for (const ms of [-1, -1000, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const dps = jogRampDps(ms, MAX_DPS);
      expect(dps).toBeLessThanOrEqual(MAX_DPS);
      expect(Number.isNaN(dps)).toBe(false);
    }
  });

  it("respects a different maxDps ceiling (not hardcoded to 19)", () => {
    expect(jogRampDps(0, 8)).toBeLessThanOrEqual(8);
    expect(jogRampDps(JOG_RAMP_MS, 8)).toBeCloseTo(8, 6);
    expect(jogRampDps(JOG_RAMP_MS * 2, 8)).toBeLessThanOrEqual(8);
  });

  it("is roughly on-curve at the midpoints called out in the spec (~2 -> ~6 -> ~12 -> 19)", () => {
    expect(jogRampDps(0, MAX_DPS)).toBeCloseTo(2, 0);
    expect(jogRampDps(500, MAX_DPS)).toBeGreaterThan(3);
    expect(jogRampDps(500, MAX_DPS)).toBeLessThan(9);
    expect(jogRampDps(1000, MAX_DPS)).toBeGreaterThan(9);
    expect(jogRampDps(1000, MAX_DPS)).toBeLessThan(16);
  });
});
