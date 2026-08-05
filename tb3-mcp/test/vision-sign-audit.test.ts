// INDEPENDENT REVIEW AUDIT -- not part of the branch. Built from first
// principles, deliberately not reusing any fixture on the branch.
//
// Physical model (derived, not copied):
//   image x grows RIGHT, y grows DOWN (services/detector/app.py: dxPx =
//   boxCentreX - cx, dyPx = boxCentreY - cy, PIL/YOLO coords).
//   +pan rotates the boresight RIGHT, +tilt aims it UP (user-angle frame,
//   the frame moveToUserAngle takes and PostureHistory records).
//
//   Let dPan = targetPan - boresightPan, dTilt = targetTilt - boresightTilt.
//   For a NORMAL, non-mirrored, upright camera:
//     a target to the RIGHT of the boresight (dPan>0) appears right of
//     centre  => dxPx > 0                       => kx = +1
//     a target ABOVE the boresight (dTilt>0) appears near the TOP, i.e. at a
//     SMALLER y => dyPx < 0                     => ky = -1
//   Parameterised as
//     dxPx = kx * f * tan(dPan * cos(boresightTilt))
//     dyPx = ky * f * tan(dTilt)
//   so all four handedness combinations can be exercised.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { loadConfig } from "../src/config.js";
import { Device } from "../src/device.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { VisionScaleStore } from "../src/vision-scale-store.js";
import { solveStepResponse } from "../src/vision/scale-calibration.js";
import { focalPxFromFov, pixelToAngularError } from "../src/vision/geometry.js";
import { VisionCorrector, CorrectorOutcome } from "../src/vision/corrector.js";
import { gateDetections } from "../src/vision/gate.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { nudgeOffset, AimOffset, ZERO_OFFSET } from "../src/track/offset.js";
import {
  registerVisionTools, VisionRuntime, toVisionScale, buildPredictPixel,
  resolveVisionFrameSizePx,
} from "../src/vision-tools.js";
import type { FrameSource } from "../src/vision/frame-source.js";
import type { DetectResponse } from "../src/vision/detector-client.js";
import type { Config } from "../src/config.js";

const RAD = Math.PI / 180;
const W = 1920, H = 1080;
const F_TRUE = focalPxFromFov(W, 55);
const STEPS_PER_DEG = 444.444;
const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

interface Mount { kx: 1 | -1; ky: 1 | -1; label: string }
const NORMAL: Mount    = { kx: 1,  ky: -1, label: "NORMAL (upright, non-mirrored)" };
const INVERTED: Mount  = { kx: -1, ky: 1,  label: "INVERTED (rotated 180deg)" };
const MIRRORED_X: Mount = { kx: -1, ky: -1, label: "MIRRORED-X only" };
const FLIPPED_Y: Mount  = { kx: 1,  ky: 1,  label: "FLIPPED-Y only" };
const ALL_MOUNTS = [NORMAL, INVERTED, MIRRORED_X, FLIPPED_Y];

function project(
  m: Mount, targetPan: number, targetTilt: number, boresightPan: number, boresightTilt: number,
): { dxPx: number; dyPx: number } {
  const dPan = targetPan - boresightPan;
  const dTilt = targetTilt - boresightTilt;
  const c = Math.cos(boresightTilt * RAD);
  return {
    dxPx: m.kx * F_TRUE * Math.tan(dPan * c * RAD),
    dyPx: m.ky * F_TRUE * Math.tan(dTilt * RAD),
  };
}

// ==========================================================================
// PART 1 -- what does the REAL solveStepResponse measure against MY model?
// ==========================================================================
describe("AUDIT 1: solveStepResponse's axisSign under an independent projection", () => {
  for (const m of ALL_MOUNTS) {
    it(`${m.label}: axisSign is the NEGATIVE of the required correction sign`, () => {
      const stepDeg = 5, LAT = 400;
      const panB = 12, tiltB = 25;
      // Target deliberately OFF-CENTRE before the step, so the pre-step
      // baseline actually matters (I1).
      const targetPan = panB + 0.6, targetTilt = tiltB + 0.4;
      const mk = (axis: "pan" | "tilt") => {
        const obs = [];
        for (let t = -600; t <= 2000; t += 200) {
          const moved = t >= LAT;
          const pB = panB + (axis === "pan" && moved ? stepDeg : 0);
          const tB = tiltB + (axis === "tilt" && moved ? stepDeg : 0);
          const p = project(m, targetPan, targetTilt, pB, tB);
          obs.push({ tMs: t, dxPx: p.dxPx, dyPx: p.dyPx });
        }
        return solveStepResponse(obs, 0, stepDeg, tiltB, axis)!;
      };
      const pan = mk("pan"), tilt = mk("tilt");
      expect(pan).not.toBeNull();
      expect(tilt).not.toBeNull();
      // Focal recovered to within ~1% despite the off-centre target.
      expect(pan.focalPx / F_TRUE).toBeGreaterThan(0.97);
      expect(pan.focalPx / F_TRUE).toBeLessThan(1.03);
      expect(tilt.focalPx / F_TRUE).toBeGreaterThan(0.97);
      expect(tilt.focalPx / F_TRUE).toBeLessThan(1.03);
      expect(pan.latencyMs).toBeGreaterThanOrEqual(LAT);
      // THE DERIVATION: settled = -k*f*tan(step) => axisSign = -k, and the
      // sign pixelToAngularError needs is k. So negation is mandatory.
      expect(pan.axisSign).toBe(-m.kx);
      expect(tilt.axisSign).toBe(-m.ky);
    });
  }
});

// ==========================================================================
// PART 2 -- the REAL tool, the REAL store, the REAL runtime, then the REAL
// closed loop. The signs are never written by this file; they come out of
// calibrate_vision_scale.
// ==========================================================================
const PORT = 8817;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
// NOTE (adoption fix): Device.stop() is the E-STOP HTTP command
// (POST /api/stop), not a teardown method -- close() is. Calling stop()
// here fired an unawaited HTTP request that raced the mock server's own
// shutdown below and surfaced as spurious "fetch failed"/ECONNRESET
// unhandled rejections (all 22 tests still passed; this was test-harness
// noise, not a product defect).
afterEach(async () => { dev?.close(); dev = null; await mock?.stop(); mock = null; });

async function calibrateThroughTheRealTool(m: Mount) {
  mock = new MockTb3(); await mock.start(PORT);
  const startPan = 12, startTilt = 25;
  mock.setPosition(startPan * STEPS_PER_DEG, startTilt * STEPS_PER_DEG);
  const cfg = loadConfig(undefined, {
    TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, TB3_CAMERA_SOURCE: "v4l2",
  });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  while (Math.abs(dev.getState().panSteps - startPan * STEPS_PER_DEG) > 1 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // A target parked slightly off the boresight, FIXED in the world.
  const targetPan = startPan + 0.7, targetTilt = startTilt + 0.5;
  const deviceRef = { current: dev };
  const frames: FrameSource = {
    latest: () => ({ jpegBase64: "Zm9v", arrivedMs: Date.now(), exposureMs: Date.now() }),
    start() {}, stop() {},
  };
  const detector = {
    detect: async (): Promise<DetectResponse> => {
      const st = deviceRef.current!.getState();
      const p = project(m, targetPan, targetTilt, st.panSteps / STEPS_PER_DEG, st.tiltSteps / STEPS_PER_DEG);
      return { detections: [{ dxPx: p.dxPx, dyPx: p.dyPx, conf: 0.9 }], widthPx: W, heightPx: H, inferMs: 1 };
    },
  };

  const dir = mkdtempSync(join(tmpdir(), "tb3-audit-"));
  const calStore = new CalibrationStore(join(dir, "calibration.json"));
  const limits = new LimitsStore(join(dir, "limits.json")); limits.load();
  const session = new TrackingSession(dev, cfg, calStore);
  const supervisor = new SunSupervisor(dev, cfg, calStore, session);
  const runtime = new VisionRuntime(cfg);
  const scaleFile = join(dir, "vision-scale.json");
  const scaleStore = new VisionScaleStore(scaleFile); scaleStore.load();

  const server = new McpServer({ name: "audit", version: "test" });
  registerVisionTools(server, cfg, dev, session, supervisor, frames, detector, runtime, scaleStore,
    () => limits.get());
  const client = new Client({ name: "audit-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const res: any = await client.callTool({
    name: "calibrate_vision_scale", arguments: { step_pan_deg: 5, sample_window_ms: 1200 },
  });
  expect(res.isError).toBeFalsy();
  const body = JSON.parse(textOf(res));

  // Restart simulation: a FRESH store over the same file, through the real
  // toVisionScale, into a fresh VisionRuntime. Nothing in this file writes
  // a sign.
  const reloaded = new VisionScaleStore(scaleFile); reloaded.load();
  const freshRuntime = new VisionRuntime(cfg);
  freshRuntime.setScale(toVisionScale(reloaded.get()!));
  return { body, cfg, freshRuntime, persisted: reloaded.get()! };
}

// The closed loop, real modules only. Returns the trace.
async function runClosedLoop(
  m: Mount, signs: { pan: 1 | -1; tilt: 1 | -1 }, tiltCalibrated: boolean,
  predictSigns: { pan: 1 | -1; tilt: 1 | -1 } | undefined = signs,
  biasPan = 2.0, biasTilt = 1.5,
) {
  predictSigns = predictSigns ?? signs;
  const CFG = { cameraSource: "v4l2", cameraV4l2Size: `${W}x${H}` } as unknown as Config;
  const TRUE_PAN = 100, TRUE_TILT = 30;      // where the aircraft really is
  const BIAS_PAN = biasPan, BIAS_TILT = biasTilt;   // ADS-B aim is this far off
  const CAM_LATENCY = 300;
  let offset: AimOffset = ZERO_OFFSET;
  const offsetLog: { t: number; off: AimOffset }[] = [{ t: -1e9, off: ZERO_OFFSET }];
  const offsetAt = (t: number) => {
    let cur = ZERO_OFFSET;
    for (const e of offsetLog) { if (e.t <= t) cur = e.off; else break; }
    return cur;
  };
  const aimPan = () => TRUE_PAN - BIAS_PAN, aimTilt = () => TRUE_TILT - BIAS_TILT;
  const boresightAt = (t: number) => {
    const o = offsetAt(t);
    return { panDeg: aimPan() + o.panDeg, tiltDeg: aimTilt() + o.tiltDeg };
  };

  const postures = new PostureHistory();
  const targetHistory = new PostureHistory();
  const session = { status: () => ({ state: "tracking", targetAgeMs: 200 }) } as unknown as TrackingSession;

  let now = 0;
  const applied: { panDeg: number; tiltDeg: number }[] = [];
  const outcomes: CorrectorOutcome[] = [];
  const errs: { pan: number; tilt: number }[] = [];

  const corrector = new VisionCorrector({
    frames: {
      latest: () => (now >= 2000 ? { jpegBase64: "Zm9v", arrivedMs: now, exposureMs: now - CAM_LATENCY } : null),
      start() {}, stop() {},
    },
    detector: {
      detect: async (_j: string, _c: number) => {
        // The detector sees the frame's EXPOSURE instant.
        const te = now - CAM_LATENCY;
        const B = boresightAt(te);
        const p = project(m, TRUE_PAN, TRUE_TILT, B.panDeg, B.tiltDeg);
        return { detections: [{ dxPx: p.dxPx, dyPx: p.dyPx, conf: 0.9 }], widthPx: W, heightPx: H, inferMs: 2 };
      },
    } as never,
    postures,
    predictPixel: buildPredictPixel(
      session, targetHistory, postures, () => F_TRUE, 2000, () => predictSigns,
    ),
    applyOffset: (p, t) => {
      applied.push({ panDeg: p, tiltDeg: t });
      const r = nudgeOffset(offset, p, t, 5);
      offset = { panDeg: r.panDeg, tiltDeg: r.tiltDeg };
      offsetLog.push({ t: now, off: offset });
    },
    focalPx: () => F_TRUE,
    axisSigns: () => signs,
    tiltCalibrated: () => tiltCalibrated,
    frameSizePx: () => resolveVisionFrameSizePx(CFG),
    gain: () => 0.3,
    readOnly: () => false,
    gateRadiusPx: () => 120,
    minConf: () => 0.25,
    now: () => now,
    frameMaxAgeMs: () => 3000,
    log: (o) => { outcomes.push(o); },
  });

  for (let step = 0; step < 200; step++) {
    now = step * 200;
    const B = boresightAt(now);
    postures.record(now, B.panDeg, B.tiltDeg);
    targetHistory.record(now, aimPan(), aimTilt());
    if (now >= 2000 && now % 1000 === 0) {
      await corrector.tick();
      const Bn = boresightAt(now);
      errs.push({ pan: TRUE_PAN - Bn.panDeg, tilt: TRUE_TILT - Bn.tiltDeg });
    }
  }
  return { offset, applied, outcomes, errs, BIAS_PAN, BIAS_TILT };
}

describe("AUDIT 2: production-measured signs drive a converging loop, every mounting", () => {
  for (const m of ALL_MOUNTS) {
    it(`${m.label}: tool-measured signs converge on BOTH axes and point the right way`, async () => {
      const { body, freshRuntime, persisted } = await calibrateThroughTheRealTool(m);

      // The tool measured the mounting I built, without being told it.
      expect(body.focal_px / F_TRUE).toBeGreaterThan(0.95);
      expect(body.focal_px / F_TRUE).toBeLessThan(1.05);
      expect(body.pan_sign).toBe(m.kx);
      expect(body.tilt_sign).toBe(m.ky);
      expect(body.tilt_calibrated).toBe(true);
      expect(persisted.panSign).toBe(m.kx);
      expect(persisted.tiltSign).toBe(m.ky);
      // ...and survived the restart path.
      expect(freshRuntime.axisSigns()).toEqual({ pan: m.kx, tilt: m.ky });
      expect(freshRuntime.tiltCalibrated()).toBe(true);

      const r = await runClosedLoop(m, freshRuntime.axisSigns(), freshRuntime.tiltCalibrated());
      expect(r.outcomes.filter((o) => o === "applied").length).toBeGreaterThan(5);
      // DIRECTION: the first correction must point TOWARD the target. The
      // standing pointing error at the first tick is +BIAS on both axes.
      expect(Math.sign(r.applied[0].panDeg)).toBe(1);
      expect(Math.sign(r.applied[0].tiltDeg)).toBe(1);
      // ...and monotonically shrinking, never growing.
      for (let i = 1; i < r.errs.length; i++) {
        expect(Math.abs(r.errs[i].pan)).toBeLessThanOrEqual(Math.abs(r.errs[i - 1].pan) + 1e-9);
        expect(Math.abs(r.errs[i].tilt)).toBeLessThanOrEqual(Math.abs(r.errs[i - 1].tilt) + 1e-9);
      }
      // Converged: offset equals the bias, boresight lands on the target.
      expect(r.offset.panDeg).toBeCloseTo(r.BIAS_PAN, 1);
      expect(r.offset.tiltDeg).toBeCloseTo(r.BIAS_TILT, 1);
      const last = r.errs[r.errs.length - 1];
      expect(Math.abs(last.pan)).toBeLessThan(0.1);
      expect(Math.abs(last.tilt)).toBeLessThan(0.1);
    }, 40000);
  }
});

// ==========================================================================
// PART 3 -- prediction/correction agreement (C2's mechanism). If
// angularErrorToPixel used the opposite convention to pixelToAngularError,
// the gate would reject the true detection. Proven by asserting the gate
// NEVER rejects across the whole run above, on every mounting.
// ==========================================================================
describe("AUDIT 3: the gate never rejects the true detection (C2)", () => {
  for (const m of ALL_MOUNTS) {
    it(`${m.label}: no none_near_prediction across the run`, async () => {
      const r = await runClosedLoop(m, { pan: m.kx, tilt: m.ky }, true);
      expect(r.outcomes).not.toContain("none_near_prediction");
      expect(r.outcomes).not.toContain("no_candidates");
      expect(r.outcomes.filter((o) => o === "applied").length).toBeGreaterThan(5);
    }, 20000);
  }
  it("DISAGREEING limbs (prediction sign flipped) DO get gate-rejected — proves the gate is sensitive", async () => {
    const r = await runClosedLoop(
      NORMAL, { pan: NORMAL.kx, tilt: NORMAL.ky }, true,
      { pan: (-NORMAL.kx) as 1 | -1, tilt: (-NORMAL.ky) as 1 | -1 }, 4.0, 3.5,
    );
    expect(r.outcomes).toContain("none_near_prediction");
    expect(r.outcomes.filter((o) => o === "applied").length).toBe(0);
  }, 20000);

  it("PRINTS the first-correction direction and the convergence trace", async () => {
    const r = await runClosedLoop(NORMAL, { pan: NORMAL.kx, tilt: NORMAL.ky }, true);
    console.log("first applied correction:", r.applied[0]);
    console.log("pointing error head:", r.errs.slice(0, 5));
    console.log("pointing error tail:", r.errs.slice(-2), "final offset:", r.offset);
  }, 20000);
});

// ==========================================================================
// PART 4 -- round-trip: pixelToAngularError o (my projection) == truth
// ==========================================================================
describe("AUDIT 4: pixelToAngularError recovers the true angular error", () => {
  for (const m of ALL_MOUNTS) {
    it(`${m.label}: recovers (dPan, dTilt) exactly with the measured signs`, () => {
      const boresightTilt = 35;
      for (const dPan of [-3, -0.5, 0.5, 4]) {
        for (const dTilt of [-2.5, -0.25, 0.25, 3]) {
          const p = project(m, 100 + dPan, boresightTilt + dTilt, 100, boresightTilt);
          const e = pixelToAngularError(p, F_TRUE, boresightTilt, { pan: m.kx, tilt: m.ky });
          expect(e.panDeg).toBeCloseTo(dPan, 6);
          expect(e.tiltDeg).toBeCloseTo(dTilt, 6);
        }
      }
    });
  }
});

// ==========================================================================
// PART 5 -- NEW PROBLEM PROBE: Fix 3 zeroes the tilt CORRECTION when tilt is
// uncalibrated, but VisionRuntime.axisSigns() still hands the PREDICTION limb
// a GUESSED tilt sign (nominal +1), which is backwards on the real normal
// mount. The predicted dy then sits on the wrong side of centre by
// 2*f*tan(boresight tilt lag). Whenever the rig lags the ADS-B aim in tilt by
// more than ~1.9deg the gate rejects the TRUE detection -- and the pan
// correction, which Fix 3 deliberately kept alive, is lost with it.
// ==========================================================================
describe("AUDIT 5: an uncalibrated tilt sign still poisons the PREDICTION limb", () => {
  const CFG = { cameraSource: "v4l2", cameraV4l2Size: `${W}x${H}` } as unknown as Config;
  // tiltCalibrated defaults to true (pre-MEDIUM-2 behaviour: trust
  // whatever axisSigns().tilt says, including a guessed nominal default);
  // false exercises the fix -- buildPredictPixel zeroes the predicted dyPx
  // instead of guessing.
  function gateOnce(lagDeg: number, tiltSignGuess: 1 | -1, tiltCalibrated = true) {
    const postures = new PostureHistory(), targetHistory = new PostureHistory();
    const boresight = { panDeg: 100, tiltDeg: 30 };
    const aim = { panDeg: 100, tiltDeg: 30 + lagDeg };     // rig lags the aim in tilt
    for (let t = 0; t <= 4000; t += 200) {
      postures.record(t, boresight.panDeg, boresight.tiltDeg);
      targetHistory.record(t, aim.panDeg, aim.tiltDeg);
    }
    const session = { status: () => ({ state: "tracking", targetAgeMs: 200 }) } as unknown as TrackingSession;
    const predict = buildPredictPixel(
      session, targetHistory, postures, () => F_TRUE, 2000,
      () => ({ pan: NORMAL.kx, tilt: tiltSignGuess }),
      () => tiltCalibrated,
    );
    const predicted = predict(2000)!;
    // The TRUE detection: the aircraft really is where the aim says.
    const truth = project(NORMAL, aim.panDeg, aim.tiltDeg, boresight.panDeg, boresight.tiltDeg);
    return gateDetections([{ ...truth, conf: 0.9 }], predicted, 120, 0.25);
  }

  it("the MEASURED tilt sign keeps the true detection inside the gate at a 3deg lag", () => {
    expect(gateOnce(3, NORMAL.ky)).toHaveProperty("accepted");
  });

  it("the GUESSED nominal tilt sign (what an uncalibrated axis WOULD yield without MEDIUM-2) REJECTS it", () => {
    // tiltCalibrated=true here on purpose: this pins the MECHANISM (a
    // concrete wrong guess poisons the gate) as a permanent regression
    // marker, independent of whether the fix is in place -- if this ever
    // stops failing, pixelToAngularError/angularErrorToPixel's sign
    // handling broke in a different way.
    expect(gateOnce(3, 1, true)).toEqual({ rejected: "none_near_prediction" });
  });

  // -----------------------------------------------------------------------
  // MEDIUM-2 (round 3 of independent review): the fix itself. tiltCalibrated
  // =false makes buildPredictPixel predict dyPx=0 instead of trusting the
  // guessed nominal sign passed above (tiltSignGuess=1 is deliberately
  // still the WRONG one for this mounting -- the whole point is that it
  // must no longer matter once tiltCalibrated is false).
  // -----------------------------------------------------------------------
  it("MEDIUM-2 fix: tiltCalibrated=false zeroes the prediction instead of guessing, and the gate ACCEPTS at the same 3deg lag", () => {
    expect(gateOnce(3, 1, false)).toHaveProperty("accepted");
  });

  it("MEDIUM-2 fix: still accepts even with the sign argument set to the CORRECT value — tiltCalibrated overrides it either way", () => {
    expect(gateOnce(3, NORMAL.ky, false)).toHaveProperty("accepted");
  });

  it("MEDIUM-2 fix is bounded, not magic: a large enough lag still exceeds the gate on dx-only distance, honestly", () => {
    // Zeroing removes the WRONG-SIGN doubling but the true vertical
    // displacement is still real; past some lag the gate radius alone
    // cannot cover it even with a perfect (zero) prediction. This is
    // failing closed on real information, not a guess -- documented so a
    // future reader does not mistake this test's own failure for a
    // regression if the gate radius or FOV ever change.
    expect(gateOnce(10, 1, false)).toEqual({ rejected: "none_near_prediction" });
  });

  it("...and is fine below the threshold, which is why it is a lurking condition, not a constant failure", () => {
    expect(gateOnce(1, 1)).toHaveProperty("accepted");
  });
});
