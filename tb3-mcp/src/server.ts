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
  toVisionScale,
} from "./vision-tools.js";
import { VisionScaleStore } from "./vision-scale-store.js";

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
// stamped by THIS HOST at the moment device.ts's WS "message" handler parses
// a real tick (device.ts:109, this.now() inside onTick(raw)) -- it is host
// receipt/parse time, NOT a timestamp the firmware itself embeds in the tick
// payload (there is no such field on the wire; corrected in fix round 2 --
// an earlier version of this comment overclaimed "when the firmware's tick
// said the posture was true"). It is still strictly better than Date.now()
// polled or callback-invoked later, once network/event-loop delay between
// the WS frame arriving and this code running has already been added on
// top: recording AT PARSE keeps that residual to whatever it already was,
// where recording at a later poll/Date.now() call adds MORE on top of it.
// This project already paid for exactly that further addition once, on a
// different data path, as a 1.91s pointing lag found on the roof on
// 2026-07-22 -- see test/vision-tools.test.ts's mutation test, which pins
// this against Date.now() specifically because of that history. Exported so
// it can be driven from Device.onTelemetry() in main() without needing a
// live Device/WebSocket in tests (test/vision-tools.test.ts calls this
// directly against a bare DeviceState).
export function recordPostureSample(postures: PostureHistory, dev: DeviceState, cfg: Config): void {
  if (dev.lastUpdateMs === 0) return; // never connected -- no real posture yet
  postures.record(
    dev.lastUpdateMs,
    applySign(stepsToDeg(dev.panSteps), cfg.panSign),
    applySign(stepsToDeg(dev.tiltSteps), cfg.tiltSign),
  );
}

// Companion to recordPostureSample, added in fix round 1 to close the
// CRITICAL finding: predictPixel used to read session.status().targetPanDeg/
// TiltDeg directly at call time, which is the target's aim as of the tracker's
// LAST tick (itself projected trackLeadMs into ITS OWN future) -- an epoch
// that has nothing to do with exposureMs. That mixed target@now against
// posture@exposure, and the resulting error grew with the calibrated camera
// latency rather than being bounded by one tick. This records the target aim
// into a second PostureHistory-shaped ring, keyed by Device.onTelemetry's own
// event time (same event recordPostureSample rides -- see main()'s wiring),
// so vision-tools.ts's buildPredictPixel can interpolate it at exposureMs
// instead of reading "now" — see that function's doc for the full accounting
// and the residual bias that remains.
//
// FIX ROUND 3 / HIGH 1: gated on session.status().state === "tracking", NOT
// session.isActive() (state !== "stopped" -- see track/session.ts:128).
// isActive() is also true in "waiting" and "acquiring", and EVERY early
// return in TrackingSession.tick() (not_calibrated, program_engaged,
// telemetry_stale, target_stale) sets state to "waiting" and returns BEFORE
// recordAim() runs -- freezing lastStatus at whatever it held before the
// dropout. Gating the write on isActive() alone meant recordTargetSample kept
// replaying that FROZEN target under a FRESH timestamp for the whole
// dropout window: the reviewer measured 8.4°/245px of prediction error in
// the window after a reacquire, invisible to the targetAgeMs freshness gate
// because that field derives from the ADS-B estimator independently of
// session state (a live ADS-B feed can look fresh while the SESSION itself
// has stopped recording aim). It failed safe (the ~120px default gate
// radius still refused it), costing missed corrections rather than wrong
// ones, but "tracking" is the only state in which lastStatus was just
// updated by THIS tick, so it is the only state this may write under.
export function recordTargetSample(targetHistory: PostureHistory, session: TrackingSession, nowMs: number): void {
  const s = session.status();
  if (s.state !== "tracking") return;
  if (s.targetPanDeg === null || s.targetTiltDeg === null) return;
  targetHistory.record(nowMs, s.targetPanDeg, s.targetTiltDeg);
}

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
// Retry backoff between reconnect attempts. Not configurable in production;
// exposed as an optional param so tests don't have to wait 2s per retry to
// exercise the retry-and-log path.
const FRAME_SOURCE_RETRY_MS = 2000;
// "the first failure plus every Nth retry" (fix round 2 / IMPORTANT 4): the
// first is unconditional (a hardened host must never go silent from the
// very first attempt), and after that only every Nth keeps a PERSISTENT
// failure visible in the journal without flooding it every 2s forever.
const FRAME_SOURCE_LOG_EVERY_N_RETRIES = 10;

// Not unit-tested for the real dashboard/HTTP round-trip end-to-end (same
// convention as mtplvcapSpawner/ffmpegV4l2Spawner in dashboard/camera/*.ts:
// "NOT unit-tested: real subprocess + stdout relay; verified on-host"), but
// as of fix round 2 the auth header, retry/logging path, and frame-parsing
// ARE covered against a real node:http server in test/vision-tools.test.ts
// (the reviewer's own point: this is a fetch + a parser loop, not a
// subprocess, and is exactly as testable as vision-detector-client.test.ts's
// DetectorClient).
export function buildVisionFrameSource(
  cfg: Config, latencyMs: () => number, retryMs: number = FRAME_SOURCE_RETRY_MS,
): FrameSource {
  const spawnPipe = (): FramePipe => {
    let stopped = false;
    let cb: ((jpeg: Buffer) => void) | null = null;
    const controller = new AbortController();
    const url = `http://127.0.0.1:${cfg.dashboardPort}/camera/stream`;
    let attempt = 0;

    const connect = async (): Promise<void> => {
      if (stopped) return;
      // FIX ROUND 2 / minor: constructed per-connection rather than once
      // per spawnPipe() call (which lives for the FrameSource's whole
      // lifetime across every reconnect). A reused parser can have a
      // partial frame buffered from a connection that dropped mid-frame;
      // the next connection's bytes then get concatenated onto that leftover
      // and read back as one garbled JPEG. A fresh parser per connect()
      // starts clean every time, at the cost of at most the one partial
      // frame that was already unusable.
      const parser = new JpegFrameParser();
      try {
        // FIX ROUND 2 / IMPORTANT 4: /camera/stream sits behind
        // dashboard/server.ts's authGate, which is enabled by
        // cfg.dashboardAuth (documented supported hardening -- see
        // deploy/HOST-SETUP.md) and accepts exactly this header (see
        // authGate's own `headerOk = auth === \`Bearer ${cfg.mcpToken}\``).
        // Without it, a hardened host 401s every request forever with the
        // catch below swallowing it silently -- "no_frame" with no
        // diagnostic anywhere. cfg.mcpToken is the SAME token guarding this
        // daemon's own /mcp endpoint (see buildApp's bearer gate above), so
        // reusing it here needs no new config surface.
        const headers: Record<string, string> = {};
        if (cfg.mcpToken) headers.authorization = `Bearer ${cfg.mcpToken}`;
        const res = await fetch(url, { signal: controller.signal, headers });
        if (!res.ok || !res.body) throw new Error(`camera stream HTTP ${res.status}`);
        attempt = 0; // a successful connection resets the retry/log counter
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (stopped) return;
          if (done) break;
          if (value) for (const frame of parser.push(Buffer.from(value))) cb?.(frame);
        }
      } catch (e) {
        attempt += 1;
        if (attempt === 1 || attempt % FRAME_SOURCE_LOG_EVERY_N_RETRIES === 0) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[tb3-vision] camera stream fetch failed (attempt ${attempt}): ${msg}`);
        }
        /* dashboard not up yet, camera disarmed, auth rejected, or the
           stream dropped mid-read -- fall through to retry below */
      }
      if (!stopped) setTimeout(() => { void connect(); }, retryMs);
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
  visionScaleStore: VisionScaleStore,
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
        registerVisionTools(
          server, cfg, device, session, supervisor, frames, detector, visionRuntime, visionScaleStore,
          () => limitsStore.get(),
        );
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
  // set_vision_enabled, rather than a blind spot lasting as long as the
  // ring's own capacity. targetHistory rides the SAME Device.onTelemetry
  // event as recordPostureSample (see recordTargetSample's doc — fix
  // round 1) so buildPredictPixel can interpolate the target's aim at
  // exposureMs instead of reading session.status() "as of now".
  //
  // FIX ROUND 2 / minor: this used to be a 100ms independent poll of
  // device.getState(). CORRECTION (fix round 3): an earlier version of this
  // comment claimed the migration to Device.onTelemetry() fixed "no_posture"
  // flapping and dropped samples. The reviewer measured both feeds side by
  // side at the rig's REAL telemetry rate (~5Hz / 200ms, src/tb3_web.cpp)
  // and got IDENTICAL results: a 100ms poll cannot miss a 200ms tick, and
  // because recordPostureSample stamps at dev.lastUpdateMs rather than the
  // poll instant, the ring's newest timestamp was already the tick's own
  // time either way -- neither claim was true at today's actual rate. The
  // "no_posture" flapping itself is real and remains (a deliberate bring-up
  // decision, not something to paper over here -- see Task 9's ledger); this
  // migration does not touch it. What this DOES buy: immunity to a future
  // telemetry rate faster than 100ms (where a fixed poll interval genuinely
  // could miss or double-count a tick), and immunity to an event-loop stall
  // (a scheduled poll can miss its own window independently of whether a
  // message arrived; a callback invoked directly from the WS "message"
  // handler cannot skip a tick that was actually processed).
  const postures = new PostureHistory();
  const targetHistory = new PostureHistory();
  device.onTelemetry((state) => {
    recordPostureSample(postures, state, cfg);
    recordTargetSample(targetHistory, session, Date.now());
  });

  const visionRuntime = new VisionRuntime(cfg);
  // FIX ROUND 2 / spec miss: seed the in-memory runtime from disk so a
  // calibration survives a daemon restart -- previously the scale lived only
  // in VisionRuntime, so every restart silently forgot it and the corrector
  // reported no_scale until an operator re-ran a rig-moving calibration.
  // Follows CalibrationStore/SectorStore/LimitsStore's own file-then-load
  // convention exactly (this branch has no src/tuning-store.ts to follow
  // instead).
  const visionScaleFile = cfg.visionScaleFile ?? join(homedir(), ".tb3-mcp", "vision-scale.json");
  const visionScaleStore = new VisionScaleStore(visionScaleFile);
  visionScaleStore.load();
  const loadedScale = visionScaleStore.get();
  if (loadedScale) visionRuntime.setScale(toVisionScale(loadedScale));
  console.error(
    `vision scale file: ${visionScaleFile} (calibrated: ${loadedScale !== null}` +
    (loadedScale ? `, focalPx=${loadedScale.focalPx.toFixed(1)} latencyMs=${loadedScale.latencyMs.toFixed(0)}` : "") +
    ")",
  );
  // FIX ROUND 3: TB3_VISION_ENABLED=true with the shipping default
  // cameraSource="mtplvcap" boots "enabled" and structurally inert (the
  // {0,0} sentinel -- see resolveVisionFrameSizePx's doc), with nothing in
  // the journal saying so; set_vision_enabled's own refusal (IMPORTANT 3)
  // only fires for a RUNTIME call, not this config-driven boot path, which
  // bypasses it entirely. One log line at startup closes that gap without
  // touching the fail-closed guard itself.
  if (cfg.visionEnabled && !(resolveVisionFrameSizePx(cfg).widthPx > 0)) {
    console.error(
      `[tb3-vision] visionEnabled=true but cameraSource="${cfg.cameraSource}" has no configured ` +
      "frame size (resolveVisionFrameSizePx returned {0,0}) -- the correction loop will run but " +
      "contribute nothing every tick; switch to cameraSource=\"v4l2\" or configure a size",
    );
  }
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

  // FIX ROUND 2 / minor: hoisted above the VisionCorrector construction that
  // closes over it in `log` below (was declared after, which the closure
  // could still read correctly -- `let` bindings are visible for the whole
  // enclosing block, no TDZ crossing at call time since `log` only runs on a
  // later tick -- but declaring a variable after the closure that captures
  // it reads as a forward reference to a future maintainer and invites a
  // real bug next time this function is reordered).
  let lastLoggedVisionOutcome: CorrectorOutcome | null = null;
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
    predictPixel: buildPredictPixel(
      session, targetHistory, postures, () => visionRuntime.focalPx(), cfg.trackMaxTargetAgeMs,
      // A5: the prediction limb must agree with the correction limb
      // (focalPx below) on axis handedness, or the prediction sits on the
      // wrong side of centre from the real detection (C2's mechanism).
      () => visionRuntime.axisSigns(),
    ),
    applyOffset: (dPanDeg, dTiltDeg) => { session.nudgeOffset(dPanDeg, dTiltDeg); },
    focalPx: () => visionRuntime.focalPx(),
    axisSigns: () => visionRuntime.axisSigns(),
    tiltCalibrated: () => visionRuntime.tiltCalibrated(),
    frameSizePx: () => resolveVisionFrameSizePx(cfg),
    gain: () => cfg.visionGain,
    readOnly: () => visionRuntime.isReadOnly(),
    gateRadiusPx: () => cfg.visionGateRadiusPx,
    minConf: () => cfg.visionMinConf,
    // Fix B (C3): read fresh per tick, like every other live-configurable
    // Dep here.
    now: () => Date.now(),
    frameMaxAgeMs: () => cfg.visionFrameMaxAgeMs,
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
    frames, detector, visionRuntime, visionScaleStore,
  );
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
