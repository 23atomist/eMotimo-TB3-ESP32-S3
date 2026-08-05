// Adopted from the whole-branch reviewer's scratch harness
// (.superpowers/sdd/2026-08-05-vision-lock/zz-e2e-loop.test.ts) per the
// critical-fixes-brief: "the highest-value artifact here", because it
// composes every REAL module -- MjpegPipeSource + PostureHistory x2 +
// buildPredictPixel + SizeGuardedDetector + DetectorClient (over real HTTP)
// + gateDetections + pixelToAngularError + VisionCorrector + nudgeOffset --
// and drives a genuine closed loop, which is exactly the seam no
// per-task/per-module review could see (C1, C2 and C3 were all found here).
//
// Adapted for fix round 4 (A1-A5, Fix B):
//   - CorrectorDeps gained `axisSigns`, `tiltCalibrated`, `now`,
//     `frameMaxAgeMs` (this file's own harness must supply all four).
//   - buildPredictPixel gained an `axisSigns` parameter so the prediction
//     limb agrees with the correction limb (A5).
//
// Adapted AGAIN for fix round 5 (independent re-review, missing negation):
// the round-4 version of this file hardcoded `axisSigns = {pan: 1, tilt:
// yFlip}` -- numerically the CORRECT post-negation answer, but asserted
// directly rather than measured, which is exactly the meta-flaw ("a fixture
// that states the sign cannot test the sign") that let the missing
// negation in vision-tools.ts survive fix round 4's own review. This
// version defines an INDEPENDENT physical projection (deliberately not
// vision-tools.ts's own convention), runs the REAL solveStepResponse
// against it to MEASURE axisSign the same way calibrate_vision_scale does,
// and negates it (axisSign is d(pixel)/d(command); AxisSigns as consumed
// by pixelToAngularError/angularErrorToPixel is d(command)/d(pixel
// offset) -- opposite in sign, since a pixel offset is target-minus-
// boresight and increasing the command DECREASES it). Run for two
// independent mountings (NORMAL and MIRRORED) and confirm both converge.
import { describe, it, expect } from "vitest";
import { createServer, Server } from "node:http";
import { MjpegPipeSource, FramePipe } from "../src/vision/frame-source.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { VisionCorrector, CorrectorOutcome } from "../src/vision/corrector.js";
import { DetectorClient } from "../src/vision/detector-client.js";
import { SizeGuardedDetector, buildPredictPixel, resolveVisionFrameSizePx } from "../src/vision-tools.js";
import { focalPxFromFov, AxisSigns } from "../src/vision/geometry.js";
import { solveStepResponse, StepObservation } from "../src/vision/scale-calibration.js";
import { nudgeOffset, AimOffset, ZERO_OFFSET } from "../src/track/offset.js";
import type { Config } from "../src/config.js";
import type { TrackingSession } from "../src/track/session.js";

const RAD = Math.PI / 180;
const W = 1920, H = 1080;
const F_TRUE = focalPxFromFov(W, 60);
const CAM_LATENCY_MS = 300;
const TARGET_RATE_DPS = 3;
const BIAS_PAN = 2.0, BIAS_TILT = 1.5;
const FRAME_MAX_AGE_MS = 3000;

const CFG = { cameraSource: "v4l2", cameraV4l2Size: "1920x1080" } as unknown as Config;

function truePan(t: number) { return 100 + TARGET_RATE_DPS * (t / 1000); }
function trueTilt(_t: number) { return 20; }
function adsbAimPan(t: number) { return truePan(t) - BIAS_PAN; }
function adsbAimTilt(t: number) { return trueTilt(t) - BIAS_TILT; }

// The camera's TRUE physical handedness, independent of anything
// vision-tools.ts or vision/geometry.ts assumes: dxPx = panPhysical * F *
// tan(targetPanDeg - boresightPanDeg), dyPx = tiltPhysical * F *
// tan(targetTiltDeg - boresightTiltDeg). NORMAL matches the brief's own
// stated physics (a camera panning +Δ sees a fixed object move LEFT) and
// app.py's documented y-down-positive convention (a target above the
// boresight has dyPx<0) -- independently re-derived, and cross-checked
// against vision-geometry.test.ts's "app.py convention" tests, which pin
// the SAME tiltPhysical=-1 from a different angle entirely (no pun
// intended). MIRRORED is both axes flipped, e.g. a reflected capture path.
interface Mounting { panPhysical: 1 | -1; tiltPhysical: 1 | -1 }
const NORMAL_MOUNT: Mounting = { panPhysical: 1, tiltPhysical: -1 };
const MIRRORED_MOUNT: Mounting = { panPhysical: -1, tiltPhysical: 1 };

// Measure axisSigns the SAME way calibrate_vision_scale does: command a
// step, observe the projection's response, run the REAL solveStepResponse,
// then negate at the boundary (vision-tools.ts's own fix -- see this
// file's module doc). NOT hardcoded from the mounting's physical constants
// directly, even though algebraically they turn out equal (correctionSign
// === physicalSign) -- going through the real measurement path is the
// whole point: it is what would have caught the missing negation.
function measureAxisSigns(mount: Mounting): AxisSigns {
  const stepDeg = 5;
  const panObs: StepObservation[] = [];
  const tiltObs: StepObservation[] = [];
  for (let t = 0; t <= 2000; t += 100) {
    const settled = t >= 400;
    // Boresight commanded +stepDeg; a FIXED target's angular offset from
    // the boresight therefore changes by -stepDeg (target-minus-boresight).
    const dx = mount.panPhysical * F_TRUE * Math.tan(((settled ? -stepDeg : 0) * Math.PI) / 180);
    const dy = mount.tiltPhysical * F_TRUE * Math.tan(((settled ? -stepDeg : 0) * Math.PI) / 180);
    panObs.push({ tMs: t, dxPx: dx, dyPx: 0 });
    tiltObs.push({ tMs: t, dxPx: 0, dyPx: dy });
  }
  const panR = solveStepResponse(panObs, 0, stepDeg, 0, "pan")!;
  const tiltR = solveStepResponse(tiltObs, 0, stepDeg, 0, "tilt")!;
  const axisSigns: AxisSigns = { pan: (-panR.axisSign) as 1 | -1, tilt: (-tiltR.axisSign) as 1 | -1 };
  // Sanity: the measured-and-negated correction sign must reproduce the
  // INDEPENDENTLY chosen physical constant -- this is the assertion that
  // would have caught fix round 4's missing negation (it hardcoded the
  // right answer directly; this derives it and checks it against the truth
  // it was built from).
  if (axisSigns.pan !== mount.panPhysical || axisSigns.tilt !== mount.tiltPhysical) {
    throw new Error(
      `measured-and-negated axisSigns ${JSON.stringify(axisSigns)} does not match the mounting's own ` +
      `physical constants ${JSON.stringify(mount)}`,
    );
  }
  return axisSigns;
}

async function runLoop(mount: Mounting, ticks: number, freezeAfterMs = Infinity) {
  const axisSigns = measureAxisSigns(mount);
  const offsetLog: { t: number; off: AimOffset }[] = [{ t: -1e9, off: ZERO_OFFSET }];
  const offsetAt = (t: number) => {
    let cur = ZERO_OFFSET;
    for (const e of offsetLog) if (e.t <= t) cur = e.off; else break;
    return cur;
  };
  const postureAt = (t: number) => {
    const o = offsetAt(t);
    return { panDeg: adsbAimPan(t) + o.panDeg, tiltDeg: adsbAimTilt(t) + o.tiltDeg };
  };

  // --- the detector sidecar, speaking app.py's wire format ---------------
  // Built from the SAME physical projection measureAxisSigns() measured
  // against -- dxPx/dyPx = mount.*Physical * F * tan(target - boresight).
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { image_b64 } = JSON.parse(body);
      const te = Number(Buffer.from(image_b64, "base64").toString("utf8"));
      const P = postureAt(te);
      const dPan = truePan(te) - P.panDeg;
      const dTilt = trueTilt(te) - P.tiltDeg;
      const dxPx = mount.panPhysical * F_TRUE * Math.tan(dPan * Math.cos(P.tiltDeg * RAD) * RAD);
      const dyPx = mount.tiltPhysical * F_TRUE * Math.tan(dTilt * RAD);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        detections: [{ dxPx, dyPx, conf: 0.9 }], widthPx: W, heightPx: H, inferMs: 3,
      }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;

  // --- real frame source over a fake pipe -------------------------------
  let now = 0;
  let pushFrame: ((b: Buffer) => void) | null = null;
  const pipe: FramePipe = { onFrame(cb) { pushFrame = cb; }, kill() {} };
  const frames = new MjpegPipeSource({
    spawnPipe: () => pipe, now: () => now, latencyMs: () => CAM_LATENCY_MS,
  });
  frames.start();

  const postures = new PostureHistory();
  const targetHistory = new PostureHistory();
  let offset: AimOffset = ZERO_OFFSET;

  const session = {
    status: () => ({ state: "tracking", targetAgeMs: 300 }),
  } as unknown as TrackingSession;

  const detector = new SizeGuardedDetector(
    new DetectorClient(`http://127.0.0.1:${port}/detect`, 2000),
    { expectedSizePx: () => resolveVisionFrameSizePx(CFG) },
  );

  const outcomes: CorrectorOutcome[] = [];
  const corrector = new VisionCorrector({
    frames,
    detector: detector as any,
    postures,
    predictPixel: buildPredictPixel(
      session, targetHistory, postures, () => F_TRUE, 2000, () => axisSigns,
    ),
    applyOffset: (p, t) => {
      const r = nudgeOffset(offset, p, t, 5);
      offset = { panDeg: r.panDeg, tiltDeg: r.tiltDeg };
      offsetLog.push({ t: now, off: offset });
    },
    focalPx: () => F_TRUE,
    axisSigns: () => axisSigns,
    tiltCalibrated: () => true,   // both axes were measured above
    frameSizePx: () => resolveVisionFrameSizePx(CFG),
    gain: () => 0.3,
    readOnly: () => false,
    gateRadiusPx: () => 120,
    minConf: () => 0.25,
    now: () => now,
    frameMaxAgeMs: () => FRAME_MAX_AGE_MS,
    log: (o) => { outcomes.push(o); },
  });

  const trace: string[] = [];
  // Warm both rings, then tick at 1Hz.
  for (let step = 0; step < ticks * 5 + 20; step++) {
    now = step * 200;                                  // 5Hz telemetry
    const P = postureAt(now);
    postures.record(now, P.panDeg, P.tiltDeg);
    targetHistory.record(now, adsbAimPan(now), adsbAimTilt(now));
    if (now >= 2000 && now % 1000 === 0) {
      if (now <= freezeAfterMs) pushFrame!(Buffer.from(String(now - CAM_LATENCY_MS)));
      await corrector.tick();
      const Pn = postureAt(now);
      trace.push(
        `t=${(now / 1000).toFixed(0)}s outcome=${outcomes[outcomes.length - 1]} ` +
        `offset=(${offset.panDeg.toFixed(3)}, ${offset.tiltDeg.toFixed(3)}) ` +
        `pointingErr=(${(truePan(now) - Pn.panDeg).toFixed(3)}, ${(trueTilt(now) - Pn.tiltDeg).toFixed(3)})`,
      );
    }
  }
  srv.close();
  return { trace, offset, outcomes };
}

describe("END TO END closed loop (real modules, MEASURED axisSigns)", () => {
  it("NORMAL mount: measured-and-negated signs converge to the standing bias", async () => {
    const { trace, offset } = await runLoop(NORMAL_MOUNT, 25);
    if (process.env.VISION_E2E_TRACE) {
      console.log("\n--- NORMAL_MOUNT ---");
      for (const l of trace) console.log(l);
    }
    expect(offset.panDeg).toBeCloseTo(BIAS_PAN, 1);
    expect(offset.tiltDeg).toBeCloseTo(BIAS_TILT, 1);
  }, 60000);

  it("MIRRORED mount: measured-and-negated signs ALSO converge — sign-independence, not luck", async () => {
    const { trace, offset } = await runLoop(MIRRORED_MOUNT, 25);
    if (process.env.VISION_E2E_TRACE) {
      console.log("\n--- MIRRORED_MOUNT ---");
      for (const l of trace) console.log(l);
    }
    expect(offset.panDeg).toBeCloseTo(BIAS_PAN, 1);
    expect(offset.tiltDeg).toBeCloseTo(BIAS_TILT, 1);
  }, 60000);

  // C3 (Fix B): before frame freshness/de-duplication, a frozen stream kept
  // re-serving the same StampedFrame, both limbs kept agreeing on the same
  // stale exposureMs, and the loop wound the offset all the way to
  // nudgeOffset's ±5deg clamp while every tick still logged "applied". With
  // Fix B, ticks after the freeze must contribute nothing: the offset must
  // stop changing at whatever it reached by the freeze point, and none of
  // the post-freeze outcomes may be "applied".
  it("FROZEN STREAM: the camera stops delivering after t=4s — Fix B stops the wind-up", async () => {
    const { trace, offset, outcomes } = await runLoop(NORMAL_MOUNT, 25, 4000);
    if (process.env.VISION_E2E_TRACE) {
      console.log("\n--- frame source freezes at t=4s (last frame keeps being reused) ---");
      for (const l of trace) console.log(l);
      console.log("final offset:", offset);
    }
    // Never the ±5deg clamp the pre-Fix-B wind-up drove it to.
    expect(Math.abs(offset.panDeg)).toBeLessThan(4.9);
    expect(Math.abs(offset.tiltDeg)).toBeLessThan(4.9);
    // Every outcome from the freeze point onward is a refusal, never applied
    // -- outcomes[] is 1:1 with the trace's tick lines (t=2s..26s), and the
    // freeze is at t=4s, i.e. tick index 2 onward (0-based: t=2s,3s,4s are
    // indices 0-2, t=5s is index 3, the first tick with a truly stale/
    // duplicate frame).
    const postFreezeOutcomes = outcomes.slice(3);
    expect(postFreezeOutcomes.length).toBeGreaterThan(0);
    for (const o of postFreezeOutcomes) expect(o).not.toBe("applied");
  }, 60000);
});
