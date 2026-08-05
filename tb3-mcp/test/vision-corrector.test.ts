import { describe, it, expect } from "vitest";
import { VisionCorrector, CorrectorDeps } from "../src/vision/corrector.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { focalPxFromFov } from "../src/vision/geometry.js";

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
    frameSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
    gain: () => 0.3,
    readOnly: () => false,
    gateRadiusPx: () => 80,
    minConf: () => 0.25,
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
    const { c } = harness({
      detector: { detect: async () => ({
        detections: [{ dxPx: pixelOf(), dyPx: 0, conf: 0.9 }],
        widthPx: 1920, heightPx: 1080, inferMs: 3 }) } as never,
      predictPixel: () => ({ dxPx: pixelOf(), dyPx: 0 }),
      applyOffset: (p) => { bias -= p; },
    });
    const signed: number[] = [];
    for (let i = 0; i < 12; i++) { await c.tick(); signed.push(bias); errs.push(Math.abs(bias)); }
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
