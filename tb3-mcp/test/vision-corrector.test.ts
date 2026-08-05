import { describe, it, expect } from "vitest";
import { VisionCorrector, CorrectorDeps } from "../src/vision/corrector.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { focalPxFromFov, NOMINAL_AXIS_SIGNS } from "../src/vision/geometry.js";
import { solveStepResponse } from "../src/vision/scale-calibration.js";

const F = focalPxFromFov(1920, 60);

function harness(over: Partial<CorrectorDeps> = {}) {
  const postures = new PostureHistory();
  postures.record(1000, 10, 0);
  postures.record(9000, 10, 0);          // flat: posture 10/0 across the span
  const applied: Array<[number, number]> = [];
  const logged: Array<[string, Record<string, unknown>]> = [];
  const predictArgs: number[] = [];
  const deps: CorrectorDeps = {
    frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
    detector: { detect: async () => ({ detections: [{ dxPx: 200, dyPx: -100, conf: 0.9 }],
      widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
    postures,
    // Records its argument: the epoch predictPixel is evaluated at is half
    // the invariant, and a harness that ignores the parameter cannot pin it.
    predictPixel: (t: number) => { predictArgs.push(t); return { dxPx: 200, dyPx: -100 }; },
    applyOffset: (p, t) => { applied.push([p, t]); },
    focalPx: () => F,
    axisSigns: () => NOMINAL_AXIS_SIGNS,
    // Fix 3: every existing test in this file (none of which are about the
    // tilt-uncalibrated fallback) predates that distinction -- default to
    // "calibrated" so they keep exercising the tilt term as before. The new
    // describe block below overrides this explicitly.
    tiltCalibrated: () => true,
    frameSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
    gain: () => 0.3,
    readOnly: () => false,
    gateRadiusPx: () => 80,
    minConf: () => 0.25,
    // The shared default frame is fixed at arrivedMs=5300 -- matching `now`
    // to it makes every EXISTING test in this file (none of which are about
    // staleness/dedup) see age=0 and pass the freshness gate for free. The
    // new "Fix B" describe block below overrides both explicitly.
    now: () => 5300,
    frameMaxAgeMs: () => 3000,
    log: (o, d) => { logged.push([o, d]); },
    ...over,
  };
  return { deps, applied, logged, predictArgs, c: new VisionCorrector(deps) };
}

describe("VisionCorrector", () => {
  it("applies gain x angular error", async () => {
    const { c, applied } = harness();
    expect(await c.tick()).toBe("applied");
    const expectPan = 0.3 * (Math.atan(200 / F) * 180) / Math.PI;   // tilt 0 -> cos=1
    expect(applied[0][0]).toBeCloseTo(expectPan, 6);
    expect(applied[0][1]).toBeCloseTo(0.3 * (Math.atan(-100 / F) * 180) / Math.PI, 6);
  });

  it("uses the posture at EXPOSURE, not the current posture", async () => {
    // Posture swings hard AFTER the frame was exposed. Using the newest
    // sample would change the cos(tilt) term and thus the pan correction.
    const postures = new PostureHistory();
    postures.record(4000, 10, 0);
    postures.record(5000, 10, 0);        // exposure sits here: tilt 0
    postures.record(6000, 10, 60);       // "now": tilt 60, cos = 0.5
    const { c, applied } = harness({ postures });
    expect(await c.tick()).toBe("applied");
    const atExposure = 0.3 * (Math.atan(200 / F) * 180) / Math.PI;         // /cos(0) = 1
    expect(applied[0][0]).toBeCloseTo(atExposure, 6);
    expect(applied[0][0]).not.toBeCloseTo(atExposure * 2, 3);              // the tilt-60 answer
  });

  it("refuses when posture is unavailable for the exposure time", async () => {
    const postures = new PostureHistory();
    postures.record(8000, 10, 0);        // all AFTER the 5000ms exposure
    postures.record(9000, 10, 0);
    const { c, applied } = harness({ postures });
    expect(await c.tick()).toBe("no_posture");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when there is no frame", async () => {
    const { c, applied } = harness({ frames: { latest: () => null, start(){}, stop(){} } });
    expect(await c.tick()).toBe("no_frame");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when the detector is unavailable", async () => {
    const { c, applied } = harness({ detector: { detect: async () => null } as never });
    expect(await c.tick()).toBe("detector_unavailable");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing when the gate rejects a decoy", async () => {
    const { c, applied } = harness({
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 400, conf: 0.99 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
    });
    expect(await c.tick()).toBe("none_near_prediction");
    expect(applied).toHaveLength(0);
  });

  it("contributes nothing before a scale has been measured", async () => {
    const { c, applied } = harness({ focalPx: () => null });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("DISCARDS a correction over the sanity bound rather than clamping it", async () => {
    // NOTE on why this case and not a big pixel offset: with gain < 1 an
    // IN-FRAME detection can never exceed the bound -- it implies at most half
    // the diagonal FOV, and the gain shrinks it further. The bound exists to
    // catch the cos(tilt) blow-up near the pole (and a corrupt focalPx), which
    // is what this exercises: at tilt 85 the pan correction is divided by
    // cos(85) = 0.087, an ~11.5x amplification.
    const postures = new PostureHistory();
    postures.record(1000, 10, 85);
    postures.record(9000, 10, 85);
    const { c, applied, logged } = harness({
      postures,
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: 900, dyPx: 0 }),
    });
    // 0.3 * atan(900/F) / cos(85) ~= 97deg, against a bound of ~18deg.
    expect(await c.tick()).toBe("over_sanity_bound");
    expect(applied).toHaveLength(0);     // NOT a clamped value
    expect(logged[0][0]).toBe("over_sanity_bound");
  });

  it("pins the sanity bound's VALUE: just under is applied, just over is discarded", () => {
    // The over-bound test above clears the bound by ~5x, so it would still
    // pass if the bound itself were computed wrong (e.g. a fovDegFromFocalPx
    // that returned 66deg instead of 35.98deg). These two bracket it.
    // Bound = min(hfov, vfov)/2 = min(60, 35.9834)/2 = 17.9917deg.
    // Choose a tilt whose cos amplification lands the correction either side.
    // At dxPx=200, gain 0.3: base = 0.3*atan(200/F)*DEG = 2.0581deg.
    // /cos(t) crosses 17.9917 at cos(t) = 0.11439, i.e. t = 83.431deg.
    const near = (tiltDeg: number) => {
      const postures = new PostureHistory();
      postures.record(1000, 10, tiltDeg);
      postures.record(9000, 10, tiltDeg);
      return harness({ postures });
    };
    return (async () => {
      const under = near(83.0);            // cos = 0.12187 -> 16.888deg, under
      expect(await under.c.tick()).toBe("applied");
      const over = near(83.9);             // cos = 0.10627 -> 19.366deg, over
      expect(await over.c.tick()).toBe("over_sanity_bound");
      expect(over.applied).toHaveLength(0);
    })();
  });

  it("a NaN correction is DISCARDED, not applied — pins the fail-closed form", () => {
    // Without this, reverting `!(hypot <= bound)` to `hypot > bound` passes
    // the entire file: NaN > bound is false, so the NaN sails through, and
    // nudgeOffset's clamp then latches the aim offset permanently.
    return (async () => {
      const { c, applied, logged } = harness({ gain: () => NaN });
      expect(await c.tick()).toBe("over_sanity_bound");
      expect(applied).toHaveLength(0);
      expect(logged[0][0]).toBe("over_sanity_bound");
    })();
  });

  it("does not call the detector when it already knows it cannot use the answer", () => {
    // The detector is a remote inference. Burning one every tick while the
    // rig has no scale or no posture-at-exposure -- states that persist for
    // minutes -- is pure waste.
    return (async () => {
      let calls = 0;
      const counting = { detect: async () => { calls++; return null; } } as never;
      const noScale = harness({ detector: counting, focalPx: () => null });
      expect(await noScale.c.tick()).toBe("no_scale");
      const late = new PostureHistory();
      late.record(8000, 10, 0); late.record(9000, 10, 0);   // all after the 5000ms exposure
      const noPosture = harness({ detector: counting, postures: late });
      expect(await noPosture.c.tick()).toBe("no_posture");
      expect(calls).toBe(0);
    })();
  });

  it("read-only mode logs the correction it would have made and applies nothing", async () => {
    const { c, applied, logged } = harness({ readOnly: () => true });
    expect(await c.tick()).toBe("read_only");
    expect(applied).toHaveLength(0);
    expect(logged[0][1].panDeg).toBeCloseTo(0.3 * (Math.atan(200 / F) * 180) / Math.PI, 6);
  });

  it("evaluates predictPixel at the EXPOSURE epoch, not arrival and not now", async () => {
    // The posture limb of this invariant is well guarded; without this the
    // prediction limb is not guarded at all, and a mismatch BETWEEN the two
    // limbs is the exact defect -- an ADS-B fix evaluated at the wrong epoch
    // produced a 1.91s pointing lag in the field.
    const { c, predictArgs } = harness();
    await c.tick();
    expect(predictArgs).toEqual([5000]);      // exposureMs, not arrivedMs (5300)
  });

  it("fails CLOSED on a NaN correction instead of applying it", async () => {
    // NaN > bound is false, so a `>` guard waves NaN through -- and
    // nudgeOffset's clamp propagates it, latching the offset permanently.
    const { c, applied } = harness({ focalPx: () => NaN });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("treats a zero focal length as no scale, not as a 90 degree bound", async () => {
    const { c, applied } = harness({ focalPx: () => 0 });
    expect(await c.tick()).toBe("no_scale");
    expect(applied).toHaveLength(0);
  });

  it("reports a missing PREDICTION distinctly from a missing posture", async () => {
    const { c, applied } = harness({ predictPixel: () => null });
    expect(await c.tick()).toBe("no_prediction");
    expect(applied).toHaveLength(0);
  });

  it("bounds on the NARROWER dimension whichever way the frame is oriented", async () => {
    // Every other test uses landscape 1920x1080, where height is narrower --
    // so a height-only bound passes them all. Portrait swaps which one binds.
    const postures = new PostureHistory();
    postures.record(1000, 10, 83.9);
    postures.record(9000, 10, 83.9);
    const { c } = harness({ postures, frameSizePx: () => ({ widthPx: 1080, heightPx: 1920 }) });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("measures the correction as a VECTOR magnitude, not one axis", async () => {
    // Both axes contribute; a bound testing only |panDeg| would accept this.
    const postures = new PostureHistory();
    postures.record(1000, 10, 83.0);
    postures.record(9000, 10, 83.0);
    const { c } = harness({
      postures,
      detector: { detect: async () => ({ detections: [{ dxPx: 200, dyPx: 900, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: (t: number) => ({ dxPx: 200, dyPx: 900 }),
    });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("logs the applied correction, not only the refusals", async () => {
    const { c, logged } = harness();
    await c.tick();
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("applied");
    expect(logged[0][1].panDeg).toBeCloseTo(0.3 * (Math.atan(200 / F) * 180) / Math.PI, 6);
  });

  it("an over-bound detection reads over_sanity_bound even in read-only mode", async () => {
    // Otherwise the evaluation log silently contains corrections the live
    // path would have refused, and the read-only comparison is misleading.
    const postures = new PostureHistory();
    postures.record(1000, 10, 85);
    postures.record(9000, 10, 85);
    const { c } = harness({
      postures, readOnly: () => true,
      detector: { detect: async () => ({ detections: [{ dxPx: 900, dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: (t: number) => ({ dxPx: 900, dyPx: 0 }),
    });
    expect(await c.tick()).toBe("over_sanity_bound");
  });

  it("converges rather than oscillates over repeated ticks", async () => {
    // A standing bias puts the aircraft off-centre by exactly that angle.
    // ADS-B predicts it THERE too (the prediction accounts for where the rig
    // is actually pointing), so the gate must accept -- hence predictPixel
    // tracks the same pixel as the detection rather than sitting at centre.
    let bias = 4.0;                      // degrees of standing error
    const pixelOf = () => F * Math.tan((bias * Math.PI) / 180);
    const errs: number[] = [];
    // A fresh arrivedMs per tick, like a real (non-frozen) stream -- Fix B's
    // de-duplication would otherwise refuse every tick after the first
    // against the shared default frame's fixed arrivedMs. exposureMs stays
    // fixed at 5000 (inside the flat posture record's [1000, 9000] span);
    // `now` tracks arrivedMs exactly so the frame is never stale.
    let tickN = 0;
    const arrivedMsFor = () => 5300 + tickN;
    const { c } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: arrivedMsFor() }),
        start(){}, stop(){} },
      now: () => arrivedMsFor(),
      detector: { detect: async () => ({
        detections: [{ dxPx: pixelOf(), dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: pixelOf(), dyPx: 0 }),
      applyOffset: (p) => { bias -= p; },
    });
    const signed: number[] = [];
    for (let i = 0; i < 12; i++) { tickN++; await c.tick(); signed.push(bias); errs.push(Math.abs(bias)); }
    // Math.abs erases the sign, so a gain in (1, 1.841) overshoots and flips
    // sign every tick -- physical hunting on the mount -- while still passing
    // a magnitude-only check. Pin the sign.
    for (let i = 1; i < signed.length; i++) expect(Math.sign(signed[i])).toBe(Math.sign(signed[0]));
    // At tilt 0, atan(F*tan(bias)/F) === bias exactly, so each tick removes
    // gain*bias and the residual shrinks by a factor of 0.7 per tick.
    for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThan(errs[i - 1]);
    expect(errs[errs.length - 1]).toBeLessThan(0.5);
  });
});

// -----------------------------------------------------------------------
// Test group 4 (brief) + fix round 5 (independent re-review, missing
// negation): a camera's sign converges once MEASURED and negated, not
// asserted. The round-4 version of this block built pixels directly as
// `AXIS_SIGN * F * tan(bias)` FROM the pointing error and claimed that was
// "the same relationship solveStepResponse's signedFocal inverts" -- it is
// not: signedFocal divides by the COMMANDED STEP, not the pointing error,
// and the two differ by exactly the negation vision-tools.ts was missing.
// That fixture stated the code's own (buggy) convention and so could not
// catch the bug. This version runs the REAL solveStepResponse against an
// INDEPENDENT physical projection to MEASURE axisSign, negates it exactly
// as vision-tools.ts's calibrate_vision_scale now does, and only THEN
// drives the corrector -- for two independent mountings.
// -----------------------------------------------------------------------
describe("VisionCorrector — MEASURED (not asserted) axisSign converges, both mountings and axes", () => {
  // Independent physical projection -- NOT the code's own convention.
  // panPhysical/tiltPhysical are the camera's true handedness constants.
  // NORMAL matches the brief's own stated physics (panning +Δ moves a
  // fixed image LEFT) and app.py's documented y-down-positive convention
  // (see vision-geometry.test.ts's "app.py convention" tests, which derive
  // the SAME tiltPhysical=-1 independently, from the image-coordinate side
  // rather than the calibration side). MIRRORED is both axes flipped.
  function projectDx(panPhysical: 1 | -1, deltaPanDeg: number, tiltDeg: number): number {
    const trueAngle = deltaPanDeg * Math.cos((tiltDeg * Math.PI) / 180);
    return panPhysical * F * Math.tan((trueAngle * Math.PI) / 180);
  }
  function projectDy(tiltPhysical: 1 | -1, deltaTiltDeg: number): number {
    return tiltPhysical * F * Math.tan((deltaTiltDeg * Math.PI) / 180);
  }

  // MEASURE the correction sign the same way calibrate_vision_scale does:
  // command a step, observe the projection's response (a FIXED target's
  // angular offset from the boresight changes by -stepDeg when the
  // boresight is commanded +stepDeg), run the REAL solveStepResponse, then
  // negate at the boundary (axisSign is d(pixel)/d(command); the
  // correction consumed by pixelToAngularError is d(command)/d(pixel
  // offset), opposite in sign -- see vision-tools.ts's calibrate_vision_scale
  // doc).
  function measureCorrectionSign(axis: "pan" | "tilt", physical: 1 | -1): 1 | -1 {
    const stepDeg = 5;
    const obs: { tMs: number; dxPx: number; dyPx: number }[] = [];
    for (let t = 0; t <= 2000; t += 100) {
      const settled = t >= 400;
      const px = axis === "pan"
        ? projectDx(physical, settled ? -stepDeg : 0, 0)
        : projectDy(physical, settled ? -stepDeg : 0);
      obs.push({ tMs: t, dxPx: axis === "pan" ? px : 0, dyPx: axis === "tilt" ? px : 0 });
    }
    const r = solveStepResponse(obs, 0, stepDeg, 0, axis)!;
    return (-r.axisSign) as 1 | -1;
  }

  const NORMAL = { panPhysical: 1 as const, tiltPhysical: -1 as const, label: "normal mount" };
  const MIRRORED = { panPhysical: -1 as const, tiltPhysical: 1 as const, label: "mirrored mount" };

  for (const mount of [NORMAL, MIRRORED]) {
    it(`${mount.label}: measured-and-negated PAN sign converges to centred`, async () => {
      const correctionSign = measureCorrectionSign("pan", mount.panPhysical);
      // Sanity: the measured-and-negated sign must reproduce the
      // INDEPENDENTLY chosen physical constant -- this is the assertion
      // that would have caught the missing negation (which passed a
      // convergence-only check because it hardcoded the right answer
      // directly instead of deriving it).
      expect(correctionSign).toBe(mount.panPhysical);

      let boresightPanDeg = 0;
      const targetPanDeg = 4.0;
      let tickN = 0;
      const arrivedMsFor = () => 5300 + tickN;
      const errs: number[] = [];
      const { c } = harness({
        frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: arrivedMsFor() }),
          start(){}, stop(){} },
        now: () => arrivedMsFor(),
        axisSigns: () => ({ pan: correctionSign, tilt: 1 }),
        detector: { detect: async () => ({
          detections: [{ dxPx: projectDx(mount.panPhysical, targetPanDeg - boresightPanDeg, 0), dyPx: 0, conf: 0.9 }],
          widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
        predictPixel: () => ({ dxPx: projectDx(mount.panPhysical, targetPanDeg - boresightPanDeg, 0), dyPx: 0 }),
        applyOffset: (p) => { boresightPanDeg += p; },
      });
      for (let i = 0; i < 12; i++) { tickN++; await c.tick(); errs.push(Math.abs(targetPanDeg - boresightPanDeg)); }
      for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThanOrEqual(errs[i - 1]);
      expect(errs[errs.length - 1]).toBeLessThan(0.5);
    });

    it(`${mount.label}: measured-and-negated TILT sign converges to centred`, async () => {
      const correctionSign = measureCorrectionSign("tilt", mount.tiltPhysical);
      expect(correctionSign).toBe(mount.tiltPhysical);

      let boresightTiltDeg = 0;
      const targetTiltDeg = 3.0;
      let tickN = 0;
      const arrivedMsFor = () => 5300 + tickN;
      const errs: number[] = [];
      const { c } = harness({
        frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: arrivedMsFor() }),
          start(){}, stop(){} },
        now: () => arrivedMsFor(),
        axisSigns: () => ({ pan: 1, tilt: correctionSign }),
        detector: { detect: async () => ({
          detections: [{ dxPx: 0, dyPx: projectDy(mount.tiltPhysical, targetTiltDeg - boresightTiltDeg), conf: 0.9 }],
          widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
        predictPixel: () => ({ dxPx: 0, dyPx: projectDy(mount.tiltPhysical, targetTiltDeg - boresightTiltDeg) }),
        applyOffset: (_p, t) => { boresightTiltDeg += t; },
      });
      for (let i = 0; i < 12; i++) { tickN++; await c.tick(); errs.push(Math.abs(targetTiltDeg - boresightTiltDeg)); }
      for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThanOrEqual(errs[i - 1]);
      expect(errs[errs.length - 1]).toBeLessThan(0.5);
    });
  }

  it("a HARDCODED nominal sign diverges on the normal mount's tilt axis (C1/C2's exact mechanism)", async () => {
    // NOMINAL {pan:1, tilt:1} happens to equal the NORMAL mount's correct
    // pan sign (measured-and-negated correctionSign === physicalSign, a
    // coincidence of how the default was originally chosen) but is WRONG
    // for tilt even on the normal, real-world, app.py-documented mounting
    // -- this is the case a hardcoded nominal default actually gets wrong.
    let boresightTiltDeg = 0;
    const targetTiltDeg = 3.0;
    let tickN = 0;
    const arrivedMsFor = () => 5300 + tickN;
    const { c } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: arrivedMsFor() }),
        start(){}, stop(){} },
      now: () => arrivedMsFor(),
      axisSigns: () => NOMINAL_AXIS_SIGNS,   // WRONG for tilt on the normal mount -- the bug
      detector: { detect: async () => ({
        detections: [{ dxPx: 0, dyPx: projectDy(NORMAL.tiltPhysical, targetTiltDeg - boresightTiltDeg), conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: 0, dyPx: projectDy(NORMAL.tiltPhysical, targetTiltDeg - boresightTiltDeg) }),
      applyOffset: (_p, t) => { boresightTiltDeg += t; },
    });
    for (let i = 0; i < 5; i++) { tickN++; await c.tick(); }
    expect(Math.abs(targetTiltDeg - boresightTiltDeg)).toBeGreaterThan(3.0);   // grew, did not converge
  });
});

// -----------------------------------------------------------------------
// Fix B (C3): frame freshness + de-duplication. Before this, `latest()` was
// cleared only by stop() -- a frozen upstream stream re-serves the SAME
// StampedFrame forever, both limbs (posture-at-exposure and the prediction)
// read the same stale exposureMs and keep agreeing, and the gate keeps
// passing: measured winds the offset to the clamp while `applied` is logged
// every tick.
// -----------------------------------------------------------------------
describe("VisionCorrector — frame freshness and de-duplication (Fix B / C3)", () => {
  it("refuses a frame older than frameMaxAgeMs as frame_stale, before touching the detector", async () => {
    let detectCalls = 0;
    const { c, applied } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
      now: () => 5300 + 3001,           // 3001ms old against the 3000ms default
      frameMaxAgeMs: () => 3000,
      detector: { detect: async () => { detectCalls++; return null; } } as never,
    });
    expect(await c.tick()).toBe("frame_stale");
    expect(applied).toHaveLength(0);
    expect(detectCalls).toBe(0);
  });

  it("accepts a frame within frameMaxAgeMs", async () => {
    const { c, applied } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
      now: () => 5300 + 2999,
      frameMaxAgeMs: () => 3000,
    });
    expect(await c.tick()).toBe("applied");
    expect(applied).toHaveLength(1);
  });

  it("refuses the SAME frame consumed twice as frame_duplicate on the second tick", async () => {
    let detectCalls = 0;
    const { c, applied, logged } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
      now: () => 5300,
      detector: { detect: async () => {
        detectCalls++;
        return { detections: [{ dxPx: 200, dyPx: -100, conf: 0.9 }], widthPx: 1920, heightPx: 1080, inferMs: 3 };
      } } as never,
    });
    expect(await c.tick()).toBe("applied");
    expect(await c.tick()).toBe("frame_duplicate");
    expect(applied).toHaveLength(1);          // NOT two
    expect(detectCalls).toBe(1);               // the detector was not asked twice for the same frame
    expect(logged[1][0]).toBe("frame_duplicate");
  });

  // THE WIND-UP REGRESSION: a frozen stream re-serving the same frame must
  // contribute nothing beyond the first application. Before Fix B this loop
  // wound the aim offset all the way to nudgeOffset's clamp while every tick
  // still logged "applied".
  it("holding a frame constant across 20 ticks does not grow the offset past the first application", async () => {
    let offsetPanDeg = 0;
    const { c } = harness({
      frames: { latest: () => ({ jpegBase64: "Zm9v", exposureMs: 5000, arrivedMs: 5300 }), start(){}, stop(){} },
      now: () => 5300,
      applyOffset: (p) => { offsetPanDeg += p; },
    });
    const afterFirst: number[] = [];
    for (let i = 0; i < 20; i++) {
      await c.tick();
      afterFirst.push(offsetPanDeg);
    }
    const firstApplied = afterFirst[0];
    expect(firstApplied).not.toBe(0);
    for (let i = 1; i < afterFirst.length; i++) expect(afterFirst[i]).toBe(firstApplied);
  });
});

// -----------------------------------------------------------------------
// Fix 3: an uncalibrated tilt axis must contribute NOTHING, not a
// correction computed with a guessed/defaulted sign -- that guess is C2's
// exact failure mode, and substituting nominal `+1` on a failed tilt solve
// would reinstate it silently (it is wrong for tilt even on the real,
// normal, app.py-documented mounting -- see the "MEASURED axisSign"
// describe block above).
// -----------------------------------------------------------------------
describe("VisionCorrector — zeroes the tilt term when tiltCalibrated() is false (Fix 3)", () => {
  it("applies the pan correction but zeroes tiltDeg when tilt is uncalibrated", async () => {
    const { c, applied } = harness({
      tiltCalibrated: () => false,
      // A real, nonzero dyPx in the detection -- if the corrector trusted
      // axisSigns().tilt's default instead of checking tiltCalibrated(),
      // this would produce a nonzero (and possibly backwards) tiltDeg.
      detector: { detect: async () => ({ detections: [{ dxPx: 200, dyPx: -100, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
    });
    expect(await c.tick()).toBe("applied");
    expect(applied[0][0]).not.toBe(0);    // pan still corrects
    expect(applied[0][1]).toBe(0);        // tilt contributes nothing
  });

  it("applies BOTH axes normally once tiltCalibrated() is true", async () => {
    const { c, applied } = harness({ tiltCalibrated: () => true });
    expect(await c.tick()).toBe("applied");
    expect(applied[0][0]).not.toBe(0);
    expect(applied[0][1]).not.toBe(0);
  });
});
