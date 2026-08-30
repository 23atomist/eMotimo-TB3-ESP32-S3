import { describe, it, expect } from "vitest";
import {
  isMilitary, isLargeMilitary,
  type PolicyTarget,
} from "../src/policy/predicates.js";

const t = (o: Partial<PolicyTarget> = {}): PolicyTarget => ({
  category: null, type: null, operator: null,
  climb_fpm: null, track_deg: null, altitude_m: null, range_km: 20,
  elevation_deg: null, ground_speed_kt: null, est_track_sec: null,
  ...o,
});

describe("isMilitary", () => {
  it("recognises military airframes by ICAO type code", () => {
    for (const type of ["C17", "C130", "KC135", "F16", "F35", "A10", "UH60"]) {
      expect(isMilitary(t({ type }))).toBe(true);
    }
  });

  it("recognises military by operator even when the type is unknown", () => {
    expect(isMilitary(t({ operator: "UNITED STATES AIR FORCE" }))).toBe(true);
    expect(isMilitary(t({ operator: "US NAVY" }))).toBe(true);
    expect(isMilitary(t({ operator: "ARIZONA AIR NATIONAL GUARD" }))).toBe(true);
  });

  it("is case-insensitive on both signals", () => {
    expect(isMilitary(t({ type: "c17" }))).toBe(true);
    expect(isMilitary(t({ operator: "united states marine corps" }))).toBe(true);
  });

  it("does not flag airliners or bizjets", () => {
    expect(isMilitary(t({ type: "B738", operator: "SOUTHWEST AIRLINES CO" }))).toBe(false);
    expect(isMilitary(t({ type: "A359", operator: null }))).toBe(false);
    expect(isMilitary(t({ type: "G280", operator: "SFW LLC" }))).toBe(false);
  });

  // "AIRBUS" contains no military word, but naive substring matching on short
  // tokens like "ARMY" inside a longer word would misfire -- pin the boundary.
  it("does not false-positive on operator names that merely contain a substring", () => {
    expect(isMilitary(t({ operator: "ARMYTAGE HOLDINGS LLC" }))).toBe(false);
  });

  it("is false when both signals are missing", () => {
    expect(isMilitary(t())).toBe(false);
  });
});

describe("isLargeMilitary", () => {
  it("flags heavy military transports and tankers", () => {
    for (const type of ["C17", "C130", "KC135", "C5M", "B52", "P8"]) {
      expect(isLargeMilitary(t({ type }))).toBe(true);
    }
  });

  it("does not flag fighters or helicopters", () => {
    for (const type of ["F16", "F35", "A10", "UH60", "AH64"]) {
      expect(isLargeMilitary(t({ type }))).toBe(false);
      expect(isMilitary(t({ type }))).toBe(true);   // still military, just not large
    }
  });

  // A military-by-operator aircraft with no type code cannot be sized, so it
  // must NOT be promoted to the preempting tier on a guess.
  it("does not promote an unsized military aircraft to large", () => {
    expect(isLargeMilitary(t({ operator: "UNITED STATES AIR FORCE" }))).toBe(false);
  });
});
