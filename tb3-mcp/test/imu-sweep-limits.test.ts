import { describe, it, expect } from "vitest";
import { runCharacterizeImu, SWEEP_POSITIONS } from "../src/imu-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { BootWatcher } from "../src/boot-watch.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = () => {
  const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "imu-")), "cal.json"));
  s.load();
  return s;
};
const boot = () => {
  const w = new BootWatcher(join(mkdtempSync(join(tmpdir(), "imu-")), "boot.json"));
  w.load();
  return w;
};

// FIELD 2026-07-30. characterize_imu called moveToUserAngle with NO limits
// argument, so it fell back to the config ceiling and drove straight through
// the operator's TAUGHT travel limits -- the ones taught because the rig was
// grinding into its stops. 4 of the 7 sweep postures were outside them.
//
// Worse, the sweep recorded the REQUESTED posture against each gravity
// reading. A leg that clamps or stalls therefore pairs a real gravity vector
// with a posture the rig was never at, and solveImuMounting cannot tell --
// it just returns a wrong R_s. That poisoned dBase, the base-lean figure and
// every solve after it.
describe("characterize_imu sweep honesty (field bug 2026-07-30)", () => {
  it("the achieved posture actually reaches the SOLVE, not just a spy", async () => {
    // A rig that clamps tilt at -10 and pan at -107 (taught limits), with a
    // gravity reading that depends on where it truly ended up. Asserting on
    // the SOLVED result is the point: an earlier version of this test watched
    // its own callback and passed even with the fix reverted.
    const clamp = (p: number, t: number) => ({ panDeg: Math.max(-107, p), tiltDeg: Math.max(-10, t) });
    const gravityAt = (pan: number, tilt: number): [number, number, number] => {
      const t = (tilt * Math.PI) / 180, p = (pan * Math.PI) / 180;
      return [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), -Math.cos(t)];
    };
    const run = async (useAchieved: boolean) => {
      let at = { panDeg: 0, tiltDeg: 0 };
      const s = store();
      const res = await runCharacterizeImu({
        positions: SWEEP_POSITIONS,
        geoPanSign: -1,
        samplesPerPos: 1,
        moveTo: async (p, t) => { at = clamp(p, t); },
        getGravity: async () => gravityAt(at.panDeg, at.tiltDeg), // truth follows the CLAMPED rig
        ...(useAchieved ? { achievedPosture: async () => at } : {}),
        store: s,
        isSunLocked: () => false,
        boot: boot(),
      });
      return res.rmsDeg;
    };
    const withFix = await run(true);
    const withoutFix = await run(false);
    // Same rig, same gravity readings -- the ONLY difference is which posture
    // was paired with each reading. Pairing the requested posture with a
    // clamped rig's gravity is what silently produced a wrong R_s.
    expect(withFix).toBeLessThan(withoutFix);
    expect(withoutFix - withFix).toBeGreaterThan(1);
  });

  it("without achievedPosture, keeps the old trust-the-request behaviour", async () => {
    const s = store();
    await runCharacterizeImu({
      positions: SWEEP_POSITIONS.slice(0, 4),
      geoPanSign: -1,
      samplesPerPos: 1,
      moveTo: async () => {},
      getGravity: async () => [0, 0, -1],
      store: s,
      isSunLocked: () => false,
      boot: boot(),
    });
    expect(s.getImuMounting()).toBeDefined();
  });

  it("the shipped sweep spans enough geometry to be worth protecting", () => {
    const pans = SWEEP_POSITIONS.map((p) => p.panDeg);
    const tilts = SWEEP_POSITIONS.map((p) => p.tiltDeg);
    expect(Math.max(...pans) - Math.min(...pans)).toBeGreaterThan(50);
    expect(Math.max(...tilts) - Math.min(...tilts)).toBeGreaterThan(40);
  });
});
