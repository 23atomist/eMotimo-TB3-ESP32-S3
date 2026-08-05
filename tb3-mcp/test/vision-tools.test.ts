import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, Server } from "node:http";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { loadConfig } from "../src/config.js";
import { recordPostureSample, recordTargetSample, buildVisionFrameSource, visionRtspPullArgs } from "../src/server.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { DeviceState } from "../src/types.js";
import { Device } from "../src/device.js";
import { DetectorClient } from "../src/vision/detector-client.js";
import { FrameSource, StampedFrame } from "../src/vision/frame-source.js";
import { DetectResponse } from "../src/vision/detector-client.js";
import {
  SizeGuardedDetector, resolveVisionFrameSizePx, parseSizeSpec, VisionRuntime, buildPredictPixel,
  registerVisionTools,
} from "../src/vision-tools.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { VisionScaleStore } from "../src/vision-scale-store.js";
import { pixelToAngularError, focalPxFromFov } from "../src/vision/geometry.js";

const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

const STEPS_PER_DEG = 444.444;

function bareDeviceState(over: Partial<DeviceState> = {}): DeviceState {
  return {
    connected: true, panSteps: 0, tiltSteps: 0, auxSteps: 0,
    moving: false, programEngaged: false, batteryV: 0, staIp: "", lastUpdateMs: 0,
    ...over,
  };
}

// -----------------------------------------------------------------------
// Config defaults (requirement 3: OFF and read-only by default).
//
// The plan's own example test code passes an override object as loadConfig's
// FIRST argument (`loadConfig({ visionGain: 1.5 } as never, {})`), but that
// argument is a file PATH, not a config object: existsSync() on a non-string
// silently returns false (verified — it does not throw), so the object is
// discarded as "no such file" and every assertion in that shape is actually
// exercising bare defaults, not the override it claims to. A gain of 1.5
// would never reach ConfigSchema.parse() that way, so the "rejects a gain
// above 1" case would not actually throw under that literal code. Using the
// established env-var convention (every other test in this suite loads
// config this way — see test/limits-tools.test.ts, test/adsb-tools.test.ts,
// etc.) instead, which is how loadConfig's overrides genuinely reach the
// schema.
// -----------------------------------------------------------------------
describe("vision config", () => {
  it("is OFF by default and read-only by default", () => {
    const c = loadConfig(undefined, {});
    expect(c.visionEnabled).toBe(false);
    expect(c.visionReadOnly).toBe(true);
  });

  it("defaults gain to 0.3 and tick to 1Hz", () => {
    const c = loadConfig(undefined, {});
    expect(c.visionGain).toBe(0.3);
    expect(c.visionTickHz).toBe(1);
  });

  it("rejects a gain above 1 — that would not converge", () => {
    expect(() => loadConfig(undefined, { TB3_VISION_GAIN: "1.5" })).toThrow();
  });

  it("an existing config with no vision keys still loads", () => {
    const c = loadConfig(undefined, { TB3_DEVICE_HOST: "192.168.4.56" });
    expect(c.visionEnabled).toBe(false);
    expect(c.deviceHost).toBe("192.168.4.56");
  });

  it("TB3_VISION_ENABLED and TB3_VISION_READ_ONLY override the defaults", () => {
    const c = loadConfig(undefined, { TB3_VISION_ENABLED: "true", TB3_VISION_READ_ONLY: "false" });
    expect(c.visionEnabled).toBe(true);
    expect(c.visionReadOnly).toBe(false);
  });

  // Fix B (C3): frame staleness bound.
  it("defaults visionFrameMaxAgeMs to 3000 and TB3_VISION_FRAME_MAX_AGE_MS overrides it", () => {
    const c = loadConfig(undefined, {});
    expect(c.visionFrameMaxAgeMs).toBe(3000);
    const over = loadConfig(undefined, { TB3_VISION_FRAME_MAX_AGE_MS: "1500" });
    expect(over.visionFrameMaxAgeMs).toBe(1500);
  });
});

// -----------------------------------------------------------------------
// Requirement 1: posture must be recorded at the telemetry timestamp
// (dev.lastUpdateMs), not the moment we happened to poll for it.
// -----------------------------------------------------------------------
describe("recordPostureSample", () => {
  it("records at dev.lastUpdateMs, not the polling instant — retrievable at that past time", () => {
    const cfg = loadConfig(undefined, {});
    const postures = new PostureHistory();
    const pastMs = Date.now() - 5000; // well before "now"
    const dev = bareDeviceState({
      panSteps: 12 * STEPS_PER_DEG, tiltSteps: 3 * STEPS_PER_DEG, lastUpdateMs: pastMs,
    });

    recordPostureSample(postures, dev, cfg);

    const p = postures.postureAt(pastMs);
    // THE INVARIANT: if this had been recorded at Date.now() instead, the
    // single stored sample's timestamp would be ~"now" (test execution
    // time), and PostureHistory.postureAt() explicitly refuses a query
    // BEFORE its oldest sample — pastMs (5s earlier) would sit outside that
    // span and this would come back null instead. See task-8-report.md for
    // the mutation that was run to confirm this.
    expect(p).not.toBeNull();
    expect(p!.panDeg).toBeCloseTo(12, 5);
    expect(p!.tiltDeg).toBeCloseTo(3, 5);
  });

  it("applies panSign/tiltSign the same way TrackingSession.rigPanTilt() does", () => {
    const cfg = loadConfig(undefined, { TB3_PAN_SIGN: "-1", TB3_TILT_SIGN: "-1" });
    const postures = new PostureHistory();
    const t = Date.now() - 1000;
    const dev = bareDeviceState({ panSteps: 10 * STEPS_PER_DEG, tiltSteps: 4 * STEPS_PER_DEG, lastUpdateMs: t });

    recordPostureSample(postures, dev, cfg);

    const p = postures.postureAt(t);
    expect(p!.panDeg).toBeCloseTo(-10, 5);
    expect(p!.tiltDeg).toBeCloseTo(-4, 5);
  });

  it("does nothing when the device has never reported telemetry (lastUpdateMs === 0)", () => {
    const cfg = loadConfig(undefined, {});
    const postures = new PostureHistory();
    recordPostureSample(postures, bareDeviceState({ lastUpdateMs: 0 }), cfg);
    expect(postures.oldestMs()).toBeNull();
  });
});

// -----------------------------------------------------------------------
// Requirement 2: refuse rather than guess when the detector's reported
// inference-space size disagrees with what the frame source actually
// delivers.
// -----------------------------------------------------------------------
let server: Server | null = null;
function serve(body: object): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${a.port}/detect`);
    });
  });
}
afterEach(() => { server?.close(); server = null; });

describe("SizeGuardedDetector", () => {
  it("refuses a detector reporting 960x540 against a 1920x1080 source — no correction data returned", async () => {
    const url = await serve({
      detections: [{ dxPx: 50, dyPx: -20, conf: 0.9 }], widthPx: 960, heightPx: 540, inferMs: 4,
    });
    const mismatches: Record<string, unknown>[] = [];
    const guarded = new SizeGuardedDetector(new DetectorClient(url, 2000), {
      expectedSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
      onMismatch: (d) => mismatches.push(d),
    });

    const res = await guarded.detect("Zm9v", 0.25);

    expect(res).toBeNull();
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      detectorWidthPx: 960, detectorHeightPx: 540, expectedWidthPx: 1920, expectedHeightPx: 1080,
    });
  });

  it("passes the response through when the sizes agree", async () => {
    const url = await serve({
      detections: [{ dxPx: 50, dyPx: -20, conf: 0.9 }], widthPx: 1920, heightPx: 1080, inferMs: 4,
    });
    const guarded = new SizeGuardedDetector(new DetectorClient(url, 2000), {
      expectedSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
    });

    const res = await guarded.detect("Zm9v", 0.25);
    expect(res?.detections).toEqual([{ dxPx: 50, dyPx: -20, conf: 0.9 }]);
  });

  it("stays null (and does not call onMismatch) when the inner detector is genuinely unreachable", async () => {
    const mismatches: unknown[] = [];
    const guarded = new SizeGuardedDetector(new DetectorClient("http://127.0.0.1:1/detect", 200), {
      expectedSizePx: () => ({ widthPx: 1920, heightPx: 1080 }),
      onMismatch: (d) => mismatches.push(d),
    });
    const res = await guarded.detect("Zm9v", 0.25);
    expect(res).toBeNull();
    expect(mismatches).toHaveLength(0);
  });
});

describe("resolveVisionFrameSizePx", () => {
  // cameraV4l2Size and cameraMediamtxSize deliberately DIFFER in every test
  // below (fix round 6) -- config.ts's own comment says they are separate
  // on purpose, and a fixture where they happen to match could pass even if
  // resolveVisionFrameSizePx read the wrong one.
  it("reports cameraV4l2Size for cameraSource=v4l2, NOT cameraMediamtxSize", () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_V4L2_SIZE: "1280x720", TB3_CAMERA_MEDIAMTX_SIZE: "1920x1080",
    });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 1280, heightPx: 720 });
  });

  it("fails closed to the {0,0} sentinel for mtplvcap (no configured size)", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mtplvcap" });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 0, heightPx: 0 });
  });

  // Fix round 6 (operator correction): the rig's actual deployed
  // cameraSource is mediamtx, not v4l2 -- vision now pulls RTSP directly
  // (buildVisionFrameSource) and cameraMediamtxSize is the real,
  // load-bearing size that stream arrives at (rtsp.ts:54 commands the
  // SAME publish pipeline with -video_size cameraMediamtxSize). Was
  // previously the {0,0} sentinel; that assumption is now wrong and would
  // silently mis-scale every angle if reinstated.
  it("reports cameraMediamtxSize for cameraSource=mediamtx, NOT cameraV4l2Size", () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx", TB3_CAMERA_MEDIAMTX_SIZE: "1920x1080", TB3_CAMERA_V4L2_SIZE: "1280x720",
    });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 1920, heightPx: 1080 });
  });
});

describe("parseSizeSpec", () => {
  it("parses WxH", () => {
    expect(parseSizeSpec("1920x1080")).toEqual({ widthPx: 1920, heightPx: 1080 });
  });
  it("rejects a malformed spec", () => {
    expect(parseSizeSpec("not-a-size")).toBeNull();
    expect(parseSizeSpec("0x0")).toBeNull();
  });
});

// -----------------------------------------------------------------------
// VisionRuntime: seeded from config, mutable at runtime, never itself
// silently substitutes a guess for "no data yet".
// -----------------------------------------------------------------------
describe("VisionRuntime", () => {
  it("seeds enabled/readOnly from config", () => {
    const cfg = loadConfig(undefined, { TB3_VISION_ENABLED: "true", TB3_VISION_READ_ONLY: "false" });
    const rt = new VisionRuntime(cfg);
    expect(rt.isEnabled()).toBe(true);
    expect(rt.isReadOnly()).toBe(false);
  });

  it("setConfig mutates only the fields provided", () => {
    const cfg = loadConfig(undefined, {});
    const rt = new VisionRuntime(cfg);
    rt.setConfig({ enabled: true });
    expect(rt.isEnabled()).toBe(true);
    expect(rt.isReadOnly()).toBe(true); // untouched
  });

  it("detectorReachable is null before any tick, then tracks the last outcome", () => {
    const cfg = loadConfig(undefined, {});
    const rt = new VisionRuntime(cfg);
    expect(rt.status().detectorReachable).toBeNull();
    rt.recordOutcome("detector_unavailable", {});
    expect(rt.status().detectorReachable).toBe(false);
    rt.recordOutcome("applied", { panDeg: 1, tiltDeg: -1 });
    expect(rt.status().detectorReachable).toBe(true);
    expect(rt.status().lastCorrectionPanDeg).toBe(1);
    expect(rt.status().lastCorrectionTiltDeg).toBe(-1);
  });

  it("getScale/setScale/focalPx round-trip; focalPx is null before any calibration", () => {
    const cfg = loadConfig(undefined, {});
    const rt = new VisionRuntime(cfg);
    expect(rt.focalPx()).toBeNull();
    rt.setScale({ focalPx: 1234.5, latencyMs: 250 });
    expect(rt.focalPx()).toBeCloseTo(1234.5);
    expect(rt.getScale()).toEqual({ focalPx: 1234.5, latencyMs: 250 });
  });
});

// -----------------------------------------------------------------------
// buildPredictPixel: the inverse of geometry.ts's pixelToAngularError, fed
// by the TARGET'S POSITION AT EXPOSURE (interpolated from targetHistory,
// not read from session.status() "as of now") and the rig's posture AT
// EXPOSURE (postures, also interpolated). See buildPredictPixel's own doc
// for the fix-round-1 CRITICAL finding this replaced.
// -----------------------------------------------------------------------
const MAX_TARGET_AGE_MS = 5000;

function fakeSession(opts: {
  // Defaults to "tracking" -- the only state buildPredictPixel/
  // recordTargetSample may act on (fix round 3 / HIGH 1: NOT isActive(),
  // which is also true for "waiting" and "acquiring" -- see
  // track/session.ts:128 and buildPredictPixel's own doc).
  state?: "stopped" | "acquiring" | "tracking" | "waiting";
  targetAgeMs?: number | null;
  // Only read by the ORIGINAL (buggy) implementation this test suite is
  // pinning against — the fixed implementation never reads these fields.
  // Supplied anyway so the mutation described in the fix-round-1 review
  // ("mutate it back to session.status()") produces a concrete WRONG
  // number rather than a null, which is a strictly stronger regression pin.
  targetPanDeg?: number | null;
  targetTiltDeg?: number | null;
}): TrackingSession {
  const { state = "tracking", targetAgeMs = 0, targetPanDeg = null, targetTiltDeg = null } = opts;
  return {
    isActive: () => state !== "stopped",
    status: () => ({ state, targetAgeMs, targetPanDeg, targetTiltDeg }),
  } as unknown as TrackingSession;
}

describe("buildPredictPixel", () => {
  const F = focalPxFromFov(1920, 60);

  it("round-trips through pixelToAngularError's forward mapping", () => {
    const postures = new PostureHistory();
    postures.record(1000, 10, 20); // rig pointed at pan=10, tilt=20 at exposure
    const targetHistory = new PostureHistory();
    // Target sits 2deg further in pan, 1deg further in tilt, at the SAME
    // exposure instant.
    targetHistory.record(1000, 12, 21);
    const predict = buildPredictPixel(fakeSession({}), targetHistory, postures, () => F, MAX_TARGET_AGE_MS);

    const off = predict(1000);
    expect(off).not.toBeNull();
    const back = pixelToAngularError({ dxPx: off!.dxPx, dyPx: off!.dyPx }, F, 20);
    expect(back.panDeg).toBeCloseTo(2, 6);
    expect(back.tiltDeg).toBeCloseTo(1, 6);
  });

  // -------------------------------------------------------------------
  // CRITICAL regression (fix round 1): a moving target with an aged frame.
  // No fixture using a CONSTANT target value could ever distinguish
  // "read at exposure" from "read at now" — this one specifically cannot
  // pass by accident under the original epoch-mixing bug.
  // -------------------------------------------------------------------
  it("predicts the target's position AT EXPOSURE, not now, for a moving target", () => {
    const postures = new PostureHistory();
    postures.record(0, 0, 0);
    postures.record(10000, 0, 0); // rig stationary at pan=0, tilt=0 throughout

    // Target moving at 3 deg/s in pan (tilt flat), sampled every 100ms —
    // matches the real 10Hz recordTargetSample poll in server.ts.
    const targetHistory = new PostureHistory();
    for (let t = 0; t <= 10000; t += 100) targetHistory.record(t, 3 * (t / 1000), 0);

    // fakeSession's status() reports the "now" (t=10000) target position —
    // 30deg — which is exactly what the ORIGINAL buggy code would have used
    // instead of the exposure-time value.
    const session = fakeSession({ targetPanDeg: 30, targetTiltDeg: 0 });
    const predict = buildPredictPixel(session, targetHistory, postures, () => F, MAX_TARGET_AGE_MS);

    const exposureMs = 8500; // a 1.5s-old frame
    const off = predict(exposureMs);
    expect(off).not.toBeNull();
    const back = pixelToAngularError({ dxPx: off!.dxPx, dyPx: off!.dyPx }, F, 0);

    // CORRECT: the target's position AT EXPOSURE (t=8500) is 3*8.5 = 25.5deg.
    expect(back.panDeg).toBeCloseTo(3 * 8.5, 3);
    // WRONG (the bug this pins): the target's position "now" (t=10000) is
    // 30deg. If buildPredictPixel is mutated back to reading
    // session.status().targetPanDeg directly, this assertion fails because
    // back.panDeg becomes ~30.
    expect(back.panDeg).not.toBeCloseTo(30, 1);
  });

  it("returns null when there is no target history at the exposure time", () => {
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const targetHistory = new PostureHistory(); // empty
    const predict = buildPredictPixel(fakeSession({}), targetHistory, postures, () => F, MAX_TARGET_AGE_MS);
    expect(predict(1000)).toBeNull();
  });

  it("returns null when there is no posture at the exposure time", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(2000, 0, 0);
    const predict = buildPredictPixel(fakeSession({}), targetHistory, postures, () => F, MAX_TARGET_AGE_MS);
    expect(predict(1000)).toBeNull(); // 1000 is before the only recorded posture sample
  });

  it("returns null when no scale has been calibrated", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(fakeSession({}), targetHistory, postures, () => null, MAX_TARGET_AGE_MS);
    expect(predict(1000)).toBeNull();
  });

  // -------------------------------------------------------------------
  // IMPORTANT 5 (fix round 1): TrackingSession.status()'s lastStatus is
  // never cleared by stop()/wait(), so without these gates a prediction
  // could be built from an arbitrarily old, no-longer-tracked target.
  // -------------------------------------------------------------------
  it("refuses when the session has stopped, even if targetHistory still has recent data", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(
      fakeSession({ state: "stopped" }), targetHistory, postures, () => F, MAX_TARGET_AGE_MS,
    );
    expect(predict(1000)).toBeNull();
  });

  // -------------------------------------------------------------------
  // HIGH 1 (fix round 3): "waiting" is the state EVERY early return in
  // TrackingSession.tick() sets (not_calibrated, program_engaged,
  // telemetry_stale, target_stale) BEFORE recordAim() runs -- so
  // session.isActive() (state !== "stopped") is TRUE throughout a dropout,
  // even though lastStatus is frozen at its pre-dropout value. This is the
  // specific gap isActive() alone left open; gating on state === "tracking"
  // closes it.
  // -------------------------------------------------------------------
  it("refuses when the session is waiting (a dropout mid-track), which isActive() alone would have allowed", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const session = fakeSession({ state: "waiting" });
    expect(session.isActive()).toBe(true); // the old (insufficient) gate would have passed this
    const predict = buildPredictPixel(session, targetHistory, postures, () => F, MAX_TARGET_AGE_MS);
    expect(predict(1000)).toBeNull();
  });

  it("refuses when the target fix is older than maxTargetAgeMs", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(
      fakeSession({ targetAgeMs: MAX_TARGET_AGE_MS + 1 }), targetHistory, postures, () => F, MAX_TARGET_AGE_MS,
    );
    expect(predict(1000)).toBeNull();
  });

  it("refuses when targetAgeMs is null (no fix at all)", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(
      fakeSession({ targetAgeMs: null }), targetHistory, postures, () => F, MAX_TARGET_AGE_MS,
    );
    expect(predict(1000)).toBeNull();
  });
});

// -----------------------------------------------------------------------
// recordTargetSample: the write side of the fix-round-1 CRITICAL finding.
// -----------------------------------------------------------------------
describe("recordTargetSample", () => {
  it("records the target aim while state is tracking", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ state: "tracking", targetPanDeg: 12, targetTiltDeg: -3 });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.postureAt(1000)).toEqual({ panDeg: 12, tiltDeg: -3 });
  });

  it("does not record while stopped — a stale value must not gain a fresh timestamp", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ state: "stopped", targetPanDeg: 12, targetTiltDeg: -3 });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.oldestMs()).toBeNull();
  });

  // HIGH 1 (fix round 3): the actual bug. "waiting" is isActive()===true
  // (state !== "stopped"), so the OLD guard let this through — replaying
  // whatever target lastStatus was frozen at (here, a stale 12/-3 from
  // before a dropout) under a brand-new timestamp, for the whole dropout
  // window. The reviewer measured 8.4°/245px of prediction error from
  // exactly this. state === "tracking" is the only state in which
  // lastStatus was just written by THIS tick.
  it("does not record while waiting (mid-dropout) even though isActive() would allow it", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ state: "waiting", targetPanDeg: 12, targetTiltDeg: -3 });
    expect(session.isActive()).toBe(true);
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.oldestMs()).toBeNull();
  });

  it("does not record while acquiring", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ state: "acquiring", targetPanDeg: 12, targetTiltDeg: -3 });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.oldestMs()).toBeNull();
  });

  it("does not record when the target pan/tilt are null", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ state: "tracking", targetPanDeg: null, targetTiltDeg: null });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.oldestMs()).toBeNull();
  });
});

// -----------------------------------------------------------------------
// calibrate_vision_scale — MCP-tool-level tests (fix round 1, IMPORTANT 1
// and IMPORTANT 2). Full harness (MockTb3 + real Device + real
// TrackingSession) because the defect was specifically about ORDERING —
// preconditions vs. commanded motion — which a pure-function test of
// solveStepResponse etc. cannot exercise.
// -----------------------------------------------------------------------
const CALIB_PORT = 8804;
let calibMock: MockTb3 | null = null;
let calibDev: Device | null = null;

afterEach(async () => {
  calibDev?.close(); calibDev = null;
  if (calibMock) { await calibMock.stop(); calibMock = null; }
});

function fakeFrame(exposureMs: number): StampedFrame {
  return { jpegBase64: "Zm9v", exposureMs, arrivedMs: exposureMs };
}

// A detector that never yields a usable observation (empty detections every
// call) -- solveStepResponse then always sees < 2 observations and returns
// null, exactly the "step succeeded but calibration didn't resolve" case.
function nullResultDetector(): { detect: (jpeg: string, minConf: number) => Promise<DetectResponse | null> } {
  return { detect: async () => ({ detections: [], widthPx: 1280, heightPx: 720, inferMs: 1 }) };
}

// A detector that DOES report a detection (so the Fix 5 empty-baseline
// guard passes -- there IS a pre-step observation) but at a constant pixel
// position that never moves, even after the step -- so solveStepResponse
// still sees no settled displacement and refuses. Distinct from
// nullResultDetector, which is caught by the (earlier, cheaper) empty-
// baseline refusal before any motion is even commanded.
function stationaryDetector(): { detect: (jpeg: string, minConf: number) => Promise<DetectResponse | null> } {
  return { detect: async () => ({
    detections: [{ dxPx: 5, dyPx: 0, conf: 0.9 }], widthPx: 1280, heightPx: 720, inferMs: 1,
  }) };
}

async function calibHarness(
  envOver: Record<string, string> = {},
  frames?: FrameSource,
  givenDetector?: { detect: (jpeg: string, minConf: number) => Promise<DetectResponse | null> },
) {
  calibMock = new MockTb3(); await calibMock.start(CALIB_PORT);
  calibMock.setPosition(10 * STEPS_PER_DEG, 5 * STEPS_PER_DEG);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${CALIB_PORT}`, ...envOver });
  calibDev = new Device(cfg); calibDev.start();
  const t0 = Date.now();
  while (!calibDev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // Wait for an actual telemetry tick carrying the seeded position, not just
  // the WS handshake -- `connected` flips on 'open', which can race the
  // first 50ms tick, and this test relies on device.getState().panSteps
  // already reflecting setPosition() before calibrate_vision_scale reads it.
  while (Math.abs(calibDev.getState().panSteps - 10 * STEPS_PER_DEG) > 1 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const dir = mkdtempSync(join(tmpdir(), "tb3-vcal-"));
  const store = new CalibrationStore(join(dir, "calibration.json"));
  const limitsStore = new LimitsStore(join(dir, "limits.json"));
  limitsStore.load();
  const session = new TrackingSession(calibDev, cfg, store);
  const supervisor = new SunSupervisor(calibDev, cfg, store, session);
  const runtime = new VisionRuntime(cfg);
  const theFrames: FrameSource = frames ?? { latest: () => null, start() {}, stop() {} };
  const detector = givenDetector ?? nullResultDetector();
  const visionScaleFile = join(dir, "vision-scale.json");
  const scaleStore = new VisionScaleStore(visionScaleFile);
  scaleStore.load();

  const server = new McpServer({ name: "tb3-vision-calib", version: "test" });
  registerVisionTools(
    server, cfg, calibDev, session, supervisor, theFrames, detector, runtime, scaleStore,
    () => limitsStore.get(),
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, cfg, session, device: calibDev, mock: calibMock, scaleStore, runtime, visionScaleFile };
}

describe("calibrate_vision_scale — precondition ordering (IMPORTANT 1 / IMPORTANT 2)", () => {
  it("refuses while tracking is active, before commanding any motion", async () => {
    const { client, session, mock } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" });
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "calibrate_vision_scale", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    expect(mock!.lastGoto).toBeNull();
    session.stop();
  });

  it("refuses before commanding motion when vision has no configured frame size (default cameraSource)", async () => {
    // cameraSource defaults to "mtplvcap", which has no configured size --
    // resolveVisionFrameSizePx returns the {0,0} sentinel.
    const { client, mock } = await calibHarness();
    const res: any = await client.callTool({ name: "calibrate_vision_scale", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/frame size/i);
    expect(mock!.lastGoto).toBeNull();
  });

  it("refuses before commanding motion when the frame source has not delivered a frame yet", async () => {
    // cameraSource=v4l2 gives a real configured size, but frames.latest()
    // is still null (e.g. visionEnabled=false, the shipping default, so the
    // frame source was never started) -- this is the exact reachable state
    // the reviewer proved left the rig stepped with the camera blamed.
    const { client, mock } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" });
    const res: any = await client.callTool({ name: "calibrate_vision_scale", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no camera frame/i);
    expect(mock!.lastGoto).toBeNull();
  });

  it("restores the starting pan when the step succeeds but the scale never resolves", async () => {
    const frames: FrameSource = { latest: () => fakeFrame(Date.now()), start() {}, stop() {} };
    // stationaryDetector, not nullResultDetector: a non-empty baseline is
    // required to reach the "step succeeded, solve failed" path at all
    // under Fix 5's empty-baseline guard (nullResultDetector is caught
    // earlier, by that guard, before any motion is commanded -- covered by
    // its own dedicated test below).
    const { client, device, mock } = await calibHarness(
      { TB3_CAMERA_SOURCE: "v4l2" }, frames, stationaryDetector(),
    );

    const res: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 300 },
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/did not resolve/i);
    expect(textOf(res)).toMatch(/returned to its starting position/i);
    // The tool awaits both the step and the restore goto before returning,
    // so by the time callTool resolves the rig must be back where it
    // started (10deg pan) -- NOT left at the stepped 15deg (the bug the
    // reviewer proved: "the rig was left at the stepped position").
    expect(mock!.lastGoto?.pan_deg).toBeCloseTo(10, 1);
    const finalPanDeg = device.getState().panSteps / STEPS_PER_DEG;
    expect(finalPanDeg).toBeCloseTo(10, 1);
  });

  // Fix 5 (I1 reappearing via a different door): an empty pre-step baseline
  // must refuse BEFORE any motion, exactly like the other IMPORTANT-1
  // preconditions above -- not silently default to a frame-centre baseline
  // and produce a wrong (possibly inverted-sign) focalPx with no
  // diagnostic.
  it("refuses before commanding motion when the pre-step baseline has zero detections", async () => {
    const frames: FrameSource = { latest: () => fakeFrame(Date.now()), start() {}, stop() {} };
    const { client, mock } = await calibHarness(
      { TB3_CAMERA_SOURCE: "v4l2" }, frames, nullResultDetector(),
    );
    const res: any = await client.callTool({ name: "calibrate_vision_scale", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no pre-step baseline samples/i);
    expect(mock!.lastGoto).toBeNull();   // refused before any motion, like the other IMPORTANT-1 checks
  });
});

// -----------------------------------------------------------------------
// IMPORTANT 3 (fix round 2): the {0,0} fail-closed sentinel is right and
// stays -- these tests only cover DIAGNOSABILITY: it must be visible from
// the outside, and set_vision_enabled must refuse to turn vision on (with
// a message naming the real cause) rather than silently accept a config
// that leaves the loop structurally inert.
// -----------------------------------------------------------------------
describe("get_vision_status / set_vision_enabled — frame-size diagnosability (IMPORTANT 3)", () => {
  it("get_vision_status reports frame_size_px, including the {0,0} sentinel", async () => {
    // Default cameraSource ("mtplvcap") has no configured size.
    const { client } = await calibHarness();
    const res: any = await client.callTool({ name: "get_vision_status", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body.frame_size_px).toEqual({ widthPx: 0, heightPx: 0 });
  });

  it("get_vision_status reports a real frame_size_px for cameraSource=v4l2", async () => {
    const { client } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_V4L2_SIZE: "1280x720" });
    const res: any = await client.callTool({ name: "get_vision_status", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body.frame_size_px).toEqual({ widthPx: 1280, heightPx: 720 });
  });

  it("set_vision_enabled({enabled:true}) refuses when the cameraSource has no configured frame size", async () => {
    const { client, runtime } = await calibHarness(); // default cameraSource=mtplvcap
    const res: any = await client.callTool({ name: "set_vision_enabled", arguments: { enabled: true } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/frame size/i);
    expect(textOf(res)).toMatch(/mtplvcap/i);
    expect(runtime.isEnabled()).toBe(false); // refused -- must not have flipped on
  });

  it("set_vision_enabled({enabled:true}) succeeds when cameraSource=v4l2 has a real configured size", async () => {
    const { client, runtime } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" });
    const res: any = await client.callTool({ name: "set_vision_enabled", arguments: { enabled: true } });
    expect(res.isError).toBeFalsy();
    expect(runtime.isEnabled()).toBe(true);
  });

  it("set_vision_enabled({enabled:false}) is never blocked by the frame-size check", async () => {
    const { client, runtime } = await calibHarness(); // default cameraSource=mtplvcap
    const res: any = await client.callTool({ name: "set_vision_enabled", arguments: { enabled: false } });
    expect(res.isError).toBeFalsy();
    expect(runtime.isEnabled()).toBe(false);
  });
});

// -----------------------------------------------------------------------
// calibrate_vision_scale happy path + persistence (IMPORTANT 6 / spec miss),
// updated for fix round 4 (A1-A5): the tool now steps BOTH axes and takes a
// pre-step baseline on each, so a fake keyed off a raw call counter (the
// original approach) silently eats part of its own "unsettled calls" budget
// on the baseline poll and desyncs its synthetic clock from the real
// panStepAppliedAtMs = Date.now() the tool captures -- verified: it produces
// spurious negative latencies. makeLiveDeviceFakes reads the REAL MockTb3
// device position instead (through a ref, since the fakes must be built
// BEFORE calibHarness creates the Device), which is immune to both problems
// and naturally exercises pan AND tilt with one implementation.
// -----------------------------------------------------------------------
// Fix round 5 (independent re-review): the original version of this helper
// built dxPx/dyPx as +F*tan(deviceDisplacement) directly -- i.e. it
// asserted the code's OWN (buggy) convention rather than an independently
// derived physical relationship, and the "happy path" test below asserted
// pan_sign===1/tilt_sign===1 to match. A camera panning +Δ moves a FIXED
// target's angular offset from the boresight by -Δ (the target didn't
// move; the boresight did) -- so dx/dy must be built from the NEGATIVE of
// the device's own displacement: dx = -panPhysical*F*tan(Δpan*cos(tilt)),
// dy = -tiltPhysical*F*tan(Δtilt). panPhysical/tiltPhysical are the
// camera's true, independently-chosen handedness constants (default to
// NORMAL: panPhysical=+1, tiltPhysical=-1 -- see vision-corrector.test.ts's
// "MEASURED axisSign" describe block for the full derivation and its
// cross-check against vision-geometry.test.ts's app.py-convention tests).
function makeLiveDeviceFakes(opts: {
  deviceRef: { current: Device | null };
  startPanDeg: number; startTiltDeg: number; focalPx: number;
  panPhysical?: 1 | -1; tiltPhysical?: 1 | -1;
  // Extra delay (beyond the real, physical settle time MockTb3 itself takes)
  // before a position change becomes visible to the detector -- models the
  // detector/camera's own capture-to-answer lag.
  detectorLagMs?: number;
  // When provided, frame.exposureMs = arrivedMs - exposureLatencyMs(),
  // mirroring MjpegPipeSource's own live-latency read (frame-source.ts) --
  // this is what reproduces C4's circular dependency for the arrival-epoch
  // test below. Omitted (exposureMs === arrivedMs) everywhere else.
  exposureLatencyMs?: () => number;
}): { frames: FrameSource; detector: { detect: (jpeg: string, minConf: number) => Promise<DetectResponse | null> } } {
  const {
    deviceRef, startPanDeg, startTiltDeg, focalPx, panPhysical = 1, tiltPhysical = -1,
    detectorLagMs = 0, exposureLatencyMs,
  } = opts;
  const RADloc = Math.PI / 180;
  // panSign/tiltSign (the DEVICE'S OWN user-frame sign, cfg.panSign/
  // tiltSign) default to +1 in every test that uses this helper (none
  // override TB3_PAN_SIGN/TB3_TILT_SIGN) -- hardcoded rather than threaded
  // through a cfgRef for the same "doesn't exist yet" reason deviceRef is a
  // ref, to keep this helper's signature small. Not to be confused with
  // panPhysical/tiltPhysical above, which is the CAMERA's handedness.
  const history: { t: number; panDeg: number; tiltDeg: number }[] = [];
  const frames: FrameSource = {
    latest: () => {
      const now = Date.now();
      const st = deviceRef.current!.getState();
      history.push({ t: now, panDeg: st.panSteps / STEPS_PER_DEG, tiltDeg: st.tiltSteps / STEPS_PER_DEG });
      const lat = exposureLatencyMs ? exposureLatencyMs() : 0;
      return { jpegBase64: "Zm9v", arrivedMs: now, exposureMs: now - lat };
    },
    start() {}, stop() {},
  };
  const detector = {
    detect: async (): Promise<DetectResponse> => {
      const now = Date.now();
      const targetT = now - detectorLagMs;
      let rec = history[0] ?? { t: now, panDeg: startPanDeg, tiltDeg: startTiltDeg };
      for (const h of history) { if (h.t <= targetT) rec = h; else break; }
      const dPan = rec.panDeg - startPanDeg;
      const dTilt = rec.tiltDeg - startTiltDeg;
      const dxPx = -panPhysical * focalPx * Math.tan(dPan * Math.cos(rec.tiltDeg * RADloc) * RADloc);
      const dyPx = -tiltPhysical * focalPx * Math.tan(dTilt * RADloc);
      return { detections: [{ dxPx, dyPx, conf: 0.9 }], widthPx: 1280, heightPx: 720, inferMs: 1 };
    },
  };
  return { frames, detector };
}

describe("calibrate_vision_scale — happy path and persistence (IMPORTANT 6 / spec miss)", () => {
  it("recovers focalPx, measures BOTH axis signs, and persists all of it through VisionScaleStore", async () => {
    const F = focalPxFromFov(1920, 60);
    const deviceRef: { current: Device | null } = { current: null };
    const { frames, detector } = makeLiveDeviceFakes({
      deviceRef, startPanDeg: 10, startTiltDeg: 5, focalPx: F,
    });
    const { client, scaleStore, device } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" }, frames, detector);
    deviceRef.current = device;

    const res: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res));
    expect(body.focal_px).toBeCloseTo(F, -1);
    // makeLiveDeviceFakes's default mount is NORMAL (panPhysical=+1,
    // tiltPhysical=-1) -- the tool must MEASURE that back out through a
    // real device step + real solveStepResponse + the negation at the
    // storage boundary, not just echo a hardcoded default. tilt_sign=-1 is
    // the discriminating half: nominal would have said +1.
    expect(body.pan_sign).toBe(1);
    expect(body.tilt_sign).toBe(-1);
    expect(body.tilt_calibrated).toBe(true);

    // Persisted, not just held in memory (the spec miss this closes) --
    // including the measured signs (A4).
    const persisted = scaleStore.get();
    expect(persisted).not.toBeNull();
    expect(persisted!.focalPx).toBeCloseTo(F, -1);
    expect(persisted!.panSign).toBe(1);
    expect(persisted!.tiltSign).toBe(-1);
  }, 20000);

  it("a fresh VisionScaleStore pointed at the same file recovers the persisted scale AND signs (restart simulation)", async () => {
    const F = focalPxFromFov(1920, 60);
    const deviceRef: { current: Device | null } = { current: null };
    const { frames, detector } = makeLiveDeviceFakes({
      deviceRef, startPanDeg: 10, startTiltDeg: 5, focalPx: F,
    });
    const { client, visionScaleFile, device } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" }, frames, detector);
    deviceRef.current = device;
    const res: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });
    expect(res.isError).toBeFalsy();

    // A brand-new store instance over the SAME underlying file — exactly
    // what main() constructs on the next daemon boot (a fresh process has
    // no in-memory VisionRuntime/VisionScaleStore left over; only the file
    // survives). This is "the corrector picks it up at startup" without
    // needing to boot the whole daemon.
    const reloaded = new VisionScaleStore(visionScaleFile);
    reloaded.load();
    const got = reloaded.get();
    expect(got).not.toBeNull();
    expect(got!.focalPx).toBeCloseTo(F, -1);
    expect(got!.panSign).toBe(1);
    expect(got!.tiltSign).toBe(-1);
  }, 20000);

  // Fix round 5: prove the tool measures BOTH signs correctly, not just the
  // default mount -- a hardcoded pipeline would get exactly one of these
  // two tests right.
  it("measures a MIRRORED mount's signs correctly too", async () => {
    const F = focalPxFromFov(1920, 60);
    const deviceRef: { current: Device | null } = { current: null };
    const { frames, detector } = makeLiveDeviceFakes({
      deviceRef, startPanDeg: 10, startTiltDeg: 5, focalPx: F,
      panPhysical: -1, tiltPhysical: 1,
    });
    const { client, device } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" }, frames, detector);
    deviceRef.current = device;

    const res: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res));
    expect(body.focal_px).toBeCloseTo(F, -1);
    expect(body.pan_sign).toBe(-1);
    expect(body.tilt_sign).toBe(1);
  }, 20000);

  // Fix 3: previously tilt_calibrated only ever appeared in
  // calibrate_vision_scale's own one-time response -- after a restart
  // (which reloads the persisted scale via toVisionScale, not a fresh
  // calibration) there was no way to tell from the outside whether tilt
  // correction was actually live.
  it("get_vision_status surfaces tilt_calibrated independent of the calibrate response", async () => {
    const F = focalPxFromFov(1920, 60);
    const deviceRef: { current: Device | null } = { current: null };
    const { frames, detector } = makeLiveDeviceFakes({ deviceRef, startPanDeg: 10, startTiltDeg: 5, focalPx: F });
    const { client, device } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" }, frames, detector);
    deviceRef.current = device;

    const before: any = await client.callTool({ name: "get_vision_status", arguments: {} });
    expect(JSON.parse(textOf(before)).tilt_calibrated).toBe(false);

    const res: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });
    expect(res.isError).toBeFalsy();

    const after: any = await client.callTool({ name: "get_vision_status", arguments: {} });
    const body = JSON.parse(textOf(after));
    expect(body.tilt_calibrated).toBe(true);
    expect(body.pan_sign).toBe(1);
    expect(body.tilt_sign).toBe(-1);
  }, 20000);
});

// -----------------------------------------------------------------------
// C4 / arrival epoch (brief's test group 3). Reproduces the ORIGINAL bug's
// mechanism directly: frame.exposureMs is derived from the daemon's OWN
// live latencyMs estimate (mirroring frame-source.ts's MjpegPipeSource),
// so a SECOND calibration run, after the first has already set a non-zero
// latencyMs, sees its observations' exposureMs already shifted by that
// estimate. Building obs from arrivedMs (the fix) is immune to this because
// arrivedMs never depends on any latency estimate; building them from
// exposureMs (the bug) is not.
// -----------------------------------------------------------------------
describe("calibrate_vision_scale — arrival epoch, not exposure epoch (C4)", () => {
  it("a second consecutive calibration recovers the SAME latency, not a value collapsed toward 0", async () => {
    const F = focalPxFromFov(1920, 60);
    const INJECTED_LATENCY_MS = 350;   // the detector's own real capture-to-answer lag
    const deviceRef: { current: Device | null } = { current: null };
    // exposureLatencyMs reads the RUNTIME's currently-stored latency, same
    // as the real MjpegPipeSource wiring in server.ts -- this is what makes
    // the OLD (exposureMs-based) code's second run misbehave and the NEW
    // (arrivedMs-based) code's second run come out the same as the first.
    const latencyRef = { get: (): number => 0 };
    const { frames, detector } = makeLiveDeviceFakes({
      deviceRef, startPanDeg: 10, startTiltDeg: 5, focalPx: F,
      detectorLagMs: INJECTED_LATENCY_MS,
      exposureLatencyMs: () => latencyRef.get(),
    });
    const { client, runtime, device } = await calibHarness(
      { TB3_CAMERA_SOURCE: "v4l2" }, frames, detector,
    );
    deviceRef.current = device;
    latencyRef.get = () => runtime.getScale()?.latencyMs ?? 0;

    const res1: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });
    expect(res1.isError).toBeFalsy();
    const body1 = JSON.parse(textOf(res1));
    // Real MockTb3 settle time adds on top of the injected lag, so this is a
    // lower-bound/consistency check, not an exact peg -- the load-bearing
    // assertion is the SECOND run matching the first, not collapsing to 0.
    expect(body1.latency_ms).toBeGreaterThan(INJECTED_LATENCY_MS - 100);

    const res2: any = await client.callTool({
      name: "calibrate_vision_scale",
      arguments: { step_pan_deg: 5, sample_window_ms: 1500 },
    });
    expect(res2.isError).toBeFalsy();
    const body2: any = JSON.parse(textOf(res2));
    // THE REGRESSION PIN: under the old exposureMs-based code, run 2 would
    // read latency_new = latency_true - latency_old ~= 0. Assert it does not
    // collapse, and that it lands close to run 1's own value.
    expect(body2.latency_ms).toBeGreaterThan(INJECTED_LATENCY_MS - 100);
    expect(Math.abs(body2.latency_ms - body1.latency_ms)).toBeLessThan(150);
  }, 30000);
});

// -----------------------------------------------------------------------
// buildVisionFrameSource (IMPORTANT 4 + minor: auth header, retry+logging).
// The reviewer's own point: this is a fetch + a parser loop, not a
// subprocess -- exactly as testable as vision-detector-client.test.ts's
// DetectorClient, with a real node:http server standing in for the
// dashboard's /camera/stream.
// -----------------------------------------------------------------------
describe("buildVisionFrameSource", () => {
  let streamServer: Server | null = null;
  afterEach(() => { streamServer?.close(); streamServer = null; });

  function serveStream(handler: (req: any, res: any) => void): Promise<number> {
    return new Promise((resolve) => {
      streamServer = createServer(handler);
      streamServer.listen(0, "127.0.0.1", () => resolve((streamServer!.address() as { port: number }).port));
    });
  }

  it("sends Authorization: Bearer <mcpToken> when a token is configured", async () => {
    let seenAuth: string | undefined;
    let gotRequest = false;
    const port = await serveStream((req, res) => {
      gotRequest = true;
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "video/x-motion-jpeg" });
      res.end(Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]));
    });
    const cfg = loadConfig(undefined, { TB3_DASHBOARD_PORT: String(port), TB3_MCP_TOKEN: "sekret123" });
    const src = buildVisionFrameSource(cfg, () => 0, 50);
    src.start();
    const t0 = Date.now();
    while (!gotRequest && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    src.stop();
    expect(gotRequest).toBe(true);
    expect(seenAuth).toBe("Bearer sekret123");
  });

  it("sends no Authorization header when no mcpToken is configured", async () => {
    let seenAuth: string | undefined;
    let gotRequest = false;
    const port = await serveStream((req, res) => {
      gotRequest = true;
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "video/x-motion-jpeg" });
      res.end(Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]));
    });
    const cfg = loadConfig(undefined, { TB3_DASHBOARD_PORT: String(port) });
    const src = buildVisionFrameSource(cfg, () => 0, 50);
    src.start();
    const t0 = Date.now();
    while (!gotRequest && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    src.stop();
    expect(gotRequest).toBe(true);
    expect(seenAuth).toBeUndefined();
  });

  it("parses a streamed multipart response into a frame reachable via latest()", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const port = await serveStream((_req, res) => {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.end("\r\n");
    });
    const cfg = loadConfig(undefined, { TB3_DASHBOARD_PORT: String(port) });
    const src = buildVisionFrameSource(cfg, () => 0, 50);
    src.start();
    const t0 = Date.now();
    while (src.latest() === null && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    const frame = src.latest();
    src.stop();
    expect(frame).not.toBeNull();
    expect(Buffer.from(frame!.jpegBase64, "base64")).toEqual(jpeg);
  });

  it("logs the first connection failure immediately, then only every Nth retry (not every attempt)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Port 1 is a privileged/unused port nothing listens on in this test
      // environment -- fetch fails with a connection error every attempt.
      const cfg = loadConfig(undefined, { TB3_DASHBOARD_PORT: "1" });
      const src = buildVisionFrameSource(cfg, () => 0, 15);
      src.start();
      await new Promise((r) => setTimeout(r, 260)); // ~15-17 retries at 15ms apart
      src.stop();
      const visionLines = errSpy.mock.calls.filter((c) => String(c[0]).includes("[tb3-vision]"));
      // At least the unconditional first-failure line; strictly fewer lines
      // than attempts, proving the "every Nth" throttle is actually
      // suppressing most of them rather than logging every retry forever.
      expect(visionLines.length).toBeGreaterThanOrEqual(1);
      expect(visionLines.length).toBeLessThan(8);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------
// visionRtspPullArgs (fix round 6): flag-order pin, same convention as
// ffmpegV4l2Args/ffmpegRtspArgs -- input options must precede -i or ffmpeg
// silently ignores them.
// -----------------------------------------------------------------------
describe("visionRtspPullArgs — ordering and plumbing", () => {
  it("puts -rtsp_transport before -i", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    const a = visionRtspPullArgs(cfg);
    const i = a.indexOf("-i");
    expect(i).toBeGreaterThan(-1);
    expect(a.indexOf("-rtsp_transport")).toBeLessThan(i);
  });

  it("reads cameraMediamtxRtspUrl as the input", () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx", TB3_CAMERA_MEDIAMTX_RTSP_URL: "rtsp://127.0.0.1:8554/cam9",
    });
    const a = visionRtspPullArgs(cfg);
    expect(a[a.indexOf("-i") + 1]).toBe("rtsp://127.0.0.1:8554/cam9");
  });

  it("re-encodes to MJPEG on stdout (MediaMTX serves H.264, not MJPEG)", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    const a = visionRtspPullArgs(cfg);
    expect(a[a.indexOf("-c:v") + 1]).toBe("mjpeg");
    expect(a[a.indexOf("-f") + 1]).toBe("mjpeg");
    expect(a[a.length - 1]).toBe("pipe:1");
  });
});

// -----------------------------------------------------------------------
// buildVisionFrameSource — pipe selection by cameraSource, and the
// mediamtx RTSP-pull pipe's reconnect/logging + per-connection parser
// construction (fix round 6). The subprocess itself is injected
// (spawnChild), so none of this needs a real ffmpeg -- same rationale as
// the HTTP-relay tests above needing only a real node:http server.
// -----------------------------------------------------------------------
describe("buildVisionFrameSource — pipe selection and the mediamtx RTSP pull path", () => {
  // A minimal stand-in for node:child_process's ChildProcess: an
  // EventEmitter for process-level events ('exit', 'error'), plus a nested
  // EventEmitter for stdout ('data') -- the only two surfaces
  // spawnRtspPullPipe touches.
  class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    kill(_signal?: string): void { /* no-op -- not exercised by these tests */ }
  }

  function jpeg(tag: number): Buffer {
    // A minimal, PARSEABLE JPEG: SOI, one marker byte distinguishing frames, EOI.
    return Buffer.from([0xff, 0xd8, 0x00, tag, 0xff, 0xd9]);
  }

  it("v4l2 and mtplvcap use the HTTP relay path, NOT spawnChild", async () => {
    let spawnCalls = 0;
    const spawnChild = ((): never => { spawnCalls++; throw new Error("should not be called"); }) as any;
    for (const source of ["v4l2", "mtplvcap"]) {
      // Port 1: nothing listens, so the HTTP relay fails and retries --
      // the point here is only that spawnChild is never reached.
      const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: source, TB3_DASHBOARD_PORT: "1" });
      const src = buildVisionFrameSource(cfg, () => 0, 10000, spawnChild);
      src.start();
      await new Promise((r) => setTimeout(r, 30));
      src.stop();
    }
    expect(spawnCalls).toBe(0);
  });

  it("mediamtx selects the RTSP-pull path and spawns with visionRtspPullArgs", async () => {
    const seen: { bin: string; args: string[] }[] = [];
    const spawnChild = ((bin: string, args: string[]) => {
      seen.push({ bin, args });
      return new FakeChildProcess() as any;
    }) as any;
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", TB3_CAMERA_FFMPEG_BIN: "myffmpeg" });
    const src = buildVisionFrameSource(cfg, () => 0, 10000, spawnChild);
    src.start();
    await new Promise((r) => setTimeout(r, 10));
    src.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0].bin).toBe("myffmpeg");
    expect(seen[0].args).toEqual(visionRtspPullArgs(cfg));
  });

  it("parses a frame delivered on the fake child's stdout", async () => {
    let child: FakeChildProcess | null = null;
    const spawnChild = (() => { child = new FakeChildProcess(); return child as any; }) as any;
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    const src = buildVisionFrameSource(cfg, () => 0, 10000, spawnChild);
    src.start();
    await new Promise((r) => setTimeout(r, 5));
    child!.stdout.emit("data", jpeg(1));
    const frame = src.latest();
    src.stop();
    expect(frame).not.toBeNull();
    expect(Buffer.from(frame!.jpegBase64, "base64")).toEqual(jpeg(1));
  });

  it("reconnects on process exit, logging the first failure immediately then throttling", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let spawnCalls = 0;
      const spawnChild = (() => {
        spawnCalls++;
        const c = new FakeChildProcess();
        setTimeout(() => c.emit("exit", 1), 1); // dies immediately, every attempt
        return c as any;
      }) as any;
      const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
      const src = buildVisionFrameSource(cfg, () => 0, 10, spawnChild);
      src.start();
      await new Promise((r) => setTimeout(r, 150)); // several exit+retry cycles at 10ms apart
      src.stop();
      expect(spawnCalls).toBeGreaterThan(3); // it actually retried, more than once
      const visionLines = errSpy.mock.calls.filter((c) => String(c[0]).includes("mediamtx RTSP pull failed"));
      // At least the unconditional first-failure line; strictly fewer lines
      // than spawn attempts, proving the "every Nth" throttle suppresses
      // most of them rather than logging every retry forever.
      expect(visionLines.length).toBeGreaterThanOrEqual(1);
      expect(visionLines.length).toBeLessThan(spawnCalls);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("constructs a FRESH parser per connection: a partial frame left over from a dropped connection does not corrupt the next connection's real frame", async () => {
    const children: FakeChildProcess[] = [];
    const spawnChild = (() => {
      const c = new FakeChildProcess();
      children.push(c);
      return c as any;
    }) as any;
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    const src = buildVisionFrameSource(cfg, () => 0, 15, spawnChild);
    src.start();
    await new Promise((r) => setTimeout(r, 5));

    // Connection 1: an INCOMPLETE JPEG (SOI + a marker byte, no EOI), then
    // the process dies -- if the parser were reused, these leftover bytes
    // would prefix connection 2's stream and corrupt its first frame.
    children[0].stdout.emit("data", Buffer.from([0xff, 0xd8, 0x00, 0xaa]));
    children[0].emit("exit", 1);
    await new Promise((r) => setTimeout(r, 40)); // past the 15ms retry

    expect(children.length).toBeGreaterThanOrEqual(2);
    // Connection 2: a real, complete frame.
    children[1].stdout.emit("data", jpeg(2));
    const frame = src.latest();
    src.stop();
    expect(frame).not.toBeNull();
    expect(Buffer.from(frame!.jpegBase64, "base64")).toEqual(jpeg(2));
  });
});

// -----------------------------------------------------------------------
// VisionScaleStore (spec miss: calibrate_vision_scale must persist).
// Mirrors test/limits-store.test.ts's own shape.
// -----------------------------------------------------------------------
describe("VisionScaleStore", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "vscale-")), "vision-scale.json");

  it("defaults to null (not yet calibrated) when the file is missing", () => {
    const s = new VisionScaleStore(file());
    s.load();
    expect(s.get()).toBeNull();
  });

  it("persists and reloads a scale", () => {
    const f = file();
    const a = new VisionScaleStore(f);
    a.load();
    a.set({ focalPx: 1662.77, latencyMs: 355 });
    const b = new VisionScaleStore(f);
    b.load();
    expect(b.get()).toEqual({ focalPx: 1662.77, latencyMs: 355 });
  });

  // -----------------------------------------------------------------------
  // A4: panSign/tiltSign persistence. Optional on both the on-disk schema
  // and set()'s own validation -- a profile written before this field
  // existed must still parse.
  // -----------------------------------------------------------------------
  it("persists and reloads panSign/tiltSign alongside focalPx/latencyMs", () => {
    const f = file();
    const a = new VisionScaleStore(f);
    a.load();
    a.set({ focalPx: 1662.77, latencyMs: 355, panSign: -1, tiltSign: 1 });
    const b = new VisionScaleStore(f);
    b.load();
    expect(b.get()).toEqual({ focalPx: 1662.77, latencyMs: 355, panSign: -1, tiltSign: 1 });
  });

  it("a pre-existing file with no panSign/tiltSign still parses — absent, not defaulted, on read", () => {
    const f = file();
    // A profile written before A4 existed -- no panSign/tiltSign keys at all.
    writeFileSync(f, JSON.stringify({ version: 1, focalPx: 1000, latencyMs: 200 }));
    const s = new VisionScaleStore(f);
    s.load();
    // toEqual ignores undefined-valued keys, so this both proves the file
    // still loads AND that the store does not silently invent a default
    // here (see PersistedVisionScale's own doc on why that distinction
    // matters) -- callers (VisionRuntime.axisSigns / server.ts) are the ones
    // that default absent to nominal, not the store.
    expect(s.get()).toEqual({ focalPx: 1000, latencyMs: 200 });
    expect(s.get()!.panSign).toBeUndefined();
    expect(s.get()!.tiltSign).toBeUndefined();
  });

  it("rejects a panSign/tiltSign outside {-1, 1} on load, falling back to null", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ version: 1, focalPx: 1000, latencyMs: 200, panSign: 2, tiltSign: 1 }));
    const s = new VisionScaleStore(f);
    s.load();
    expect(s.get()).toBeNull();
  });

  it("set() rejects a panSign outside {-1, 1}", () => {
    const f = file();
    const s = new VisionScaleStore(f);
    s.load();
    expect(() => s.set({ focalPx: 1000, latencyMs: 200, panSign: 0 as never, tiltSign: 1 })).toThrow();
    expect(s.get()).toBeNull();
  });

  it("falls back to null on a corrupt file (never throws)", () => {
    const f = file();
    writeFileSync(f, "{ not json");
    const s = new VisionScaleStore(f);
    expect(() => s.load()).not.toThrow();
    expect(s.get()).toBeNull();
  });

  it("rejects a non-positive focalPx on load, falling back to null rather than trusting it", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ version: 1, focalPx: 0, latencyMs: 100 }));
    const s = new VisionScaleStore(f);
    s.load();
    expect(s.get()).toBeNull();
  });

  // Renamed in fix round 3: the reviewer found this test, as originally
  // named "rejects a non-finite focalPx on load", actually wrote focalPx:-5
  // -- a duplicate of the preceding non-positive case, not a test of
  // .finite() at all. Mutating .positive() and .finite() independently
  // confirmed it: removing .finite() alone produced 0 failures here.
  // JSON.parse cannot emit Infinity/NaN (JSON has no such literal --
  // JSON.parse("Infinity") throws, which load()'s catch-all already
  // handles), so .finite() is genuinely unreachable on the LOAD path; kept
  // in the schema anyway (defence in depth against a future loader that
  // parses more permissively), and now pinned for real on the WRITE path
  // instead -- see "set() rejects a non-finite focalPx" below.
  it("rejects a second non-positive focalPx variant on load (both violate .positive(), not .finite())", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ version: 1, focalPx: -5, latencyMs: 100 }));
    const s = new VisionScaleStore(f);
    s.load();
    expect(s.get()).toBeNull();
  });

  it("rejects a negative latencyMs on load", () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ version: 1, focalPx: 1000, latencyMs: -1 }));
    const s = new VisionScaleStore(f);
    s.load();
    expect(s.get()).toBeNull();
  });

  it("get() returns a copy, not the internal reference", () => {
    const s = new VisionScaleStore(file());
    s.load();
    s.set({ focalPx: 1000, latencyMs: 50 });
    const a = s.get();
    a!.focalPx = -999;
    expect(s.get()!.focalPx).not.toBe(-999);
  });

  it("writes atomically (tmp-then-rename): the target file never exists half-written", () => {
    const f = file();
    const s = new VisionScaleStore(f);
    s.load();
    s.set({ focalPx: 1234.5, latencyMs: 20 });
    expect(existsSync(f)).toBe(true);
    expect(existsSync(`${f}.tmp`)).toBe(false); // renamed away, not left behind
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ version: 1, focalPx: 1234.5, latencyMs: 20 });
  });

  // ---------------------------------------------------------------------
  // HIGH 2 (fix round 3): set() used to validate nothing. Verified
  // reachable: set({focalPx: -5, latencyMs: 100}) silently overwrote a
  // previously-good calibration in BOTH memory and the file, and the next
  // boot's load() returned null with no indication anything had been lost.
  // Not reachable from today's sole caller (calibrate_vision_scale only
  // ever passes solveStepResponse's own already-guarded result), but this
  // is shared public API, and set() now runs the same schema and refuses
  // BEFORE mutating this.scale.
  // ---------------------------------------------------------------------
  it("set() rejects a non-positive focalPx, leaving a prior good value untouched in memory and on disk", () => {
    const f = file();
    const s = new VisionScaleStore(f);
    s.load();
    s.set({ focalPx: 1662.77, latencyMs: 355 });

    expect(() => s.set({ focalPx: -5, latencyMs: 100 })).toThrow();

    expect(s.get()).toEqual({ focalPx: 1662.77, latencyMs: 355 });
    const reloaded = new VisionScaleStore(f);
    reloaded.load();
    expect(reloaded.get()).toEqual({ focalPx: 1662.77, latencyMs: 355 });
  });

  // Genuinely load-bearing (unlike the load-path .finite() case above):
  // Infinity is constructible directly in JS and reaches set() without ever
  // passing through JSON.parse, so this exercises .finite() for real.
  it("set() rejects a non-finite focalPx", () => {
    const f = file();
    const s = new VisionScaleStore(f);
    s.load();
    s.set({ focalPx: 1000, latencyMs: 50 });

    expect(() => s.set({ focalPx: Infinity, latencyMs: 100 })).toThrow();

    expect(s.get()).toEqual({ focalPx: 1000, latencyMs: 50 });
  });

  it("set() rejects a negative latencyMs, leaving the prior value untouched", () => {
    const f = file();
    const s = new VisionScaleStore(f);
    s.load();
    s.set({ focalPx: 1000, latencyMs: 50 });

    expect(() => s.set({ focalPx: 900, latencyMs: -1 })).toThrow();

    expect(s.get()).toEqual({ focalPx: 1000, latencyMs: 50 });
  });
});
