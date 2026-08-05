import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { recordPostureSample } from "../src/server.js";
import { PostureHistory } from "../src/vision/posture-history.js";
import { DeviceState } from "../src/types.js";
import { DetectorClient } from "../src/vision/detector-client.js";
import {
  SizeGuardedDetector, resolveVisionFrameSizePx, parseSizeSpec, VisionRuntime, buildPredictPixel,
} from "../src/vision-tools.js";
import { TrackingSession } from "../src/track/session.js";
import { pixelToAngularError, focalPxFromFov } from "../src/vision/geometry.js";

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
// by the tracking session's current target prediction and the posture AT
// EXPOSURE (never "now").
// -----------------------------------------------------------------------
function fakeSession(targetPanDeg: number | null, targetTiltDeg: number | null): TrackingSession {
  return {
    status: () => ({ targetPanDeg, targetTiltDeg }),
  } as unknown as TrackingSession;
}

describe("buildPredictPixel", () => {
  const F = focalPxFromFov(1920, 60);

  it("round-trips through pixelToAngularError's forward mapping", () => {
    const postures = new PostureHistory();
    postures.record(1000, 10, 20); // rig pointed at pan=10, tilt=20 at exposure
    // Target sits 2deg further in pan, 1deg further in tilt.
    const session = fakeSession(12, 21);
    const predict = buildPredictPixel(session, postures, () => F);

    const off = predict(1000);
    expect(off).not.toBeNull();
    const back = pixelToAngularError({ dxPx: off!.dxPx, dyPx: off!.dyPx }, F, 20);
    expect(back.panDeg).toBeCloseTo(2, 6);
    expect(back.tiltDeg).toBeCloseTo(1, 6);
  });

  it("returns null when there is no target prediction", () => {
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(fakeSession(null, null), postures, () => F);
    expect(predict(1000)).toBeNull();
  });

  it("returns null when there is no posture at the exposure time", () => {
    const postures = new PostureHistory();
    postures.record(2000, 0, 0);
    const predict = buildPredictPixel(fakeSession(5, 5), postures, () => F);
    expect(predict(1000)).toBeNull(); // 1000 is before the only recorded sample
  });

  it("returns null when no scale has been calibrated", () => {
    const postures = new PostureHistory();
    postures.record(1000, 0, 0);
    const predict = buildPredictPixel(fakeSession(5, 5), postures, () => null);
    expect(predict(1000)).toBeNull();
  });
});
