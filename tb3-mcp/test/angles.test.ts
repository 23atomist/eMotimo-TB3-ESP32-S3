import { describe, it, expect } from "vitest";
import {
  STEPS_PER_DEG, stepsToDeg, degToSteps, applySign,
  checkPanTilt, checkSpeed, Limits,
} from "../src/angles.js";

const limits: Limits = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90, maxSpeedDps: 30 };

describe("angle conversions", () => {
  it("STEPS_PER_DEG is 444.444", () => {
    expect(STEPS_PER_DEG).toBeCloseTo(444.444, 3);
  });
  it("stepsToDeg / degToSteps round-trip", () => {
    expect(stepsToDeg(444.444)).toBeCloseTo(1, 6);
    expect(degToSteps(90)).toBeCloseTo(40000, 0); // 90 * 444.444
    expect(stepsToDeg(degToSteps(37.5))).toBeCloseTo(37.5, 6);
  });
  it("applySign is self-inverse for -1 and identity for 1", () => {
    expect(applySign(12.5, 1)).toBe(12.5);
    expect(applySign(12.5, -1)).toBe(-12.5);
    expect(applySign(applySign(12.5, -1), -1)).toBe(12.5);
  });
});

describe("limit checks", () => {
  it("accepts in-range pan/tilt", () => {
    expect(checkPanTilt(90, 45, limits).ok).toBe(true);
  });
  it("refuses pan above max with a descriptive error", () => {
    const r = checkPanTilt(200, 0, limits);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pan");
  });
  it("refuses tilt below min", () => {
    expect(checkPanTilt(0, -100, limits).ok).toBe(false);
  });
  it("refuses non-finite input", () => {
    expect(checkPanTilt(Number.NaN, 0, limits).ok).toBe(false);
  });
});

describe("speed checks", () => {
  it("accepts undefined (use device max)", () => {
    expect(checkSpeed(undefined, 30).ok).toBe(true);
  });
  it("accepts in-range speed", () => {
    expect(checkSpeed(10, 30).ok).toBe(true);
  });
  it("refuses speed above max", () => {
    expect(checkSpeed(50, 30).ok).toBe(false);
  });
  it("refuses zero or negative speed", () => {
    expect(checkSpeed(0, 30).ok).toBe(false);
    expect(checkSpeed(-5, 30).ok).toBe(false);
  });
});
