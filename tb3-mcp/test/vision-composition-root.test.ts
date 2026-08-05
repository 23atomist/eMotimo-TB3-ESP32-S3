// NP-1 (round 4 of independent review): pins the COMPOSITION ROOT itself --
// src/server.ts's main(), the only place VisionCorrector's axisSigns/
// tiltCalibrated Deps and buildPredictPixel's axisSigns/tiltCalibrated
// arguments are actually wired to VisionRuntime. Every other vision test
// either hand-assembles a CorrectorDeps object (vision-corrector.test.ts) or
// calls registerVisionTools directly (vision-sign-audit.test.ts) -- neither
// exercises main()'s own wiring EXPRESSIONS, so both of these compiled and
// passed the full 1371-test suite before this file existed:
//   axisSigns: () => ({ pan: 1, tilt: 1 }),         // reinstates C2
//   tiltCalibrated: () => true,                     // reinstates MEDIUM-2's corrector half
//
// This drives the REAL main(), unmodified (main() now returns a handle --
// device/session/visionRuntime plus close() -- purely for this kind of
// test, in-repo precedent: dashboard/server.ts's own main()). Pre-seeds
// CalibrationStore (geo calibration, so start_tracking works without a live
// sighting sequence) and VisionScaleStore (deliberately non-nominal mounts,
// so a hardcoded-nominal mutation is observably wrong) by writing to the
// exact files main() itself will load at boot -- nothing here calls
// calibrate_vision_scale or start()/tick() directly.
//
// buildPredictPixel's OWN tiltCalibrated argument (MEDIUM-2's prediction
// half) is deliberately NOT independently re-verified here via a live
// physical lag. I tried: the mechanism needs a REAL posture-vs-target tilt
// lag (a standing detector bias alone can't produce one -- Fix 3 zeroes the
// tilt CORRECTION unconditionally once tilt is unmeasured, so
// offset.tiltDeg, and therefore posture.tiltDeg, never drifts on its own).
// A real lag IS achievable through the public start_tracking/update_target
// tools (a genuine physical slew after a retarget), but the window where
// correct and mutated wiring diverge OBSERVABLY is narrow: derived
// algebraically and confirmed by direct measurement against this file's
// own F≈1844, 120px gate -- below ~1.9deg of real lag the gate accepts
// regardless of the mutation (the true offset fits inside the gate radius
// either way); above ~3.7deg the gate REJECTS regardless of the mutation
// too (the true detector-reported offset alone exceeds the gate radius,
// independent of any prediction). Landing a live geo-tracking transient
// reliably inside that ~1.9-3.7deg band, across MockTb3's own slew-timing
// variance, proved flaky even at HEAD in testing -- a flaky test is worse
// than none.
//
// Instead, that specific call site is pinned two other ways: (1) at the
// pure-function level by vision-sign-audit.test.ts's AUDIT 5, which
// controls the lag angle directly rather than through a live slew, and
// (2) at THIS composition root, without any physics at all, by
// vision-predictpixel-wiring.test.ts -- it spies on the real
// buildPredictPixel (vi.mock + importOriginal, calling straight through so
// behaviour is unchanged) and asserts main() passes it a tiltCalibrated
// argument that is present and tracks visionRuntime.tiltCalibrated() live
// (toggled via setScale() mid-test), catching both an omitted argument and
// a hardcoded constant. Between the two, the server.ts call site is fully
// covered; only a live end-to-end reproduction of the gate-rejection
// SYMPTOM remains unattempted, and deliberately so.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockTb3 } from "./mock-tb3.js";
import { main, type MainHandle } from "../src/server.js";
import { CalibrationStore } from "../src/calibration.js";
import { VisionScaleStore } from "../src/vision-scale-store.js";
import { focalPxFromFov } from "../src/vision/geometry.js";

const RAD = Math.PI / 180;
const W = 1920, H = 1080;
const F = focalPxFromFov(W, 55);
const STEPS_PER_DEG = 444.444;
const RIG = { lat: 45, lon: 10, height: 0 };
const TARGET = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Mount { panPhysical: 1 | -1; tiltPhysical: 1 | -1 }
// Deliberately NOT the nominal {1,1} a hardcoded-nominal mutation would
// silently substitute -- both axes must be measured correctly for this
// scenario's assertions to hold.
const MIRRORED: Mount = { panPhysical: -1, tiltPhysical: 1 };
// tiltPhysical=-1 differs from nominal's +1 (unlike MIRRORED's tiltPhysical
// above, which happens to COINCIDE with nominal -- a coincidence of how the
// nominal default was originally chosen, see vision-corrector.test.ts's own
// note on this).
const NORMAL: Mount = { panPhysical: 1, tiltPhysical: -1 };

function project(
  m: Mount, targetPan: number, targetTilt: number, boresightPan: number, boresightTilt: number,
): { dxPx: number; dyPx: number } {
  const dPan = targetPan - boresightPan;
  const dTilt = targetTilt - boresightTilt;
  const c = Math.cos(boresightTilt * RAD);
  return {
    dxPx: m.panPhysical * F * Math.tan(dPan * c * RAD),
    dyPx: m.tiltPhysical * F * Math.tan(dTilt * RAD),
  };
}

const DEV_PORT = 8850, MCP_PORT = 8851, STREAM_PORT = 8852, DETECT_PORT = 8853;
const ENV_KEYS = [
  "TB3_CONFIG", "TB3_DEVICE_HOST", "TB3_MCP_PORT", "TB3_DASHBOARD_PORT",
  "TB3_CAMERA_SOURCE", "TB3_CAMERA_V4L2_SIZE", "TB3_VISION_DETECTOR_URL", "TB3_VISION_TICK_HZ",
  "TB3_CALIBRATION_FILE", "TB3_SECTOR_FILE", "TB3_LIMITS_FILE", "TB3_VISION_SCALE_FILE",
  "TB3_VISION_ENABLED", "TB3_ADSB_ENABLED",
];
const savedEnv: Record<string, string | undefined> = {};

let mock: MockTb3 | null = null;
let handle: MainHandle | null = null;
let streamServer: Server | null = null;
let detectServer: Server | null = null;

afterEach(async () => {
  handle?.close(); handle = null;
  await new Promise<void>((r) => (streamServer ? streamServer.close(() => r()) : r())); streamServer = null;
  await new Promise<void>((r) => (detectServer ? detectServer.close(() => r()) : r())); detectServer = null;
  if (mock) { await mock.stop(); mock = null; }
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

// Serves a continuously-updating (if content-irrelevant) MJPEG stream --
// buildVisionFrameSource's v4l2 relay path just needs a fresh frame to keep
// frame_stale from firing; the fake detector below is what makes the SIGN
// WIRING observable, not the stream's own bytes.
function serveCameraStream(): Promise<void> {
  return new Promise((resolve) => {
    streamServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
      const write = () => {
        if (res.writableEnded) return;
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write("\r\n");
      };
      write();
      const iv = setInterval(write, 100);
      res.on("close", () => clearInterval(iv));
    });
    streamServer.listen(STREAM_PORT, "127.0.0.1", () => resolve());
  });
}

// Computes dx/dy LIVE from the REAL device telemetry (posture) and the
// REAL tracking session's own geo-computed aim (target) -- both read
// through main()'s own returned handle, never precomputed. TRUE_PAN/TILT
// is the target's real aim plus a deliberate, fixed BIAS -- the standing
// pointing error vision-lock exists to correct, expressed the same way
// vision-sign-audit.test.ts's AUDIT 2/5 do.
function serveDetector(mount: Mount, deviceRef: { current: MainHandle["device"] | null },
  sessionRef: { current: MainHandle["session"] | null }, biasPanDeg: number, biasTiltDeg: number,
): Promise<void> {
  return new Promise((resolve) => {
    detectServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const st = deviceRef.current!.getState();
        const boresightPan = st.panSteps / STEPS_PER_DEG;
        const boresightTilt = st.tiltSteps / STEPS_PER_DEG;
        const s = sessionRef.current!.status();
        const aimPan = s.targetPanDeg ?? boresightPan;
        const aimTilt = s.targetTiltDeg ?? boresightTilt;
        const p = project(mount, aimPan + biasPanDeg, aimTilt + biasTiltDeg, boresightPan, boresightTilt);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          detections: [{ dxPx: p.dxPx, dyPx: p.dyPx, conf: 0.9 }], widthPx: W, heightPx: H, inferMs: 1,
        }));
      });
    });
    detectServer.listen(DETECT_PORT, "127.0.0.1", () => resolve());
  });
}

async function driveMain(mount: Mount, opts: { seedTiltSign: boolean; biasPanDeg: number; biasTiltDeg: number }) {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  mock = new MockTb3(); await mock.start(DEV_PORT);
  mock.setPosition(0, 0);

  const dir = mkdtempSync(join(tmpdir(), "tb3-comproot-"));
  const calFile = join(dir, "calibration.json");
  const preCal = new CalibrationStore(calFile);
  preCal.load();
  preCal.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  preCal.setOrientation(IDENTITY as never, new Date(0).toISOString());

  const scaleFile = join(dir, "vision-scale.json");
  const preScale = new VisionScaleStore(scaleFile);
  preScale.load();
  preScale.set({
    focalPx: F, latencyMs: 0,
    panSign: mount.panPhysical,
    ...(opts.seedTiltSign ? { tiltSign: mount.tiltPhysical } : {}),
  });

  process.env.TB3_CONFIG = "";
  process.env.TB3_DEVICE_HOST = `127.0.0.1:${DEV_PORT}`;
  process.env.TB3_MCP_PORT = String(MCP_PORT);
  process.env.TB3_DASHBOARD_PORT = String(STREAM_PORT);
  process.env.TB3_CAMERA_SOURCE = "v4l2";
  process.env.TB3_CAMERA_V4L2_SIZE = `${W}x${H}`;
  process.env.TB3_VISION_DETECTOR_URL = `http://127.0.0.1:${DETECT_PORT}/detect`;
  process.env.TB3_VISION_TICK_HZ = "10";
  process.env.TB3_CALIBRATION_FILE = calFile;
  process.env.TB3_SECTOR_FILE = join(dir, "sector.json");
  process.env.TB3_LIMITS_FILE = join(dir, "limits.json");
  process.env.TB3_VISION_SCALE_FILE = scaleFile;
  process.env.TB3_VISION_ENABLED = "false";
  process.env.TB3_ADSB_ENABLED = "false";

  const deviceRef: { current: MainHandle["device"] | null } = { current: null };
  const sessionRef: { current: MainHandle["session"] | null } = { current: null };
  await serveCameraStream();
  await serveDetector(mount, deviceRef, sessionRef, opts.biasPanDeg, opts.biasTiltDeg);

  handle = await main();
  deviceRef.current = handle.device;
  sessionRef.current = handle.session;

  const t0 = Date.now();
  while (!handle.device.getState().connected && Date.now() - t0 < 3000) await sleep(25);
  expect(handle.device.getState().connected).toBe(true);

  const client = new Client({ name: "comproot-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`));
  await client.connect(transport);

  const enableRes: any = await client.callTool({
    name: "set_vision_enabled", arguments: { enabled: true, readOnly: false },
  });
  expect(enableRes.isError ?? false).toBe(false);

  const startRes: any = await client.callTool({
    name: "start_tracking", arguments: { lat: TARGET.lat, lon: TARGET.lon, height_m: TARGET.height },
  });
  expect(startRes.isError ?? false).toBe(false);

  const t1 = Date.now();
  while (handle.session.status().state !== "tracking" && Date.now() - t1 < 8000) await sleep(50);
  expect(handle.session.status().state).toBe("tracking");

  // Real vision ticks at TB3_VISION_TICK_HZ=10 -- the first several land
  // no_posture (PostureHistory needs at least two REAL telemetry samples
  // spanning the frame's exposureMs, which takes a little real wall-clock
  // time to accumulate after tracking starts), so this polls for the
  // offset to actually move rather than sleeping a fixed guess.
  const t2 = Date.now();
  while (handle.session.getOffset().panDeg === 0 && Date.now() - t2 < 10000) await sleep(100);
  // A few more ticks once it starts moving, so the assertions see a
  // settled-enough value rather than the very first partial correction.
  await sleep(800);

  const offset = handle.session.getOffset();
  await transport.close();
  return { offset };
}

describe("composition root (main()) — VisionCorrector/buildPredictPixel wiring (NP-1)", () => {
  it("a MIRRORED mount (both axes measured, non-nominal) moves the offset in the sign-correct direction", async () => {
    const BIAS_PAN = 2.0, BIAS_TILT = 1.5;
    const { offset } = await driveMain(MIRRORED, {
      seedTiltSign: true, biasPanDeg: BIAS_PAN, biasTiltDeg: BIAS_TILT,
    });
    // Correctly wired (measured axisSigns, not nominal), the offset must
    // move TOWARD the injected bias on both axes -- a hardcoded-nominal
    // corrector would move the WRONG way on this mount (panPhysical=-1
    // differs from nominal's +1), landing offset.panDeg on the wrong side
    // of zero.
    expect(offset.panDeg).toBeGreaterThan(0.3);
    expect(offset.tiltDeg).toBeGreaterThan(0.3);
  }, 30000);

  it("tilt genuinely unmeasured: pan correction survives (Fix 3's corrector-side zeroing, through main())", async () => {
    // NORMAL mount, tilt unseeded: axisSigns().tilt defaults to nominal
    // (+1), which is WRONG for this mounting (tiltPhysical=-1) -- if
    // VisionCorrector's OWN tiltCalibrated Dep were hardcoded true instead
    // of reading visionRuntime.tiltCalibrated(), the corrector would apply
    // a backwards tilt correction and offset.tiltDeg would run to
    // nudgeOffset's clamp (see the mutation-verification notes in the
    // report). Correctly wired, it stays exactly zero while pan keeps
    // converging on its own, independent bias.
    const BIAS_PAN = 2.0, BIAS_TILT = 3.0;
    const { offset } = await driveMain(NORMAL, {
      seedTiltSign: false, biasPanDeg: BIAS_PAN, biasTiltDeg: BIAS_TILT,
    });
    expect(offset.panDeg).toBeGreaterThan(0.3);
    expect(offset.tiltDeg).toBe(0);
  }, 30000);
});
