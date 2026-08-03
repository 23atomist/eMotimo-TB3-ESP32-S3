import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { onReboot, rezeroFromEnu } from "../src/rezero-tools.js";
import { Mat3, Vec3, matMul, rotX, rotZ, deg2rad, matVec, normalize, angleBetweenDeg } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";

const GP = -1;
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C: Vec3 = normalize([0.02, 0.99, 0.08]);
const RS: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const DB: Vec3 = normalize([-0.008, -0.024, -0.9997]);

function stores() {
  const d = mkdtempSync(join(tmpdir(), "tb3-"));
  // GP (-1) is what every test in this file solves/asserts against;
  // getOrientation()/getCHead() now derive using the store's own geoPanSign,
  // so the default of 1 would silently mismatch every test here.
  const calib = new CalibrationStore(join(d, "calibration.json"), GP); calib.load();
  const limits = new LimitsStore(join(d, "limits.json")); limits.load();
  const boot = new BootWatcher(join(d, "boot.json")); boot.load();
  return { calib, limits, boot };
}

function boresight(R_: Mat3, c: Vec3, pan: number, tilt: number): Vec3 {
  return matVec(matMul(R_, mountHeadRotation(GP * pan, tilt)), c);
}
function gravityAt(pan: number, tilt: number): Vec3 {
  const M = mountHeadRotation(GP * pan, tilt);
  const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
  return matVec(matMul(t(RS), t(M)), DB);
}

describe("onReboot", () => {
  // Was "...and clears pan limits" -- that described the WeakMap stash +
  // clear-then-restore design (deleted: it left a daemon-restart hole where a
  // lost stash meant pan stayed untaught forever). Pan is now shifted by
  // delta exactly like tilt (see applyLimitDelta), so onReboot -- which does
  // not yet know Delta-pan -- must leave it untouched rather than clear it;
  // rezeroFromEnu shifts it once Delta-pan is known.
  it("corrects tilt limits immediately and leaves pan limits untouched pending the pan solve", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dTilt = 23.33;
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(18, 12),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 - dTilt }),
      bootId: 2,
    });
    expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(limits.get().tiltMin).toBeCloseTo(-20 - dTilt, 1);
    expect(limits.get().panMin).toBe(-90);  // untouched -- no clear/stash any more
    expect(limits.get().panMax).toBe(36);
    expect(calib.needsRezero()).toBe(true);
  });

  it("refuses to apply when the tripod moved", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20);
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]);
    const M = mountHeadRotation(GP * 18, 12);
    const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => matVec(matMul(t(RS), t(M)), moved),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(limits.get().tiltMin).toBeUndefined();  // cleared, not shifted by a bad number
  });

  // Was "falls back to the ceiling when the IMU is absent rather than
  // guessing" -- that name implied BOTH axes fall back, but pan specifically
  // does not (and never has, in this test): only the axis onReboot actually
  // tried and failed to solve (tilt) is cleared. Renamed to say what it
  // actually asserts.
  it("falls back to the ceiling for tilt when the IMU is absent, leaving pan untouched", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("panMin", -90);
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => undefined,             // /api/imu reports chip "none"
      posture: async () => ({ panDeg: 18, tiltDeg: 12 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/no IMU gravity/);
    expect(limits.get().tiltMin).toBeUndefined();
    // Pan is never cleared by onReboot any more (see applyLimitDelta) --
    // only the axis actually being solved (tilt) is; pan is left exactly as
    // taught either way.
    expect(limits.get().panMin).toBe(-90);
    expect(calib.needsRezero()).toBe(true);
  });
});

describe("rezeroFromEnu", () => {
  it("restores pointing for an independent posture", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt }), bootId: 2 });
    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);
    expect(res.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(calib.needsRezero()).toBe(false);
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - dPan, 33 - dTilt), boresight(R, C, 60, 33))).toBeLessThan(0.3);
    expect(limits.get().panMin).toBeCloseTo(-90 - dPan, 1);
  });

  // The third pass is the whole point of iterating: with a large pan error the
  // first-pass Delta-tilt is measurably wrong, and the refined one is not.
  it("the third pass removes the pan-induced tilt error", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    const dPan = 90, dTilt = 12;          // 90deg is where the coupling peaks
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25 - dPan, tiltDeg: 19 - dTilt }), bootId: 2 });
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      boresight(R, C, -25, 19), { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    // Refined tilt must beat the 2.03deg worst case the single-pass solve has.
    expect(Math.abs((res.deltaTiltDeg as number) - dTilt)).toBeLessThan(0.3);
  });
});

// Was "rezeroFromEnu pan-limit stash restore" -- that described the WeakMap
// stash + asymmetric per-edge live-value restore (deleted: with delta
// shifting there is nothing to clear and nothing to restore, so pan is
// shifted exactly like tilt). Fix round 1, Finding 1: a first draft of the
// delta-shift design dropped this test's -70 guard and asserted the
// regression (both edges shifted uniformly) as the new intended behaviour --
// it was not. The guard is restored below, now enforced by stamping each
// edge with the boot generation it was taught under (LimitsStore.edgeBootId,
// set by setEdge) instead of the deleted stash: an edge stamped with the
// CURRENT boot generation is already in the current frame, and
// shiftToOffset skips it. Unlike the old in-memory WeakMap, this stamp is
// persisted, so a daemon restart between teach and re-zero cannot lose it.
describe("rezeroFromEnu pan-limit delta shift", () => {
  it("leaves a re-taught edge untouched and shifts only the edge the operator did not touch", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt }), bootId: 2,
    });
    // Pan is untouched by onReboot -- no clear, no stash.
    expect(limits.get().panMin).toBe(-90);
    expect(limits.get().panMax).toBe(36);

    // Operator re-teaches panMin ONLY, while needsRezero is still pending --
    // this reading is taken under the NEW (post-reboot) origin, so it is
    // already correct and must survive exactly as typed. setEdge stamps it
    // with the store's CURRENT bootId (2, set by onReboot's finish()).
    limits.setEdge("panMin", -70);

    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);

    // The re-taught edge is untouched -- NOT shifted by -dPan (which would
    // have produced ~-86.4, the reviewer-reproduced clobber this stamp
    // mechanism fixes).
    expect(limits.get().panMin).toBe(-70);
    // The edge the operator never re-taught (stamped with no boot generation,
    // since it was taught before any reboot) is shifted normally.
    expect(limits.get().panMax).toBeCloseTo(36 - dPan, 1);
  });
});

// Fix round 1, Finding 3: the empty-stash path (pan was never taught) must
// be a clean no-op, not a silent NaN/undefined write.
describe("rezeroFromEnu with no pan limits ever taught", () => {
  it("leaves pan limits absent and does not throw", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    // No panMin/panMax ever set.
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt }), bootId: 2,
    });
    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(limits.get().panMin).toBeUndefined();
    expect(limits.get().panMax).toBeUndefined();
  });
});

describe("multi-cycle re-zero", () => {
  // THE acceptance test. Every prior re-zero test used a fresh store and one
  // cycle, which is exactly why the cumulative/incremental frame mismatch
  // survived seven task reviews.
  it("stays correct across three reboot/re-zero cycles on one store", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90);  limits.setEdge("panMax", 36);

    let panTotal = 0, tiltTotal = 0;
    for (const [dPan, dTilt] of [[3, 2], [30, 25], [40, 30]] as const) {
      panTotal += dPan; tiltTotal += dTilt;
      const truePan = -25, trueTilt = 19;
      const rptPan = truePan - panTotal, rptTilt = trueTilt - tiltTotal;

      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: rptPan, tiltDeg: rptTilt }), bootId: 2 });

      const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
        boresight(R, C, truePan, trueTilt), { panDeg: rptPan, tiltDeg: rptTilt },
        gravityAt(truePan, trueTilt));

      expect(res.applied).toBe(true);
      // Pointing must be restored for an INDEPENDENT posture, every cycle.
      const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
      expect(angleBetweenDeg(boresight(R2, C2, 60 - panTotal, 33 - tiltTotal),
                             boresight(R, C, 60, 33))).toBeLessThan(0.1);
      // And both limit edges must track the cumulative offset, not drift.
      expect(limits.get().tiltMin).toBeCloseTo(-20 - tiltTotal, 1);
      expect(limits.get().panMin).toBeCloseTo(-90 - panTotal, 1);
    }
  });

  it("is idempotent — re-zeroing twice with identical inputs changes nothing", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20);
    const dPan = 16.4, dTilt = 23.33, truePan = -25, trueTilt = 19;
    const args = { calib, limits, geoPanSign: GP, bootId: 2 };
    const ref = boresight(R, C, truePan, trueTilt);
    const post = { panDeg: truePan - dPan, tiltDeg: trueTilt - dTilt };

    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => post, bootId: 2 });
    await rezeroFromEnu(args, ref, post, gravityAt(truePan, trueTilt));
    const after1 = JSON.stringify({ c: calib.get(), l: limits.get() });

    calib.markRezeroNeeded(2);            // pretend it is pending again
    await rezeroFromEnu(args, ref, post, gravityAt(truePan, trueTilt));
    expect(JSON.stringify({ c: calib.get(), l: limits.get() })).toBe(after1);
  });

  // The row that reintroduced the mechanical-stop incident.
  it("two reboots before one re-zero reflect the TOTAL offset", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB);
    calib.setBaseline(R, C, new Date().toISOString());
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    const truePan = -25, trueTilt = 19;

    for (const tiltTotal of [10, 35]) {   // second reboot before any re-zero
      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: truePan, tiltDeg: trueTilt - tiltTotal }),
        bootId: 2 });
    }
    expect(limits.get().tiltMin).toBeCloseTo(-20 - 35, 1);
    expect(limits.get().tiltMax).toBeCloseTo(34 - 35, 1);
  });
});
