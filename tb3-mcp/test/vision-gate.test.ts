import { describe, it, expect } from "vitest";
import { gateDetections } from "../src/vision/gate.js";

const PRED = { dxPx: 100, dyPx: -50 };
const R = 80, MINCONF = 0.25;

describe("gateDetections", () => {
  it("accepts a lone confident detection near the prediction", () => {
    const c = { dxPx: 110, dyPx: -40, conf: 0.9 };
    expect(gateDetections([c], PRED, R, MINCONF)).toEqual({ accepted: c });
  });

  it("rejects when there are no candidates at all", () => {
    expect(gateDetections([], PRED, R, MINCONF)).toEqual({ rejected: "no_candidates" });
  });

  it("rejects a HIGH-confidence decoy far from the prediction", () => {
    // The whole point: detector confidence does not override geometry.
    const decoy = { dxPx: 900, dyPx: 400, conf: 0.99 };
    expect(gateDetections([decoy], PRED, R, MINCONF)).toEqual({ rejected: "none_near_prediction" });
  });

  it("keeps the near one and discards the far one", () => {
    const near = { dxPx: 105, dyPx: -55, conf: 0.4 };
    const far  = { dxPx: 900, dyPx: 400, conf: 0.99 };
    expect(gateDetections([far, near], PRED, R, MINCONF)).toEqual({ accepted: near });
  });

  it("rejects as ambiguous when two survive — does NOT pick the higher confidence", () => {
    const a = { dxPx: 105, dyPx: -55, conf: 0.4 };
    const b = { dxPx: 120, dyPx: -30, conf: 0.95 };
    expect(gateDetections([a, b], PRED, R, MINCONF)).toEqual({ rejected: "ambiguous" });
  });

  it("drops sub-threshold confidence before the geometry test", () => {
    const weak = { dxPx: 105, dyPx: -55, conf: 0.1 };
    expect(gateDetections([weak], PRED, R, MINCONF)).toEqual({ rejected: "no_candidates" });
  });

  it("uses radial distance, not per-axis — a corner at r>radius is rejected", () => {
    // dx=+60, dy=+60 from prediction: each axis under 80, radius 84.9 over.
    const corner = { dxPx: 160, dyPx: 10, conf: 0.9 };
    expect(gateDetections([corner], PRED, R, MINCONF)).toEqual({ rejected: "none_near_prediction" });
  });
});
