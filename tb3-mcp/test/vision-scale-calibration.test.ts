import { describe, it, expect } from "vitest";
import { solveStepResponse } from "../src/vision/scale-calibration.js";
import { focalPxFromFov } from "../src/vision/geometry.js";

// Build a synthetic step response with a KNOWN latency and KNOWN focal length.
function synth(latencyMs: number, focalPx: number, stepPanDeg: number, tiltDeg: number) {
  const trueAngle = stepPanDeg * Math.cos((tiltDeg * Math.PI) / 180);
  const settledPx = focalPx * Math.tan((trueAngle * Math.PI) / 180);
  const obs = [];
  for (let t = 0; t <= 2000; t += 100) {
    obs.push({ tMs: t, dxPx: t < latencyMs ? 0 : settledPx, dyPx: 0 });
  }
  return obs;
}

describe("solveStepResponse", () => {
  it("recovers BOTH the latency and the focal length", () => {
    const F = focalPxFromFov(1920, 60);
    const r = solveStepResponse(synth(400, F, 5, 0), 0, 5, 0)!;
    expect(r.latencyMs).toBeCloseTo(400, -2);   // within ~a sample period
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  it("accounts for cos(tilt) — the same pixel step at 60deg implies a DIFFERENT focal length", () => {
    const F = focalPxFromFov(1920, 60);
    // Synthesised at 60deg tilt: the true angular step is halved, so the same
    // focal length produces half the pixel movement.
    const r = solveStepResponse(synth(300, F, 5, 60), 0, 5, 60)!;
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  it("a solver ignoring cos(tilt) would be wrong by 2x at 60deg — pin that it is not", () => {
    const F = focalPxFromFov(1920, 60);
    const flat = solveStepResponse(synth(300, F, 5, 0), 0, 5, 0)!;
    const high = solveStepResponse(synth(300, F, 5, 60), 0, 5, 60)!;
    expect(high.focalPx / flat.focalPx).toBeCloseTo(1, 1);
  });

  it("ABSOLUTE pin: recovers a hand-computed focal length with no reference to focalPxFromFov", () => {
    // Every other assertion here builds pixels FROM F and recovers F, so it
    // passes under any consistent rescaling. This one is hand-computed:
    // a 5deg step at tilt 0 has trueAngle 5deg, tan(5deg) = 0.08748866,
    // so a settled displacement of 100px implies focalPx = 100/0.08748866
    // = 1143.005.
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: t < 400 ? 0 : 100, dyPx: 0 });
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r.focalPx).toBeCloseTo(1143.005, 2);
    expect(r.latencyMs).toBeCloseTo(400, -2);
  });

  it("ignores a transient noise blip and anchors latency to the REAL step edge", () => {
    // A single 2.5px sample crossing the threshold before the true settle at
    // t=400. Anchoring to the blip gives latencyMs 100 -- 4x too small -- and
    // that number feeds exposureMs = arrivedMs - latencyMs().
    const obs = [
      { tMs: 0, dxPx: 0, dyPx: 0 },
      { tMs: 100, dxPx: 2.5, dyPx: 0 },    // blip
      { tMs: 200, dxPx: 0.5, dyPx: 0 },
      { tMs: 300, dxPx: 1, dyPx: 0 },
      { tMs: 400, dxPx: 50, dyPx: 0 },     // real edge
      { tMs: 500, dxPx: 50, dyPx: 0 },
      { tMs: 600, dxPx: 50, dyPx: 0 },
    ];
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r.latencyMs).toBe(400);
  });

  it("returns null when the image never moves", () => {
    const flat = Array.from({ length: 21 }, (_, i) => ({ tMs: i * 100, dxPx: 0, dyPx: 0 }));
    expect(solveStepResponse(flat, 0, 5, 0)).toBeNull();
  });

  it("returns null on too few observations to settle", () => {
    expect(solveStepResponse([{ tMs: 0, dxPx: 0, dyPx: 0 }], 0, 5, 0)).toBeNull();
  });

  it("returns null at the degenerate pole where the step conveys no pan information", () => {
    const F = focalPxFromFov(1920, 60);
    expect(solveStepResponse(synth(300, F, 5, 89.99), 0, 5, 89.99)).toBeNull();
  });

  // -------------------------------------------------------------------
  // Fix A1 (C1/C2/C4/I1). "Every fixture built its pixels in the code's
  // own sign convention" is exactly what let C1/C2 survive nine per-task
  // reviews -- the tests below are built to NOT have that property.
  // -------------------------------------------------------------------

  // Test group 1: sign recovery, both directions. A hardcoded sign cannot
  // pass both of these at once.
  it("recovers axisSign = -1 for a camera whose image moves OPPOSITE the commanded step (the normal-mount case)", () => {
    // A camera panning +5deg on a normal, non-mirrored mount sees a fixed
    // object move LEFT (negative dxPx) -- settledPx is negative here.
    const F = focalPxFromFov(1920, 60);
    const trueAngle = 5 * Math.cos(0);
    const settledPx = -F * Math.tan((trueAngle * Math.PI) / 180);
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: t < 400 ? 0 : settledPx, dyPx: 0 });
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r).not.toBeNull();
    expect(r.axisSign).toBe(-1);
    expect(r.focalPx).toBeGreaterThan(0);
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  it("recovers axisSign = +1 for a camera whose image moves WITH the commanded step (mirrored/inverted mount)", () => {
    const F = focalPxFromFov(1920, 60);
    const trueAngle = 5 * Math.cos(0);
    const settledPx = F * Math.tan((trueAngle * Math.PI) / 180);   // POSITIVE
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: t < 400 ? 0 : settledPx, dyPx: 0 });
    const r = solveStepResponse(obs, 0, 5, 0)!;
    expect(r).not.toBeNull();
    expect(r.axisSign).toBe(1);
    expect(r.focalPx).toBeGreaterThan(0);
    expect(r.focalPx).toBeCloseTo(F, 0);
  });

  // Test group 2: the baseline matters. Same TRUE displacement, but the
  // target starts 200px off-centre before the step is ever commanded.
  // Under the old absolute-offset logic the very first sample (200px) would
  // already clear MOVE_THRESHOLD_PX, anchoring latency near 0 and inflating
  // focalPx; with a baseline, displacement is measured FROM the pre-step
  // 200px, not from 0.
  it("an off-centre target before the step recovers the SAME focalPx/latencyMs as a centred one", () => {
    const F = focalPxFromFov(1920, 60);
    const trueAngle = 5 * Math.cos(0);
    const trueSettledDelta = F * Math.tan((trueAngle * Math.PI) / 180);

    // Centred baseline (the existing fixtures' shape): starts at 0, jumps to
    // trueSettledDelta at t=400.
    const centred = [];
    for (let t = 0; t <= 2000; t += 100) {
      centred.push({ tMs: t, dxPx: t < 400 ? 0 : trueSettledDelta, dyPx: 0 });
    }
    const rCentred = solveStepResponse(centred, 0, 5, 0)!;

    // Off-centre: PRE-STEP samples (tMs < stepAppliedAtMs=1000) sit at a
    // 200px baseline; POST-STEP samples settle at baseline + the SAME true
    // delta. stepAppliedAtMs is pushed out to 1000 so there is room for
    // pre-step samples in the fixture.
    const OFFSET = 200;
    const offCentre = [];
    for (let t = 0; t <= 600; t += 100) offCentre.push({ tMs: t, dxPx: OFFSET, dyPx: 0 });        // pre-step
    for (let t = 1000; t <= 3000; t += 100) {
      offCentre.push({ tMs: t, dxPx: t < 1400 ? OFFSET : OFFSET + trueSettledDelta, dyPx: 0 });    // post-step
    }
    const rOffCentre = solveStepResponse(offCentre, 1000, 5, 0)!;

    expect(rOffCentre).not.toBeNull();
    expect(rOffCentre.focalPx).toBeCloseTo(rCentred.focalPx, 6);
    expect(rOffCentre.latencyMs).toBeCloseTo(rCentred.latencyMs, 6);
  });

  it("WITHOUT a baseline, an off-centre start would be misread — pins that the fix actually changes the answer", () => {
    // Same off-centre fixture as above, but stepAppliedAtMs is set to 0
    // (matching the OLD code's assumption that observations begin AT the
    // step) so every "pre-step" sample above is instead read as
    // ALREADY-POST-STEP. The very first sample (200px) then already clears
    // MOVE_THRESHOLD_PX, anchoring latency at ~0 -- a materially different,
    // WRONG answer versus the correctly-baselined case.
    const F = focalPxFromFov(1920, 60);
    const trueAngle = 5 * Math.cos(0);
    const trueSettledDelta = F * Math.tan((trueAngle * Math.PI) / 180);
    const OFFSET = 200;
    const offCentre = [];
    for (let t = 0; t <= 600; t += 100) offCentre.push({ tMs: t, dxPx: OFFSET, dyPx: 0 });
    for (let t = 1000; t <= 3000; t += 100) {
      offCentre.push({ tMs: t, dxPx: t < 1400 ? OFFSET : OFFSET + trueSettledDelta, dyPx: 0 });
    }
    const rMisread = solveStepResponse(offCentre, 0, 5, 0)!;
    const rCorrect = solveStepResponse(offCentre, 1000, 5, 0)!;
    expect(rMisread.latencyMs).not.toBeCloseTo(rCorrect.latencyMs, 0);
  });

  // Test group: tilt axis. Not degenerate at the pole, no cos(tilt)
  // foreshortening, reads dyPx instead of dxPx.
  it("solves a TILT step from dyPx, with no cos(tilt) foreshortening", () => {
    const F = focalPxFromFov(1920, 60);
    // trueAngle for a TILT step is the commanded angle directly (not *cos).
    const settledPx = F * Math.tan((5 * Math.PI) / 180);
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: 999, dyPx: t < 400 ? 0 : settledPx });
    const r = solveStepResponse(obs, 0, 5, 40, "tilt")!;
    expect(r).not.toBeNull();
    expect(r.focalPx).toBeCloseTo(F, 0);
    expect(r.axisSign).toBe(1);
  });

  it("a tilt step at the pole (tiltDegAtStep near 90) is NOT degenerate, unlike pan", () => {
    const F = focalPxFromFov(1920, 60);
    const settledPx = F * Math.tan((5 * Math.PI) / 180);
    const obs = [];
    for (let t = 0; t <= 2000; t += 100) obs.push({ tMs: t, dxPx: 0, dyPx: t < 400 ? 0 : settledPx });
    expect(solveStepResponse(obs, 0, 5, 89.99, "tilt")).not.toBeNull();
  });
});
