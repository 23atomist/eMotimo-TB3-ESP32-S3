import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { onReboot, rezeroFromEnu } from "../src/rezero-tools.js";
import { solveTiltOffset } from "../src/geo/rezero.js";
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
  // Fix round 2 (operator decision, 2026-08-03, superseding round 1's
  // "leave pan untouched" design): during the pending window the taught pan
  // edges describe the OLD origin and can be off by the full cumulative
  // Delta-pan (73deg by cycle 3 of the multi-cycle acceptance test below),
  // yet jog/teach_limit deliberately stay open during that window
  // (rezeroGuard's comment) -- enforcing those stale edges is verbatim the
  // mechanism that drove tilt into its mechanical stop on 2026-08-02. So
  // onReboot now clears pan on every exit path (see finish()), same as tilt
  // already was on ITS failure paths -- accepted cost: pan is RE-TAUGHT
  // after a reboot rather than recovered by the eventual re-zero.
  it("corrects tilt limits immediately and clears pan limits (re-taught, not recovered)", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dTilt = 23.33;
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(18, 12),
      posture: async () => ({ panDeg: 18, tiltDeg: 12 - dTilt, moving: false, staleMs: 0 }),
      bootId: 2,
    });
    expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(limits.get().tiltMin).toBeCloseTo(-20 - dTilt, 1);
    expect(limits.get().panMin).toBeUndefined();  // cleared -- unknown until re-taught
    expect(limits.get().panMax).toBeUndefined();
    expect(calib.needsRezero()).toBe(true);
  });

  it("refuses to apply when the tripod moved", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20); limits.setEdge("panMin", -90);
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]);
    const M = mountHeadRotation(GP * 18, 12);
    const t = (m: Mat3): Mat3 => [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => matVec(matMul(t(RS), t(M)), moved),
      posture: async () => ({ panDeg: 18, tiltDeg: 12, moving: false, staleMs: 0 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(limits.get().tiltMin).toBeUndefined();  // cleared, not shifted by a bad number
    expect(limits.get().panMin).toBeUndefined();   // cleared on every exit path, this one included
  });

  // Was "...leaving pan untouched" (round 1) -- round 2's clear-pan-on-every-
  // exit-path decision means pan now falls back to the ceiling here too, same
  // as tilt, so the name is back to describing both axes.
  it("falls back to the ceiling for both axes when the IMU is absent", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20); limits.setEdge("panMin", -90);
    const out = await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => undefined,             // /api/imu reports chip "none"
      posture: async () => ({ panDeg: 18, tiltDeg: 12, moving: false, staleMs: 0 }),
      bootId: 2,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/no IMU gravity/);
    expect(limits.get().tiltMin).toBeUndefined();
    // Pan is cleared on EVERY exit path now (finish()), including this one.
    expect(limits.get().panMin).toBeUndefined();
    expect(calib.needsRezero()).toBe(true);
  });

  // Closes Finding I3: onReboot used to read gravity over HTTP and posture
  // from the WebSocket tick cache, so a boot poll that detected the reboot
  // before the WS reconnected could pair a fresh gravity read with a stale
  // (pre-reboot) posture -- measured at a true 23.33deg offset, this produced
  // `applied: true`, Delta-tilt ~0, residual 0.00deg: a confident, wrong
  // success, logged as if the reboot had been handled. Refusing here, rather
  // than falling through to the residual-based tripod-moved path, is what
  // lets the operator tell "we don't trust this reading" apart from "gravity
  // doesn't fit any origin-only shift".
  it("refuses when the posture is stale rather than reporting a 0.00deg success", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setBaseline(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20);
    const out = await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25, tiltDeg: 19, moving: false, staleMs: 60_000 }),
      bootId: 2 });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/stale/i);
    expect(limits.get().tiltMin).toBe(-20);      // untouched, NOT shifted by ~0
    expect(calib.needsRezero()).toBe(true);
  });

  it("refuses while the rig is moving", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setBaseline(R, C, new Date().toISOString(), 2);
    const out = await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25, tiltDeg: 19, moving: true, staleMs: 0 }),
      bootId: 2 });
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/moving/i);
  });
});

describe("rezeroFromEnu", () => {
  it("restores pointing for an independent posture", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt, moving: false, staleMs: 0 }), bootId: 2 });
    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);
    expect(res.deltaTiltDeg).toBeCloseTo(dTilt, 1);
    expect(calib.needsRezero()).toBe(false);
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - dPan, 33 - dTilt), boresight(R, C, 60, 33))).toBeLessThan(0.3);
    // Round 2: pan was cleared by onReboot and never re-taught here, so
    // there is nothing for rezeroFromEnu to restore -- pan stays absent
    // (re-taught by the operator, not recovered by the re-zero).
    expect(limits.get().panMin).toBeUndefined();
    expect(limits.get().panMax).toBeUndefined();
  });

  // The third pass is the whole point of iterating: with a large pan error the
  // first-pass Delta-tilt is measurably wrong, and the refined one is not.
  it("the third pass removes the pan-induced tilt error", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    const dPan = 90, dTilt = 12;          // 90deg is where the coupling peaks
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25 - dPan, tiltDeg: 19 - dTilt, moving: false, staleMs: 0 }), bootId: 2 });
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      boresight(R, C, -25, 19), { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    // Refined tilt must beat the 2.03deg worst case the single-pass solve has.
    expect(Math.abs((res.deltaTiltDeg as number) - dTilt)).toBeLessThan(0.3);
  });
});

// Was "rezeroFromEnu pan-limit stash restore" (WeakMap stash + asymmetric
// restore, deleted), then round 1's "pan-limit delta shift" (both edges
// shifted uniformly by the same delta, no clear). Round 2 (operator decision,
// 2026-08-03): onReboot now clears pan on every exit path, so an edge taught
// BEFORE the reboot is simply gone, not shifted -- but the round 1 guard this
// describe block exists to pin is still live and still just as necessary:
// jog/teach_limit stay open while a re-zero is pending (rezeroGuard's
// comment), so an operator may re-teach a pan edge in that window, and that
// reading is already correct for the CURRENT origin. It must survive the
// eventual rezeroFromEnu unshifted -- enforced by LimitsStore.edgeBootId
// (set by setEdge, checked by shiftToOffset): an edge stamped with the
// CURRENT boot generation is skipped, because it is already expressed in the
// current frame. This is the same mechanism as round 1; only the "untouched
// edge" side of the story changed (gone, not shifted, since there is no
// longer anything left to shift once onReboot clears it).
describe("rezeroFromEnu pan-limit handling after the reboot clear", () => {
  it("clears pan on reboot, then leaves a re-taught edge untouched through the re-zero", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    limits.setEdge("panMin", -90); limits.setEdge("panMax", 36);
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt, moving: false, staleMs: 0 }), bootId: 2,
    });
    // Pan is cleared by onReboot -- the pre-reboot values are gone, not
    // preserved for a later shift.
    expect(limits.get().panMin).toBeUndefined();
    expect(limits.get().panMax).toBeUndefined();

    // Operator re-teaches panMin ONLY, while needsRezero is still pending --
    // this reading is taken under the NEW (post-reboot) origin, so it is
    // already correct and must survive exactly as typed. setEdge stamps it
    // with the store's CURRENT bootId (2, set by onReboot's finish() before
    // this re-teach could happen).
    limits.setEdge("panMin", -70);

    const refEnu = boresight(R, C, -25, 19);
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      refEnu, { panDeg: -25 - dPan, tiltDeg: 19 - dTilt }, gravityAt(-25, 19));
    expect(res.applied).toBe(true);
    expect(res.deltaPanDeg).toBeCloseTo(dPan, 1);

    // The re-taught edge is untouched -- NOT shifted by -dPan (which would
    // have produced ~-86.4, the round 1 regression this stamp mechanism
    // fixes, and which remains the guard this test pins).
    expect(limits.get().panMin).toBe(-70);
    // panMax was never re-taught after the clear, so there is nothing left
    // to shift for it any more (round 2's accepted cost) -- it stays absent
    // rather than reappearing at 36 - dPan the way round 1 would have
    // produced.
    expect(limits.get().panMax).toBeUndefined();
  });
});

// Fix round 1, Finding 3: the empty-stash path (pan was never taught) must
// be a clean no-op, not a silent NaN/undefined write.
describe("rezeroFromEnu with no pan limits ever taught", () => {
  it("leaves pan limits absent and does not throw", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setGravityCalibration(R, C, new Date().toISOString(), 2);
    // No panMin/panMax ever set.
    const dPan = 16.4, dTilt = 23.33;
    await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt, moving: false, staleMs: 0 }), bootId: 2,
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
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setBaseline(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    limits.setEdge("panMin", -90);  limits.setEdge("panMax", 36);

    let panTotal = 0, tiltTotal = 0;
    for (const [dPan, dTilt] of [[3, 2], [30, 25], [40, 30]] as const) {
      panTotal += dPan; tiltTotal += dTilt;
      const truePan = -25, trueTilt = 19;
      const rptPan = truePan - panTotal, rptTilt = trueTilt - tiltTotal;

      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: rptPan, tiltDeg: rptTilt, moving: false, staleMs: 0 }), bootId: 2 });

      const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
        boresight(R, C, truePan, trueTilt), { panDeg: rptPan, tiltDeg: rptTilt },
        gravityAt(truePan, trueTilt));

      expect(res.applied).toBe(true);
      // Pointing must be restored for an INDEPENDENT posture, every cycle --
      // this is THE assertion that fails if the Task 3 baseline fix
      // (solving against the baseline + assigning via setOriginOffset) is
      // reverted, regardless of anything below it; see the mutation check
      // in the round 2 report.
      const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
      expect(angleBetweenDeg(boresight(R2, C2, 60 - panTotal, 33 - tiltTotal),
                             boresight(R, C, 60, 33))).toBeLessThan(0.1);
      // Tilt limits must track the FULL cumulative offset every cycle, not
      // drift and not double-count -- both edges, strengthened from a single
      // tiltMin check, since this is the assertion that actually pins
      // shiftToOffset's delta-vs-last-applied math (independent of the pan
      // story below, which round 2 changed).
      expect(limits.get().tiltMin).toBeCloseTo(-20 - tiltTotal, 1);
      expect(limits.get().tiltMax).toBeCloseTo(34 - tiltTotal, 1);
      // Round 2: pan is cleared by onReboot on every cycle (operator
      // decision, 2026-08-03) and never re-taught in this test, so it stays
      // absent every cycle -- it no longer tracks -90 - panTotal the way it
      // did before this decision; see the dedicated re-teach test above for
      // the case where the operator DOES re-teach during the pending window.
      expect(limits.get().panMin).toBeUndefined();
      expect(limits.get().panMax).toBeUndefined();
    }
  });

  it("is idempotent — re-zeroing twice with identical inputs changes nothing", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setBaseline(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20);
    const dPan = 16.4, dTilt = 23.33, truePan = -25, trueTilt = 19;
    const args = { calib, limits, geoPanSign: GP, bootId: 2 };
    const ref = boresight(R, C, truePan, trueTilt);
    const post = { panDeg: truePan - dPan, tiltDeg: trueTilt - dTilt, moving: false, staleMs: 0 };

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
    calib.setImuMounting(RS, DB, undefined, 2);
    calib.setBaseline(R, C, new Date().toISOString(), 2);
    limits.setEdge("tiltMin", -20); limits.setEdge("tiltMax", 34);
    const truePan = -25, trueTilt = 19;

    for (const tiltTotal of [10, 35]) {   // second reboot before any re-zero
      await onReboot({ calib, limits, boot, geoPanSign: GP,
        gravity: async () => gravityAt(truePan, trueTilt),
        posture: async () => ({ panDeg: truePan, tiltDeg: trueTilt - tiltTotal, moving: false, staleMs: 0 }),
        bootId: 2 });
    }
    expect(limits.get().tiltMin).toBeCloseTo(-20 - 35, 1);
    expect(limits.get().tiltMax).toBeCloseTo(34 - 35, 1);
  });
});

describe("re-solve after a re-zero", () => {
  it("stays correct when the calibration is re-solved in an already-offset frame", async () => {
    const { calib, limits, boot } = stores();
    calib.setImuMounting(RS, DB, 1.3, 1);
    calib.setBaseline(R, C, new Date().toISOString(), 1, 0);
    const truePan = -25, trueTilt = 19;

    // Cycle 1: reboot, re-zero.
    const d1p = 12, d1t = 9;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => ({ panDeg: truePan - d1p, tiltDeg: trueTilt - d1t, moving: false, staleMs: 0 }),
      bootId: 2 });
    await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 2 },
      boresight(R, C, truePan, trueTilt),
      { panDeg: truePan - d1p, tiltDeg: trueTilt - d1t },
      gravityAt(truePan, trueTilt));

    // RE-SOLVE from fresh sightings, in the offset frame. This is the
    // one-click dashboard path: Solve is enabled whenever two sightings exist.
    //
    // A fresh solve produces the calibration correct for the CURRENT reported
    // angles -- which is exactly what the re-zero just derived, so read it back
    // rather than inventing one. Reusing the ORIGINAL R,C here would make the
    // new baseline bit-identical to the old, and the uncorrected offset would
    // then be coincidentally right: the test would pass against the bug.
    const rsR = calib.getOrientation()!;
    const rsC = calib.getCHead()!;
    const anchor = solveTiltOffset(RS, DB, truePan - d1p, trueTilt - d1t,
                                   gravityAt(truePan, trueTilt), GP).deltaTiltDeg;
    calib.setBaseline(rsR, rsC, new Date().toISOString(), 2, anchor);

    // Cycle 2: another reboot on top of the re-solved calibration.
    const d2p = 7, d2t = 5;
    const rp = truePan - d1p - d2p, rt = trueTilt - d1t - d2t;
    await onReboot({ calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(truePan, trueTilt),
      posture: async () => ({ panDeg: rp, tiltDeg: rt, moving: false, staleMs: 0 }),
      bootId: 3 });
    const res = await rezeroFromEnu({ calib, limits, geoPanSign: GP, bootId: 3 },
      boresight(R, C, truePan, trueTilt),
      { panDeg: rp, tiltDeg: rt }, gravityAt(truePan, trueTilt));

    expect(res.applied).toBe(true);            // must NOT blame the tripod
    const R2 = calib.getOrientation()!, C2 = calib.getCHead()!;
    expect(angleBetweenDeg(boresight(R2, C2, 60 - d1p - d2p, 33 - d1t - d2t),
                           boresight(R, C, 60, 33))).toBeLessThan(0.1);
  });
});
