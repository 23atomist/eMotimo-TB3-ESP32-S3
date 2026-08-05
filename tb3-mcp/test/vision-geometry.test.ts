import { describe, it, expect } from "vitest";
import { focalPxFromFov, fovDegFromFocalPx, pixelToAngularError } from "../src/vision/geometry.js";

const F = focalPxFromFov(1920, 60); // 1920px wide, 60deg horizontal FOV

describe("focal length <-> fov", () => {
  it("round-trips", () => {
    expect(fovDegFromFocalPx(1920, F)).toBeCloseTo(60, 6);
  });
  it("a longer lens (more zoom) gives a bigger focal length", () => {
    expect(focalPxFromFov(1920, 20)).toBeGreaterThan(focalPxFromFov(1920, 60));
  });

  // ---- ABSOLUTE SCALE PINS -------------------------------------------------
  // Everything else in this file is expressed in terms of F itself, which
  // makes it invariant under a consistent rescaling of the focal length. A
  // wrong-by-2x definition (e.g. width/tan instead of (width/2)/tan) paired
  // with a compensating fovDegFromFocalPx passes the round-trip AND every
  // ratio test, while halving every angle pixelToAngularError returns.
  // These three assertions are the only thing standing between that bug and
  // the rest of the system. Do not express them in terms of F.
  it("pins focalPxFromFov against a hand-computed value", () => {
    // (1920/2) / tan(30deg) = 960 / 0.5773503 = 1662.77
    expect(focalPxFromFov(1920, 60)).toBeCloseTo(1662.77, 1);
  });

  it("pins the vertical FOV absolutely", () => {
    // 2*atan(540/1662.769) = 2*17.99170 = 35.9834deg for a 1080px height.
    // NOTE the LITERAL focal length rather than F. Deriving F through
    // focalPxFromFov makes this assertion structurally blind to the
    // scale mutation: a doubled focalPx cancels exactly against a
    // fovDegFromFocalPx that dropped its own /2, so both the correct and
    // the wrong pair return 35.9834. Against the literal, the wrong pair
    // returns 66.009 and the test bites.
    expect(fovDegFromFocalPx(1080, 1662.768775)).toBeCloseTo(35.9834, 3);
  });
});

describe("pixelToAngularError", () => {
  it("dead centre is zero error", () => {
    expect(pixelToAngularError({ dxPx: 0, dyPx: 0 }, F, -13)).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  // ---- THE ABSOLUTE SCALE PIN FOR THE CONVERSION ITSELF --------------------
  // Half the frame width MUST be half the horizontal FOV. This is pure
  // geometry with no reference to F, so a rescaled focal length cannot
  // satisfy it: the correct 1662.77 gives atan(960/1662.77) = 30.0deg, while
  // a doubled 3325.5 gives 16.1deg.
  it("half the frame width IS half the horizontal FOV", () => {
    const r = pixelToAngularError({ dxPx: 960, dyPx: 0 }, F, 0);
    expect(r.panDeg).toBeCloseTo(30, 4);
  });

  it("half the frame height IS half the vertical FOV", () => {
    const r = pixelToAngularError({ dxPx: 0, dyPx: 540 }, F, 0);
    expect(r.tiltDeg).toBeCloseTo(17.99170, 3);
  });

  it("uses atan, not a linear scale — a quarter-frame offset is MORE than a quarter of the FOV", () => {
    // theta = atan(x/f) is CONCAVE, so an interior point sits ABOVE the chord
    // drawn from the frame edge. The edge (960px) is exactly 30deg; a naive
    // linear share at 480px would be 15deg, but the true value is 16.102deg.
    // A linear implementation would return exactly 15 and fail this.
    const r = pixelToAngularError({ dxPx: 480, dyPx: 0 }, F, 0);
    expect(r.panDeg).toBeGreaterThan(15);
    expect(r.panDeg).toBeCloseTo(16.102, 2);
  });

  it("applies cos(tilt) to the pan axis — the SAME pixel error needs a bigger pan correction when tilted up", () => {
    const low  = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 0);
    const high = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 60);
    // cos(60) = 0.5, so the pan correction must be ~2x the flat case.
    expect(high.panDeg / low.panDeg).toBeCloseTo(2, 3);
  });

  it("does NOT apply cos(tilt) to the tilt axis", () => {
    const low  = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 0);
    const high = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 60);
    expect(high.tiltDeg).toBeCloseTo(low.tiltDeg, 9);
  });

  it("axes are independent and signed — asymmetric, opposite signs", () => {
    // Distinct magnitudes and opposite signs: an axis swap or a shared sign
    // error cannot survive this.
    const r = pixelToAngularError({ dxPx: 400, dyPx: -150 }, F, 0);
    expect(r.panDeg).toBeCloseTo((Math.atan(400 / F) * 180) / Math.PI, 6);
    expect(r.tiltDeg).toBeCloseTo((Math.atan(-150 / F) * 180) / Math.PI, 6);
    expect(r.panDeg).toBeGreaterThan(0);
    expect(r.tiltDeg).toBeLessThan(0);
  });

  it("refuses a pan correction at the degenerate pole instead of exploding", () => {
    const r = pixelToAngularError({ dxPx: 400, dyPx: 100 }, F, 89.999);
    expect(r.panDeg).toBe(0);
    expect(Number.isFinite(r.tiltDeg)).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Fix A2/A5 (C1/C2). `signs` defaults to NOMINAL_AXIS_SIGNS so every test
// above (which never passes it) is completely unaffected -- these are the
// ONLY tests in this file that exercise a non-nominal sign.
// -------------------------------------------------------------------------
describe("pixelToAngularError — measured axis signs (A2/A5, C1/C2)", () => {
  it("a non-nominal pan sign flips the correction's sign, magnitude unchanged", () => {
    const nominal = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 0, { pan: 1, tilt: 1 });
    const flipped = pixelToAngularError({ dxPx: 300, dyPx: 0 }, F, 0, { pan: -1, tilt: 1 });
    expect(flipped.panDeg).toBeCloseTo(-nominal.panDeg, 9);
  });

  it("a non-nominal tilt sign flips the correction's sign, magnitude unchanged", () => {
    const nominal = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 0, { pan: 1, tilt: 1 });
    const flipped = pixelToAngularError({ dxPx: 0, dyPx: 300 }, F, 0, { pan: 1, tilt: -1 });
    expect(flipped.tiltDeg).toBeCloseTo(-nominal.tiltDeg, 9);
  });

  // -----------------------------------------------------------------------
  // Test group 5 (brief): app.py's tilt convention. app.py computes
  // dyPx = boxCentreY - cy in PIL/YOLO image coordinates, where Y GROWS
  // DOWNWARD -- so dyPx > 0 means the aircraft sits LOW in the frame
  // (below the boresight). Reasoned through explicitly, matching the
  // mounting the scratch e2e harness documents as "the physically real
  // convention" (a target ABOVE the boresight has dyPx < 0):
  //
  //   dyPx = tiltSign * focalPx * tan(delta), delta = target's elevation
  //   offset from the boresight (positive delta = above, using this
  //   codebase's tiltDeg-as-elevation convention: increasing tiltDeg = up,
  //   see config.ts's tiltMin/tiltMax and geometry.ts's own "pole"/zenith
  //   language for -90..90 range use).
  //
  //   "target above (delta>0) => dyPx<0" therefore requires tiltSign = -1
  //   for this mounting. With that MEASURED tiltSign, a detection at
  //   dyPx > 0 (aircraft LOW) must produce tiltErr < 0 -- a correction that
  //   DECREASES tiltDeg, i.e. aims the rig DOWN, which is exactly what is
  //   needed to reach a target that is below.
  // -----------------------------------------------------------------------
  it("app.py convention: dyPx > 0 (aircraft low in frame) aims the rig DOWN for the mounting whose measured tiltSign is -1", () => {
    const signs = { pan: 1 as const, tilt: -1 as const };
    const r = pixelToAngularError({ dxPx: 0, dyPx: 250 }, F, 0, signs);
    expect(r.tiltDeg).toBeLessThan(0);
  });

  it("...and dyPx < 0 (aircraft high in frame) aims the rig UP, for the SAME measured tiltSign", () => {
    const signs = { pan: 1 as const, tilt: -1 as const };
    const r = pixelToAngularError({ dxPx: 0, dyPx: -250 }, F, 0, signs);
    expect(r.tiltDeg).toBeGreaterThan(0);
  });

  it("a hardcoded (opposite) tiltSign would aim the rig the WRONG way — this is exactly C1/C2's mechanism", () => {
    // If the code ignored the measurement and hardcoded tiltSign=+1 (the
    // OTHER possible value), the SAME dyPx>0 (aircraft low) would produce a
    // POSITIVE tiltDeg -- aiming UP, away from the target.
    const measured = pixelToAngularError({ dxPx: 0, dyPx: 250 }, F, 0, { pan: 1, tilt: -1 });
    const hardcoded = pixelToAngularError({ dxPx: 0, dyPx: 250 }, F, 0, { pan: 1, tilt: 1 });
    expect(Math.sign(measured.tiltDeg)).not.toBe(Math.sign(hardcoded.tiltDeg));
  });
});
