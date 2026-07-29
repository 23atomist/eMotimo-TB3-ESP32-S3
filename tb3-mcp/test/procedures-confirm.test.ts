import { describe, it, expect } from "vitest";
import { destructiveConfirm } from "../dashboard/public/procedures.js";

describe("destructiveConfirm", () => {
  it("requires confirmation for set_home", () => {
    expect(destructiveConfirm("set_home", {}).needed).toBe(true);
  });

  it("names BOTH things set_home clears -- calibration and taught limits", () => {
    const m = destructiveConfirm("set_home", {
      calibration: { calibrated: true }, limits: { taught: { pan_max: 120 } },
    }).message;
    expect(m).toMatch(/calibrat/i);
    expect(m).toMatch(/limit/i);
  });

  it("requires confirmation for clearing taught limits", () => {
    expect(destructiveConfirm("clear_taught_limits", {}).needed).toBe(true);
  });

  it("does not gate a harmless action", () => {
    expect(destructiveConfirm("teach_limit", {}).needed).toBe(false);
  });
});
