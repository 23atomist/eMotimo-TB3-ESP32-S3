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

  // Re-review, UI-9 fix round 2: the PROVISIONAL version of this test
  // (previously here) was ALSO not a real discriminator, for a subtler
  // reason than the original "/calibrat/i matches the badge token alone"
  // problem it was meant to fix. `calibrationBadge({provisional:true}).text`
  // is "PROVISIONAL" (doesn't itself contain "calibrat") -- but
  // `hasCalibrationProgress()` treats `cal.provisional` as progress too,
  // so that SAME state always also fires the "Recalibrating costs a fresh
  // IMU sweep..." cost sentence, and "Recalibrating" contains "calibrat".
  // Proven live: substituting the word "state" for "calibration" in the
  // naming sentence (deleting the naming clause's only distinctive word)
  // left that test passing, because /calibrat/i was actually matching
  // "Recalibrating" the whole time, never the naming sentence at all.
  //
  // Fixed by testing a PHRASE the naming sentence's own template text is
  // the only possible source of, instead of a single word both the badge
  // token and the cost sentence can also independently produce. Checked
  // against a state where BOTH cost sentences are deliberately active
  // (calibrated progress AND a taught edge) -- the worst case for this
  // exact confound -- so this assertion cannot be satisfied by accident.
  it("names the calibration loss via the naming sentence's own wording -- not satisfiable by either cost sentence, which happen to contain \"calibrat\"/\"re-teach\" too", () => {
    const m = destructiveConfirm("set_home", {
      calibration: { calibrated: true },
      taughtLimits: { panMinDeg: null, panMaxDeg: 12, tiltMinDeg: null, tiltMaxDeg: null },
    }).message;
    // Sanity: both cost sentences really are present in this fixture, so a
    // pass below is not merely "neither cost sentence fired."
    expect(m).toMatch(/recalibrating costs/i);
    expect(m).toMatch(/re-teaching/i);
    // The actual, isolating assertion: this exact contiguous phrase exists
    // ONLY in the naming sentence's own template text.
    expect(m).toMatch(/clears the current .*calibration AND every taught travel-limit edge/i);
  });
});
