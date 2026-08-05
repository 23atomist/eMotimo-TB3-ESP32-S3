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
});
