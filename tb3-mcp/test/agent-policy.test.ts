import { describe, it, expect } from "vitest";
import {
  classifyTier, isMilitary, isLargeMilitary, isWestboundDeparture,
  type PolicyTarget,
} from "../src/agent/policy.js";

const t = (o: Partial<PolicyTarget> = {}): PolicyTarget => ({
  category: null, type: null, operator: null,
  climb_fpm: null, track_deg: null, altitude_m: null, range_km: 20,
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

describe("isWestboundDeparture", () => {
  const dep = (o: Partial<PolicyTarget> = {}) =>
    t({ climb_fpm: 1800, altitude_m: 1500, track_deg: 260, ...o });

  it("accepts a climbing aircraft on a westerly heading", () => {
    expect(isWestboundDeparture(dep())).toBe(true);
    expect(isWestboundDeparture(dep({ track_deg: 190 }))).toBe(true);
    expect(isWestboundDeparture(dep({ track_deg: 350 }))).toBe(true);
  });

  it("rejects eastbound departures outright", () => {
    for (const track_deg of [90, 45, 120, 10, 180, 351]) {
      expect(isWestboundDeparture(dep({ track_deg }))).toBe(false);
    }
  });

  it("rejects level or descending traffic however it is heading", () => {
    expect(isWestboundDeparture(dep({ climb_fpm: 0 }))).toBe(false);
    expect(isWestboundDeparture(dep({ climb_fpm: -1200 }))).toBe(false);
    expect(isWestboundDeparture(dep({ climb_fpm: 200 }))).toBe(false);  // below threshold
  });

  it("rejects aircraft already too high to be departing", () => {
    expect(isWestboundDeparture(dep({ altitude_m: 9000 }))).toBe(false);
  });

  // Missing climb rate is common (only ~33/43 aircraft report it). It must
  // fail closed rather than admit an unknown as a departure.
  it("fails closed when climb rate or heading is missing", () => {
    expect(isWestboundDeparture(dep({ climb_fpm: null }))).toBe(false);
    expect(isWestboundDeparture(dep({ track_deg: null }))).toBe(false);
  });
});

describe("classifyTier", () => {
  it("ranks large military top, and it is the only preempting tier", () => {
    expect(classifyTier(t({ type: "C17", range_km: 30 }))).toBe(1);
  });

  it("ranks other military second", () => {
    expect(classifyTier(t({ type: "F16", range_km: 30 }))).toBe(2);
  });

  it("ranks westbound departures third", () => {
    expect(classifyTier(t({ climb_fpm: 1800, altitude_m: 1200, track_deg: 265 }))).toBe(3);
  });

  it("ranks big distant traffic fourth", () => {
    expect(classifyTier(t({ category: "A5", range_km: 75 }))).toBe(4);
    expect(classifyTier(t({ category: "A4", range_km: 95 }))).toBe(4);
  });

  it("excludes an eastbound departure from the departure tier", () => {
    expect(classifyTier(t({ climb_fpm: 1800, altitude_m: 1200, track_deg: 80 }))).toBeNull();
  });

  // ...but a big eastbound one far out is still legitimate tier-4 material.
  it("still admits an eastbound heavy that qualifies as big-and-distant", () => {
    expect(classifyTier(t({
      climb_fpm: 1800, altitude_m: 1200, track_deg: 80, category: "A5", range_km: 70,
    }))).toBe(4);
  });

  it("excludes small or near traffic that fits no tier", () => {
    expect(classifyTier(t({ category: "A1", range_km: 15 }))).toBeNull();
    expect(classifyTier(t({ category: "A5", range_km: 20 }))).toBeNull();   // big but too near
    expect(classifyTier(t({ category: "A2", range_km: 80 }))).toBeNull();   // far but too small
  });

  it("military outranks a westbound departure on the same aircraft", () => {
    expect(classifyTier(t({
      type: "C17", climb_fpm: 1800, altitude_m: 1200, track_deg: 265,
    }))).toBe(1);
  });
});
