import { describe, it, expect } from "vitest";
import { isTrackedRow } from "../dashboard/public/cockpit.js";

const row = (hex: string) => ({ hex });

// The operator could not tell at a glance WHICH plane in the list the rig was
// actually following (2026-08-19). The list is sorted for pickability, not
// proximity, so the tracked one is not at a predictable position.
describe("isTrackedRow", () => {
  it("matches the aircraft the session reports it is following", () => {
    expect(isTrackedRow(row("a1b2c3"), { tracking: { state: "tracking", hex: "a1b2c3" } })).toBe(true);
  });

  it("does not match a different aircraft", () => {
    expect(isTrackedRow(row("d4e5f6"), { tracking: { state: "tracking", hex: "a1b2c3" } })).toBe(false);
  });

  it("matches case-insensitively — ICAO hex casing is not guaranteed across sources", () => {
    expect(isTrackedRow(row("A1B2C3"), { tracking: { state: "tracking", hex: "a1b2c3" } })).toBe(true);
  });

  // "acquiring" is still a live pass aimed at that aircraft, so it must read
  // as tracked; the operator wants to see which one the rig is committed to,
  // not only which one it has already converged on.
  it("counts an acquiring pass as tracked", () => {
    expect(isTrackedRow(row("a1b2c3"), { tracking: { state: "acquiring", hex: "a1b2c3" } })).toBe(true);
  });

  it("is false once tracking has stopped, even if the hex lingers", () => {
    expect(isTrackedRow(row("a1b2c3"), { tracking: { state: "stopped", hex: "a1b2c3" } })).toBe(false);
  });

  it("is false with no tracking state, a null hex, or a missing row hex", () => {
    expect(isTrackedRow(row("a1b2c3"), {})).toBe(false);
    expect(isTrackedRow(row("a1b2c3"), { tracking: { state: "tracking", hex: null } })).toBe(false);
    expect(isTrackedRow({}, { tracking: { state: "tracking", hex: "a1b2c3" } })).toBe(false);
  });
});
