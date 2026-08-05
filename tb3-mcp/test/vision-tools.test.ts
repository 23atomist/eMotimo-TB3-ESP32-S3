import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { loadConfig } from "../src/config.js";
import { recordPostureSample, recordTargetSample } from "../src/server.js";
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
  it("reports cameraV4l2Size for cameraSource=v4l2", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_V4L2_SIZE: "1280x720" });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 1280, heightPx: 720 });
  });

  it("fails closed to the {0,0} sentinel for mtplvcap (no configured size)", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mtplvcap" });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 0, heightPx: 0 });
  });

  it("fails closed to the {0,0} sentinel for mediamtx (its MJPEG relay size is untracked)", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(resolveVisionFrameSizePx(cfg)).toEqual({ widthPx: 0, heightPx: 0 });
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
  active?: boolean;
  targetAgeMs?: number | null;
  // Only read by the ORIGINAL (buggy) implementation this test suite is
  // pinning against — the fixed implementation never reads these fields.
  // Supplied anyway so the mutation described in the fix-round-1 review
  // ("mutate it back to session.status()") produces a concrete WRONG
  // number rather than a null, which is a strictly stronger regression pin.
  targetPanDeg?: number | null;
  targetTiltDeg?: number | null;
}): TrackingSession {
  const { active = true, targetAgeMs = 0, targetPanDeg = null, targetTiltDeg = null } = opts;
  return {
    isActive: () => active,
    status: () => ({ targetAgeMs, targetPanDeg, targetTiltDeg }),
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
  it("refuses when tracking is not active, even if targetHistory still has recent data", () => {
    const targetHistory = new PostureHistory();
    targetHistory.record(1000, 5, 5);
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(
      fakeSession({ active: false }), targetHistory, postures, () => F, MAX_TARGET_AGE_MS,
    );
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
  it("records the target aim while tracking is active", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ active: true, targetPanDeg: 12, targetTiltDeg: -3 });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.postureAt(1000)).toEqual({ panDeg: 12, tiltDeg: -3 });
  });

  it("does not record while tracking is inactive — a stale value must not gain a fresh timestamp", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ active: false, targetPanDeg: 12, targetTiltDeg: -3 });
    recordTargetSample(targetHistory, session, 1000);
    expect(targetHistory.oldestMs()).toBeNull();
  });

  it("does not record when the target pan/tilt are null", () => {
    const targetHistory = new PostureHistory();
    const session = fakeSession({ active: true, targetPanDeg: null, targetTiltDeg: null });
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

async function calibHarness(envOver: Record<string, string> = {}, frames?: FrameSource) {
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
  const detector = nullResultDetector();

  const server = new McpServer({ name: "tb3-vision-calib", version: "test" });
  registerVisionTools(server, cfg, calibDev, session, supervisor, theFrames, detector, runtime, () => limitsStore.get());
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, cfg, session, device: calibDev, mock: calibMock };
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
    const { client, device, mock } = await calibHarness({ TB3_CAMERA_SOURCE: "v4l2" }, frames);

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
});
