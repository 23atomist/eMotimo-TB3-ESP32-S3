// INDEPENDENT REVIEW AUDIT -- regression test for a failure path the
// implementer originally reasoned was not worth a dedicated test. It needs
// no MockTb3 hook at all: a Device-shaped stub is enough, and the branch
// already establishes the "cast a structural stub into a nominally-typed
// Dep" precedent (SizeGuardedDetector in server.ts).
//
// Scenario: moveToUserAngle throws AFTER device.gotoAngle() was ACCEPTED --
// i.e. waitForArrival times out (move.ts really can do this: a 5s+ arrival
// timeout on a stalled axis is a live path, not hypothetical). Before Fix
// 4, the tilt step's restoreStart() sat inside the try, so the catch
// swallowed the throw AND skipped the restore: the tool returned a
// degraded-but-successful result with the rig parked +5deg in tilt.
//
// MEDIUM-1 (round 3 of independent review): the SAME defect existed on the
// PAN step's own throw path, and Fix 4 only closed it for tilt -- pan's
// catch returned an error with no restore attempt at all. Both are covered
// here with one shared harness, parametrised by which waitForArrival call
// fails.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { Device } from "../src/device.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { VisionScaleStore } from "../src/vision-scale-store.js";
import { focalPxFromFov } from "../src/vision/geometry.js";
import { registerVisionTools, VisionRuntime } from "../src/vision-tools.js";
import type { FrameSource } from "../src/vision/frame-source.js";
import type { DetectResponse } from "../src/vision/detector-client.js";

const RAD = Math.PI / 180;
const W = 1920, H = 1080;
const F = focalPxFromFov(W, 55);
const SPD = 444.444;
const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

// failWaitNumber selects which chronological waitForArrival() call throws.
// The tool's own sequence: #1 pan step, #2 pan's own restoreStart() (called
// UNCONDITIONALLY after the pan attempt, success or throw), #3 tilt step,
// #4 tilt's own restoreStart() (finally block, Fix 4).
async function runStubbedCalibration(failWaitNumber: number) {
  const startPan = 12, startTilt = 25;
  const targetPan = startPan + 0.7, targetTilt = startTilt + 0.5;
  // NORMAL mount: dx = +f tan(dPan cos tilt), dy = -f tan(dTilt).
  let panDeg = startPan, tiltDeg = startTilt;
  const gotos: { pan: number; tilt: number }[] = [];
  let waits = 0;
  const stub = {
    getState: () => ({
      connected: true, panSteps: panDeg * SPD, tiltSteps: tiltDeg * SPD, auxSteps: 0,
      moving: false, programEngaged: false, batteryV: 12, staIp: "", lastUpdateMs: Date.now(),
    }),
    gotoAngle: async (p: number, t: number) => { gotos.push({ pan: p, tilt: t }); panDeg = p; tiltDeg = t; },
    waitForArrival: async () => {
      waits++;
      if (waits === failWaitNumber) throw new Error("timed out waiting for arrival");
      return { panSteps: panDeg * SPD, tiltSteps: tiltDeg * SPD };
    },
  } as unknown as Device;

  const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2" });
  const frames: FrameSource = {
    latest: () => ({ jpegBase64: "Zm9v", arrivedMs: Date.now(), exposureMs: Date.now() }),
    start() {}, stop() {},
  };
  const detector = {
    detect: async (): Promise<DetectResponse> => {
      const dPan = targetPan - panDeg, dTilt = targetTilt - tiltDeg;
      return {
        detections: [{
          dxPx: F * Math.tan(dPan * Math.cos(tiltDeg * RAD) * RAD),
          dyPx: -F * Math.tan(dTilt * RAD), conf: 0.9,
        }],
        widthPx: W, heightPx: H, inferMs: 1,
      };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "tb3-fix4-"));
  const calStore = new CalibrationStore(join(dir, "calibration.json"));
  const limits = new LimitsStore(join(dir, "limits.json")); limits.load();
  const session = new TrackingSession(stub, cfg, calStore);
  const supervisor = new SunSupervisor(stub, cfg, calStore, session);
  const runtime = new VisionRuntime(cfg);
  const scaleStore = new VisionScaleStore(join(dir, "vision-scale.json")); scaleStore.load();
  const server = new McpServer({ name: "fix4", version: "test" });
  registerVisionTools(server, cfg, stub, session, supervisor, frames, detector, runtime, scaleStore,
    () => limits.get());
  const client = new Client({ name: "fix4-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  const res: any = await client.callTool({
    name: "calibrate_vision_scale", arguments: { step_pan_deg: 5, sample_window_ms: 1000 },
  });
  return { res, body: () => JSON.parse(textOf(res)), gotos, panDeg: () => panDeg, tiltDeg: () => tiltDeg,
    startPan, startTilt };
}

describe("a step accepted then failing to arrive still restores the rig", () => {
  it("Fix 4 (tilt): the tilt step's own arrival timeout still restores the rig", async () => {
    // #1 pan step, #2 pan's own success (no restore attempted -- pan
    // succeeded), #3 tilt step throws.
    const { res, body, gotos, panDeg, tiltDeg, startPan, startTilt } = await runStubbedCalibration(3);
    expect(res.isError).toBeFalsy();
    const b = body();
    // The pan half still succeeded; tilt degraded to unmeasured (Fix 3).
    expect(b.pan_sign).toBe(1);
    expect(b.tilt_calibrated).toBe(false);
    expect(b.tilt_sign).toBeNull();
    // THE POINT: the last thing commanded is the restore to the start
    // pose, and the rig is not left sitting +5deg in tilt.
    expect(gotos[gotos.length - 1]).toEqual({ pan: startPan, tilt: startTilt });
    expect(tiltDeg()).toBeCloseTo(startTilt, 6);
    expect(panDeg()).toBeCloseTo(startPan, 6);
  }, 30000);

  // MEDIUM-1: Fix 4 only closed this for tilt. The pan step's own throw
  // path returned an error with NO restore attempt at all -- measured
  // (before this fix): the rig sits displaced with isError:true and a
  // message that says nothing about the rig having moved.
  it("MEDIUM-1 (pan): the pan step's own arrival timeout ALSO restores the rig, and says so", async () => {
    // #1 pan step itself throws; #2 is the restore attempt (must succeed).
    const { res, gotos, panDeg, tiltDeg, startPan, startTilt } = await runStubbedCalibration(1);
    expect(res.isError).toBe(true);
    const msg = textOf(res);
    expect(msg).toMatch(/step command failed/i);
    // Says whether the rig was restored, not silent about it.
    expect(msg).toMatch(/returned to its starting position/i);
    expect(gotos[gotos.length - 1]).toEqual({ pan: startPan, tilt: startTilt });
    expect(panDeg()).toBeCloseTo(startPan, 6);
    expect(tiltDeg()).toBeCloseTo(startTilt, 6);
  }, 30000);

  it("MEDIUM-1 (pan): if the restore attempt ALSO fails, the message says so honestly rather than claiming success", async () => {
    // #1 pan step throws; #2 (the restore attempt) ALSO throws.
    let waits = 0;
    const startPan = 12, startTilt = 25;
    let panDeg = startPan, tiltDeg = startTilt;
    const stub = {
      getState: () => ({
        connected: true, panSteps: panDeg * SPD, tiltSteps: tiltDeg * SPD, auxSteps: 0,
        moving: false, programEngaged: false, batteryV: 12, staIp: "", lastUpdateMs: Date.now(),
      }),
      gotoAngle: async (p: number, t: number) => { panDeg = p; tiltDeg = t; },
      waitForArrival: async () => {
        waits++;
        if (waits <= 2) throw new Error("timed out waiting for arrival");
        return { panSteps: panDeg * SPD, tiltSteps: tiltDeg * SPD };
      },
    } as unknown as Device;
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2" });
    const frames: FrameSource = {
      latest: () => ({ jpegBase64: "Zm9v", arrivedMs: Date.now(), exposureMs: Date.now() }),
      start() {}, stop() {},
    };
    // A non-empty (if unmoving) detection -- needed so Fix 5's empty-
    // baseline guard doesn't refuse before the pan step is even commanded;
    // this test is about the goto-throw path specifically, which happens
    // regardless of what the detector reports.
    const detector = { detect: async (): Promise<DetectResponse> => (
      { detections: [{ dxPx: 5, dyPx: 0, conf: 0.9 }], widthPx: W, heightPx: H, inferMs: 1 }
    ) };
    const dir = mkdtempSync(join(tmpdir(), "tb3-fix4b-"));
    const calStore = new CalibrationStore(join(dir, "calibration.json"));
    const limits = new LimitsStore(join(dir, "limits.json")); limits.load();
    const session = new TrackingSession(stub, cfg, calStore);
    const supervisor = new SunSupervisor(stub, cfg, calStore, session);
    const runtime = new VisionRuntime(cfg);
    const scaleStore = new VisionScaleStore(join(dir, "vision-scale.json")); scaleStore.load();
    const server = new McpServer({ name: "fix4b", version: "test" });
    registerVisionTools(server, cfg, stub, session, supervisor, frames, detector, runtime, scaleStore,
      () => limits.get());
    const client = new Client({ name: "fix4b-client", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);

    const res: any = await client.callTool({
      name: "calibrate_vision_scale", arguments: { step_pan_deg: 5, sample_window_ms: 1000 },
    });
    expect(res.isError).toBe(true);
    const msg = textOf(res);
    expect(msg).toMatch(/may NOT have been returned/i);
  }, 30000);
});
