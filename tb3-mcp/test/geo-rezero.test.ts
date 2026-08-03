import { describe, it, expect } from "vitest";
import { Mat3, Vec3, matMul, matVec, normalize, angleBetweenDeg, rotX, rotZ, deg2rad } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";
import { dBaseFromGravity } from "../src/geo/imu-orientation.js";
import {
  applyPanOffset, applyTiltOffset, solveTiltOffset, solvePanOffset,
} from "../src/geo/rezero.js";

// A deliberately non-trivial mount orientation: yaw 20deg, small lean.
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C_HEAD: Vec3 = normalize([0.02, 0.99, 0.08]);
const R_S: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const GP = -1; // geoPanSign as configured on this rig

function boresight(R_: Mat3, cHead: Vec3, pan: number, tilt: number): Vec3 {
  return matVec(matMul(R_, mountHeadRotation(GP * pan, tilt)), cHead);
}

// Gravity the IMU would report at a posture, given a true base-down vector.
function gravityAt(dBase: Vec3, pan: number, tilt: number): Vec3 {
  // Invert dBaseFromGravity: g_s = R_s^T · M^T · d_base
  const M = mountHeadRotation(GP * pan, tilt);
  const Mt: Mat3 = [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
  const Rst: Mat3 = [[R_S[0][0], R_S[1][0], R_S[2][0]], [R_S[0][1], R_S[1][1], R_S[2][1]], [R_S[0][2], R_S[1][2], R_S[2][2]]];
  return matVec(matMul(Rst, Mt), dBase);
}

const D_BASE: Vec3 = normalize([-0.008, -0.024, -0.9997]);

describe("applyPanOffset / applyTiltOffset", () => {
  it("a pan offset folded into R equals reading pan shifted by that offset", () => {
    const dPan = 37.5;
    const truePan = -12, tilt = 21;
    // Rig now REPORTS (truePan - dPan) for the same physical posture.
    const reported = truePan - dPan;
    const folded = applyPanOffset(R, dPan, GP);
    expect(angleBetweenDeg(boresight(folded, C_HEAD, reported, tilt),
                           boresight(R, C_HEAD, truePan, tilt))).toBeLessThan(1e-6);
  });

  it("a tilt offset folded into cHead equals reading tilt shifted by that offset", () => {
    const dTilt = -14.25;
    const trueTilt = 30, pan = 5;
    const reported = trueTilt - dTilt;
    const folded = applyTiltOffset(C_HEAD, dTilt);
    expect(angleBetweenDeg(boresight(R, folded, pan, reported),
                           boresight(R, C_HEAD, pan, trueTilt))).toBeLessThan(1e-6);
  });
});

describe("solveTiltOffset", () => {
  it("recovers an injected tilt-origin shift", () => {
    for (const dTilt of [-42, -7.5, 0, 3.25, 23.33, 55]) {
      const truePan = 18, trueTilt = 12;
      const g = gravityAt(D_BASE, truePan, trueTilt);
      const reportedTilt = trueTilt - dTilt;
      const out = solveTiltOffset(R_S, D_BASE, truePan, reportedTilt, g, GP);
      expect(out.deltaTiltDeg).toBeCloseTo(dTilt, 1);
      expect(out.residualDeg).toBeLessThan(0.05);
    }
  });

  // The assumption the whole design rests on: gravity sees tilt, not pan.
  // "Nearly independent" is bounded by D_BASE's own lean off the pan axis
  // (~1.45deg here: acos(-D_BASE[2]) ~= 1.45), not by zero -- a wrong pan
  // rotates the reconstructed dBase(d) curve about that axis, and since
  // D_BASE sits off-axis by the lean angle, the achievable fit shifts by
  // up to ~2x the lean (a chord-length-style bound, sin(dPan/2) scaled).
  // Verified against a fine brute-force sweep of the objective (not just
  // this solver) that the observed ~2deg shift at dPan=+-90 is the true
  // global optimum, not a search artifact -- so 0.5deg was too tight for
  // this D_BASE; 2.5deg still asserts real (order-of-magnitude) decoupling
  // rather than the tens-of-degrees a fully-coupled solve would show.
  it("is insensitive to pan-origin error", () => {
    const truePan = 18, trueTilt = 12, dTilt = 23.33;
    const g = gravityAt(D_BASE, truePan, trueTilt);
    const clean = solveTiltOffset(R_S, D_BASE, truePan, trueTilt - dTilt, g, GP);
    for (const dPan of [-90, -20, 20, 90]) {
      const dirty = solveTiltOffset(R_S, D_BASE, truePan - dPan, trueTilt - dTilt, g, GP);
      expect(Math.abs(dirty.deltaTiltDeg - clean.deltaTiltDeg)).toBeLessThan(2.5);
    }
  });

  it("reports a large residual when the tripod itself moved", () => {
    const moved: Vec3 = normalize([0.35, -0.1, -0.93]); // ~21deg of real base lean change
    const g = gravityAt(moved, 18, 12);
    const out = solveTiltOffset(R_S, D_BASE, 18, 12, g, GP);
    expect(out.residualDeg).toBeGreaterThan(3.0);
  });
});

describe("solvePanOffset", () => {
  it("recovers an injected pan-origin shift", () => {
    for (const dPan of [-150, -33, 0, 16.4, 78, 150]) {
      const truePan = -25, tilt = 19;
      const refEnu = boresight(R, C_HEAD, truePan, tilt);
      const out = solvePanOffset(R, C_HEAD, GP, refEnu, truePan - dPan, tilt);
      expect(out.deltaPanDeg).toBeCloseTo(dPan, 1);
      expect(out.residualDeg).toBeLessThan(0.05);
    }
  });

  it("round-trips: solved offsets restore pointing for an independent target", () => {
    const dPan = 16.4, dTilt = 23.33;
    const gTrue = gravityAt(D_BASE, 40, 8);
    const t = solveTiltOffset(R_S, D_BASE, 40, 8 - dTilt, gTrue, GP);
    const cHead2 = applyTiltOffset(C_HEAD, t.deltaTiltDeg);
    const refEnu = boresight(R, C_HEAD, -25, 19);
    // cHead2 already has the tilt offset folded in (per applyTiltOffset's own
    // contract, verified above: folded pairs with REPORTED tilt, not true
    // tilt). Pass the reported tilt (19 - dTilt) here, not (19 - dTilt +
    // t.deltaTiltDeg) -- adding deltaTiltDeg back double-applies the
    // correction (once via cHead2, once via the tilt argument) and desyncs
    // the pan search from refEnu by ~dTilt worth of angle.
    const p = solvePanOffset(R, cHead2, GP, refEnu, -25 - dPan, 19 - dTilt);
    // Assert the intermediate value, not just the end-to-end round trip.
    // solvePanOffset's own objective calls applyPanOffset, so a UNIFORM sign
    // flip in applyPanOffset is invisible to the round-trip check alone: the
    // search would report deltaPanDeg = -dPan (self-consistent under the same
    // broken function), and folding that same wrong value back through the
    // same broken applyPanOffset cancels the error out end-to-end. Pin the
    // sign here against the independently-known injected dPan so that class
    // of bug cannot hide.
    expect(p.deltaPanDeg).toBeCloseTo(dPan, 1);
    const R2 = applyPanOffset(R, p.deltaPanDeg, GP);
    // An INDEPENDENT posture must now point where it did before the reboot.
    const before = boresight(R, C_HEAD, 60, 33);
    const after = boresight(R2, cHead2, 60 - dPan, 33 - dTilt);
    expect(angleBetweenDeg(before, after)).toBeLessThan(0.2);
  });
});
