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
//   - CorrectorDeps gained `axisSigns`, `now`, `frameMaxAgeMs` (this file's
//     own harness must supply all three).
//   - buildPredictPixel gained an `axisSigns` parameter so the prediction
//     limb agrees with the correction limb (A5) -- the ORIGINAL scratch
//     file's third test (yFlip=-1, app.py's real convention) only logged a
//     trace and asserted nothing, because under the pre-fix code the
//     prediction and correction limbs COULD NOT agree (predictPixel had no
//     way to know the camera's measured handedness) and the loop was
//     expected to misbehave. With the fix, both limbs are wired to the SAME
//     measured AxisSigns, so this file now asserts real convergence for
//     yFlip=-1 too.
import { describe, it, expect } from "vitest";
import { createServer, Server } from "node:http";
import { MjpegPipeSource, FramePipe } from "../src/vision/frame-source.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { VisionCorrector, CorrectorOutcome } from "../src/vision/corrector.js";
import { DetectorClient } from "../src/vision/detector-client.js";
import { SizeGuardedDetector, buildPredictPixel, resolveVisionFrameSizePx } from "../src/vision-tools.js";
import { focalPxFromFov, AxisSigns } from "../src/vision/geometry.js";
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

// yFlip = -1 is the physically real convention (app.py: image y is DOWN
// positive, so a target ABOVE the boresight has dyPx < 0). yFlip = +1 is the
// convention every OTHER test on this branch is written in. Fix A5: the
// MEASURED axisSigns (here, directly yFlip -- see this file's own doc) is
// threaded into BOTH the prediction limb (buildPredictPixel) and the
// correction limb (VisionCorrector's pixelToAngularError call), so the loop
// converges correctly regardless of which convention the camera actually
// uses -- proven by running this same loop under both.
async function runLoop(yFlip: 1 | -1, ticks: number, freezeAfterMs = Infinity) {
  const axisSigns: AxisSigns = { pan: 1, tilt: yFlip };
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
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { image_b64 } = JSON.parse(body);
      const te = Number(Buffer.from(image_b64, "base64").toString("utf8"));
      const P = postureAt(te);
      const dPan = truePan(te) - P.panDeg;
      const dTilt = trueTilt(te) - P.tiltDeg;
      const dxPx = F_TRUE * Math.tan(dPan * Math.cos(P.tiltDeg * RAD) * RAD);
      const dyPx = yFlip * F_TRUE * Math.tan(dTilt * RAD);
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

describe("END TO END closed loop (real modules)", () => {
  it("with the branch's OWN pixel-y convention (dy positive = target above)", async () => {
    const { trace, offset } = await runLoop(1, 25);
    if (process.env.VISION_E2E_TRACE) {
      console.log("\n--- yFlip=+1 (the convention every branch test is written in) ---");
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
    const { trace, offset, outcomes } = await runLoop(1, 25, 4000);
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

  it("with the REAL image convention from services/detector/app.py (y down-positive) — converges once both limbs agree (A5)", async () => {
    const { trace, offset } = await runLoop(-1, 25);
    if (process.env.VISION_E2E_TRACE) {
      console.log("\n--- yFlip=-1 (what app.py actually produces) ---");
      for (const l of trace) console.log(l);
      console.log("final offset:", offset);
    }
    // BEFORE A5, predictPixel had no way to know the camera's measured
    // handedness, so under yFlip=-1 the prediction and correction limbs
    // disagreed on the tilt axis and the gate rejected the true detection
    // every cycle -- this loop would never converge. With axisSigns threaded
    // into both limbs, it converges exactly like the yFlip=+1 case above.
    expect(offset.panDeg).toBeCloseTo(BIAS_PAN, 1);
    expect(offset.tiltDeg).toBeCloseTo(BIAS_TILT, 1);
  }, 60000);
});
