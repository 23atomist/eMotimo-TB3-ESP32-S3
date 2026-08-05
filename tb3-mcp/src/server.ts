import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { Device } from "./device.js";
import { DeviceState } from "./types.js";
import { stepsToDeg, applySign } from "./angles.js";
import { registerTools } from "./tools.js";
import { registerGeoTools } from "./geo-tools.js";
import { registerImuTools } from "./imu-tools.js";
import { registerTrackTools } from "./track-tools.js";
import { registerSunTools } from "./sun-tools.js";
import { CalibrationStore } from "./calibration.js";
import { TrackingSession, realScheduler } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { registerAdsbTools } from "./adsb-tools.js";
import { SectorStore } from "./sector-store.js";
import { registerSectorTools } from "./sector-tools.js";
import { LimitsStore } from "./limits-store.js";
import { registerLimitsTools } from "./limits-tools.js";
import { MediaMtxClient } from "./mediamtx/client.js";
import { CaptureController } from "./capture/controller.js";
import { takeSnapshot } from "./capture/snapshot.js";
import { assertCaptureFfmpegUsable } from "./capture/ffmpeg-preflight.js";
import { JpegFrameParser } from "./dashboard/camera/index.js";
import { FrameSource, FramePipe, MjpegPipeSource } from "./vision/frame-source.js";
import { PostureHistory } from "./vision/posture-history.js";
import { DetectorClient } from "./vision/detector-client.js";
import { VisionCorrector, CorrectorOutcome } from "./vision/corrector.js";
import {
  registerVisionTools, VisionRuntime, SizeGuardedDetector, resolveVisionFrameSizePx, buildPredictPixel,
} from "./vision-tools.js";

// Auto capture's deps are hard-wired to MediaMTX: an RTSP snapshot pull
// (capture/snapshot.ts), the /v3/config/paths/patch record valve, and the
// isArmed() path-ready check (all via MediaMtxClient above). On any host
// that hasn't opted into cameraSource="mediamtx" -- mtplvcap and v4l2 are
// both valid, non-mediamtx defaults -- none of that is running, so without
// this gate EVERY track lock fires a refused loopback fetch to
// cameraMediamtxControlUrl, logs a disarmed warning, and pins a permanent
// amber "Capture: skipped (disarmed)" chip: training the operator to
// ignore the one indicator meant to catch a REAL skip. The operator-visible
// knob (captureAutoEnabled, and the set_capture_mode MCP tool) still works
// on a mediamtx host; this only stops capture from silently doing loopback
// work where there is no MediaMTX capture pipeline to talk to. Exported for
// test/capture-autoenabled.test.ts.
export function resolveCaptureAutoEnabled(cfg: Config): boolean {
  return cfg.captureAutoEnabled && cfg.cameraSource === "mediamtx";
}

// Preflights captureFfmpegBin and, on failure, surfaces it into `capture`
// exactly the way a runtime capture failure would (see
// CaptureController.reportError) -- fail loudly, not fatally, matching item
// 1's dashboard fix. Fired-and-caught here rather than left to throw, since
// this is a config-only fault and must never crash the process that owns
// tracking and drives the rig.
//
// Gated on resolveCaptureAutoEnabled(cfg): on a host that hasn't opted into
// cameraSource="mediamtx", captureFfmpegBin is inert and irrelevant (capture
// itself is inert there too -- see item 4), so preflighting it unconditionally
// would pin a permanent "Capture: ERROR" for a config key nothing ever
// reads, on a host where NOTHING will ever succeed to clear it -- exactly
// the "permanent chip trains the operator to ignore it" failure item 4 was
// raised to kill, recreated in red. Exported for
// test/capture-ffmpeg-preflight.test.ts.
export async function checkCaptureConfig(cfg: Config, capture: CaptureController): Promise<void> {
  if (!resolveCaptureAutoEnabled(cfg)) return;
  try {
    await assertCaptureFfmpegUsable(cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[tb3-mcp] captureFfmpegBin preflight failed (capture will keep failing until fixed): ${msg}`);
    capture.reportError("snapshot", "startup preflight", e);
  }
}

// Feeds PostureHistory from the existing telemetry path: dev.lastUpdateMs is
// when the firmware's tick said the posture was true; the moment we happen
// to poll for it (Date.now()) is not. This project already paid for that
// exact substitution once, on a different data path, as a 1.91s pointing lag
// found on the roof on 2026-07-22 -- see
// test/vision-tools.test.ts's mutation test, which pins this against
// Date.now() specifically because of that history. Exported so it can be
// polled on a plain timer in main() without needing a live Device/WebSocket
// in tests (test/vision-tools.test.ts calls this directly against a bare
// DeviceState).
export function recordPostureSample(postures: PostureHistory, dev: DeviceState, cfg: Config): void {
  if (dev.lastUpdateMs === 0) return; // never connected -- no real posture yet
  postures.record(
    dev.lastUpdateMs,
    applySign(stepsToDeg(dev.panSteps), cfg.panSign),
    applySign(stepsToDeg(dev.tiltSteps), cfg.tiltSign),
  );
}

// How often to poll Device.getState() to feed PostureHistory. PostureHistory
// itself is sized "600 samples / 60s at the 10Hz telemetry rate" (see its
// module doc), so 10Hz here is what that capacity assumes -- record() is a
// cheap no-op on every poll that lands between two real firmware ticks (its
// `tMs <= newest.tMs` guard drops the duplicate), so oversampling costs
// nothing but a field read. Runs unconditionally (not gated on
// visionEnabled): the history is inert and near-free while nothing reads it,
// and keeping it warm means flipping set_vision_enabled on has useful
// history immediately instead of a 60s blind spot.
const POSTURE_POLL_MS = 100;

// Builds the vision loop's FrameSource by consuming the DASHBOARD's own
// /camera/stream MJPEG relay (a separate process, src/dashboard/server.ts)
// over HTTP, rather than spawning a second ffmpeg/mtplvcap process in this
// daemon. Deliberate: mtplvcapSpawner's own module doc notes "only ONE
// mtplvcap may hold the camera's USB/PTP session at a time" and its
// serialization guard is module-scoped, i.e. useless across two separate
// Node processes -- a second capture process spawned here would fight the
// dashboard's for the camera and wedge both. CameraStreamer's /camera/stream
// already supports multiple concurrent readers (`writers: Set<ServerResponse>`),
// so this just becomes one more viewer of a pipeline that's already running
// (or already retrying) on its own. JpegFrameParser (Task-independent,
// already used for both mtplvcap's multipart body and ffmpeg's bare stream)
// splits either shape identically, so this works unmodified for
// cameraSource="mtplvcap" and "v4l2". It does NOT work for "mediamtx": that
// path is WebRTC-only in the dashboard (MediaMtxPublisher has no attach()/
// MJPEG relay -- see dashboard/server.ts's CameraLike comment), so vision
// gets no frames there; frameSizePx() also returns the fail-closed {0,0}
// sentinel for that source (see vision-tools.ts), so nothing downstream can
// be fooled by frames that never arrive anyway.
//
// Not unit-tested, by the same convention as mtplvcapSpawner/
// ffmpegV4l2Spawner in dashboard/camera/*.ts ("NOT unit-tested: real
// subprocess + stdout relay; verified on-host") -- this is a real subprocess
// (the dashboard's) plus a real HTTP relay, one layer further removed.
export function buildVisionFrameSource(cfg: Config, latencyMs: () => number): FrameSource {
  const spawnPipe = (): FramePipe => {
    let stopped = false;
    let cb: ((jpeg: Buffer) => void) | null = null;
    const controller = new AbortController();
    const parser = new JpegFrameParser();
    const url = `http://127.0.0.1:${cfg.dashboardPort}/camera/stream`;

    const connect = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`camera stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) break;
          if (value) for (const frame of parser.push(Buffer.from(value))) cb?.(frame);
        }
      } catch {
        /* fall through to retry below -- dashboard not up yet, camera
           disarmed, or the stream dropped mid-read */
      }
      if (!stopped) setTimeout(() => { void connect(); }, 2000);
    };
    void connect();

    return {
      onFrame(fn) { cb = fn; },
      kill() { stopped = true; try { controller.abort(); } catch { /* noop */ } },
    };
  };

  return new MjpegPipeSource({ spawnPipe, now: () => Date.now(), latencyMs });
}

export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
  sectorStore: SectorStore, capture: CaptureController, limitsStore: LimitsStore,
  frames: FrameSource, detector: SizeGuardedDetector, visionRuntime: VisionRuntime,
): Express {
  const app = express();
  app.use(express.json());

  // Optional bearer-token gate.
  app.use("/mcp", (req: Request, res: Response, next) => {
    if (!cfg.mcpToken) return next();
    const auth = req.header("authorization") ?? "";
    if (auth === `Bearer ${cfg.mcpToken}`) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sid = req.header("mcp-session-id");
      let transport: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;

      if (!transport && !sid && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports[id] = transport!; },
        });
        transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
        const server = new McpServer({ name: "tb3-mcp", version: "0.1.0" });
        registerTools(server, device, cfg, session, supervisor, store, capture, limitsStore);
        registerGeoTools(server, device, cfg, store, session, supervisor, source, limitsStore);
        registerImuTools(server, device, cfg, store, supervisor, session, limitsStore);
        registerTrackTools(server, session, supervisor);
        registerSunTools(server, device, cfg, store, supervisor);
        registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore);
        registerSectorTools(server, sectorStore);
        registerLimitsTools(server, device, cfg, limitsStore);
        registerVisionTools(server, cfg, device, supervisor, frames, detector, visionRuntime, () => limitsStore.get());
        await server.connect(transport);
      }

      if (!transport) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session" }, id: null });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[tb3-mcp] error handling POST /mcp:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    }
  });

  const sessionStream = async (req: Request, res: Response) => {
    try {
      const sid = req.header("mcp-session-id");
      const transport = sid ? transports[sid] : undefined;
      if (!transport) { res.status(400).send("no valid session"); return; }
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error("[tb3-mcp] error handling GET/DELETE /mcp:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    }
  };
  app.get("/mcp", sessionStream);
  app.delete("/mcp", sessionStream);

  return app;
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");
  const device = new Device(cfg);
  device.start();
  const calibFile = cfg.calibrationFile ?? join(homedir(), ".tb3-mcp", "calibration.json");
  const store = new CalibrationStore(calibFile);
  store.load();
  console.error(`calibration file: ${calibFile} (calibrated: ${store.isCalibrated()})`);
  const sectorFile = cfg.sectorFile ?? join(homedir(), ".tb3-mcp", "sector.json");
  const sectorStore = new SectorStore(sectorFile);
  sectorStore.load();
  const limitsFile = cfg.limitsFile ?? join(homedir(), ".tb3-mcp", "limits.json");
  const limitsStore = new LimitsStore(limitsFile);
  limitsStore.load();
  console.error(`taught travel limits file: ${limitsFile} (taught: ${JSON.stringify(limitsStore.get())})`);
  const session = new TrackingSession(
    device, cfg, store, Date.now, realScheduler, () => sectorStore.get(), () => limitsStore.get(),
  );
  const supervisor = new SunSupervisor(device, cfg, store, session, Date.now, realScheduler, () => limitsStore.get());
  supervisor.start();
  const follower = new AdsbFollower(session, cfg.adsbAltSource, cfg.adsbLostSec * 1000);
  const source = new AdsbSource(cfg, { onSnapshot: (s) => follower.onSnapshot(s) });
  if (cfg.adsbEnabled) {
    source.start();
    console.log(`[tb3-mcp] ADS-B source polling ${cfg.adsbUrl} at ${cfg.adsbPollHz}Hz`);
  }

  // Singletons for the life of the process, built here alongside every other
  // domain object (session/supervisor/store/sectorStore/source/follower) and
  // passed into buildApp() rather than constructed inside it -- matches this
  // file's own DI convention and lets buildApp() be tested with a fake
  // CaptureController. buildApp() itself runs once at startup, but its
  // POST /mcp handler runs once per MCP session (re-initialize on every
  // client reconnect); building capture and wiring onStateChange here,
  // exactly once, keeps exactly one CaptureController and one listener
  // alive no matter how many MCP clients connect or reconnect. Wiring it
  // per-request would pile up a duplicate listener (and a duplicate
  // recording-valve/snapshot policy) on every reconnect, which is exactly
  // the kind of session-cascade bug this rig has hit before.
  const mtx = new MediaMtxClient({
    controlUrl: cfg.cameraMediamtxControlUrl,
    path: cfg.cameraMediamtxPath,
    timeoutMs: cfg.captureTimeoutMs,
  });
  const capture = new CaptureController({
    setRecord: (on) => mtx.setRecord(on),
    // `callsign` reaches here already resolved by CaptureController at the
    // moment the pass began (see onStateChange below and
    // CaptureController.beginPass) -- a pure pass-through, deliberately NOT
    // re-derived from `session` here. isArmed() below is a real network
    // round-trip the tracking tick runs many times over, and by the time a
    // deferred lookup ran, the session could have been retargeted to a
    // different aircraft entirely (autonomous-agent retask, operator
    // switching targets) -- silently dropping the correct callsign from the
    // filename. Resolving it synchronously at the transition instead closes
    // that race.
    snapshot: (icao, callsign) => takeSnapshot(cfg, icao, callsign, new Date().toISOString()),
    // The daemon does not own the camera; MediaMTX reporting the path ready
    // IS the armed signal, and it needs no dashboard round-trip.
    isArmed: async () => (await mtx.pathInfo())?.ready === true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  }, { debounceMs: cfg.captureDebounceMs, autoEnabled: resolveCaptureAutoEnabled(cfg) });
  // Fires synchronously on every transition, so `session.status().label` is
  // guaranteed to be the label for the SAME target `icao` names -- both were
  // set together by the same start() call, with no await in between.
  session.onStateChange((state, icao) => capture.onTrack(state, icao, session.status().label));

  await checkCaptureConfig(cfg, capture);

  // --- Vision-lock wiring (Task 8) --------------------------------------
  // PostureHistory feed: unconditional and cheap (see recordPostureSample's
  // doc) so the loop has warm history the instant an operator flips
  // set_vision_enabled, rather than a 60s blind spot.
  const postures = new PostureHistory();
  realScheduler.every(POSTURE_POLL_MS, () => recordPostureSample(postures, device.getState(), cfg));

  const visionRuntime = new VisionRuntime(cfg);
  // latencyMs is read fresh per frame (see MjpegPipeSource's own doc on
  // this) so a re-run of calibrate_vision_scale after a zoom change takes
  // effect on the very next frame, not just future pipe restarts. Defaults
  // to 0 (exposure == arrival) until the first successful calibration.
  const frames = buildVisionFrameSource(cfg, () => visionRuntime.getScale()?.latencyMs ?? 0);
  if (cfg.visionEnabled) frames.start(); // off by default -- see config.ts's visionEnabled doc

  const detector = new SizeGuardedDetector(
    new DetectorClient(cfg.visionDetectorUrl, cfg.visionDetectorTimeoutMs),
    {
      expectedSizePx: () => resolveVisionFrameSizePx(cfg),
      onMismatch: (detail) => console.error(
        `[tb3-vision] detector inference-space mismatch — refusing this cycle: ${JSON.stringify(detail)}`,
      ),
    },
  );

  const corrector = new VisionCorrector({
    frames,
    // SizeGuardedDetector composes a DetectorClient rather than extending it
    // (see vision-tools.ts's module doc — this project's own precedent,
    // vision-corrector.test.ts's harness, already satisfies this field with
    // a plain object cast this same way), so it needs an explicit cast here:
    // CorrectorDeps.detector is nominally typed to DetectorClient's private
    // constructor params, which SizeGuardedDetector structurally cannot
    // match despite exposing an identical detect() method.
    detector: detector as unknown as DetectorClient,
    postures,
    predictPixel: buildPredictPixel(session, postures, () => visionRuntime.focalPx()),
    applyOffset: (dPanDeg, dTiltDeg) => { session.nudgeOffset(dPanDeg, dTiltDeg); },
    focalPx: () => visionRuntime.focalPx(),
    frameSizePx: () => resolveVisionFrameSizePx(cfg),
    gain: () => cfg.visionGain,
    readOnly: () => visionRuntime.isReadOnly(),
    gateRadiusPx: () => cfg.visionGateRadiusPx,
    minConf: () => cfg.visionMinConf,
    log: (outcome, detail) => {
      visionRuntime.recordOutcome(outcome, detail);
      // Edge-triggered: every outcome is recorded into VisionRuntime (so
      // get_vision_status always reflects the latest tick), but the console
      // only gets a line when the outcome CHANGES -- at visionTickHz this
      // would otherwise print forever even in the completely routine
      // steady state (e.g. "applied" every tick while locked on).
      if (outcome !== lastLoggedVisionOutcome) {
        console.log(`[tb3-vision] ${outcome}`, detail);
        lastLoggedVisionOutcome = outcome;
      }
    },
  });
  let lastLoggedVisionOutcome: CorrectorOutcome | null = null;

  // Wired unconditionally (mirrors SunSupervisor.start()/tick()'s own
  // enabled-flag-checked-per-tick pattern) so set_vision_enabled can turn
  // the loop on at runtime without a daemon restart; the tick body itself
  // is the gate. `visionTicking` guards against overlap: visionDetectorTimeoutMs
  // defaults to 2000ms, longer than the 1Hz default tick period, so a slow
  // detector response could otherwise start a second tick before the first
  // resolves.
  let visionTicking = false;
  realScheduler.every(Math.max(20, Math.round(1000 / cfg.visionTickHz)), () => {
    if (!visionRuntime.isEnabled() || visionTicking) return;
    visionTicking = true;
    corrector.tick()
      .catch((e) => console.error("[tb3-vision] tick threw", e))
      .finally(() => { visionTicking = false; });
  });

  const app = buildApp(
    device, cfg, store, session, supervisor, source, follower, sectorStore, capture, limitsStore,
    frames, detector, visionRuntime,
  );
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
