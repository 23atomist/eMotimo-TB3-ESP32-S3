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

  // Review fix, UI-9 fix round, finding M-1: the message used to
  // unconditionally claim "recalibrating costs a fresh IMU sweep plus two
  // aircraft sightings" even when NOTHING had ever been calibrated --
  // self-contradictory ("clears the current UNCALIBRATED calibration ...
  // recalibrating costs..." names a cost that doesn't exist). It must still
  // always NAME what's cleared, just never claim a false price for it.
  it("does not claim a recalibration cost that doesn't exist when nothing has been calibrated yet", () => {
    const m = destructiveConfirm("set_home", {
      calibration: { calibrated: false, provisional: false, rig: null, imuMounting: null, sightings: [] },
    }).message;
    expect(m).toMatch(/calibrat/i); // still names it
    expect(m).not.toMatch(/IMU sweep/i); // but claims no cost that doesn't exist
  });

  it("does claim the recalibration cost once real calibration progress exists", () => {
    const m = destructiveConfirm("set_home", { calibration: { calibrated: true } }).message;
    expect(m).toMatch(/IMU sweep/i);
    expect(m).toMatch(/aircraft sighting/i);
  });

  it("claims the taught-edge redo cost only when at least one edge has actually been taught (review fix I-2 feeding M-1)", () => {
    const withTaught = destructiveConfirm("set_home", {
      taughtLimits: { panMinDeg: null, panMaxDeg: 12, tiltMinDeg: null, tiltMaxDeg: null },
    }).message;
    expect(withTaught).toMatch(/re-teaching/i);

    const withoutTaught = destructiveConfirm("set_home", {
      taughtLimits: { panMinDeg: null, panMaxDeg: null, tiltMinDeg: null, tiltMaxDeg: null },
    }).message;
    expect(withoutTaught).not.toMatch(/re-teaching/i);

    const noTaughtLimitsAtAll = destructiveConfirm("set_home", {}).message;
    expect(noTaughtLimitsAtAll).not.toMatch(/re-teaching/i);
  });

  // Tightens the original "names BOTH things" test above, which is
  // satisfiable by the literal token "UNCALIBRATED"/"CALIBRATED" alone --
  // /calibrat/i would pass even if the message stopped naming the
  // calibration loss in its own words. PROVISIONAL doesn't itself contain
  // "calibrat", so a match here can ONLY come from the message actually
  // saying "calibration" -- a real discriminator (review fix, UI-9 fix
  // round, finding M-1).
  it("names the calibration loss in its own words, not merely via the badge token -- checked against PROVISIONAL, which doesn't itself contain \"calibrat\"", () => {
    const m = destructiveConfirm("set_home", { calibration: { provisional: true } }).message;
    expect(m).toMatch(/calibrat/i);
  });
});
