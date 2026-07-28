import { describe, it, expect } from "vitest";
import { aimMode, calibrationBadge } from "../dashboard/public/ui-mode.js";

describe("aimMode", () => {
  it("is jog when idle", () => {
    expect(aimMode({ tracking: { state: "stopped" } })).toBe("jog");
  });
  it("is trim while tracking -- the buttons change meaning", () => {
    expect(aimMode({ tracking: { state: "tracking" } })).toBe("trim");
  });
  it("is trim while acquiring too (the tracker owns the rig)", () => {
    expect(aimMode({ tracking: { state: "acquiring" } })).toBe("trim");
  });
  it("is locked under E-STOP, whatever the tracking state", () => {
    expect(aimMode({ tracking: { state: "tracking" }, estopLatched: true })).toBe("locked");
    expect(aimMode({ tracking: { state: "stopped" }, estopLatched: true })).toBe("locked");
  });
  it("is locked under sun lock", () => {
    expect(aimMode({ tracking: { state: "stopped" }, sunLocked: true })).toBe("locked");
  });
  it("tolerates a missing payload", () => {
    expect(() => aimMode({})).not.toThrow();
    expect(aimMode({})).toBe("jog");
  });
});

describe("calibrationBadge", () => {
  it("distinguishes calibrated, provisional and uncalibrated", () => {
    expect(calibrationBadge({ calibration: { calibrated: true } }).text).toMatch(/CALIBRATED/);
    expect(calibrationBadge({ calibration: { provisional: true } }).text).toMatch(/PROVISIONAL/);
    expect(calibrationBadge({ calibration: {} }).text).toMatch(/UNCALIBRATED/);
  });
  it("gives provisional its own class -- it must never look like a solve", () => {
    const p = calibrationBadge({ calibration: { provisional: true } });
    const c = calibrationBadge({ calibration: { calibrated: true } });
    expect(p.cls).not.toBe(c.cls);
  });
  it("calibrated wins if both flags are somehow set", () => {
    expect(calibrationBadge({ calibration: { calibrated: true, provisional: true } }).text).toMatch(/CALIBRATED/);
  });
});
