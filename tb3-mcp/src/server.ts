import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
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
import { PassRecorder } from "./capture/pass-recorder.js";
import { PassJournal } from "./capture/pass-journal.js";
import { aircraftAltitudeM } from "./adsb/convert.js";
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

// Builds the vision loop's FrameSource. The pipe implementation is selected
// by cfg.cameraSource -- the two live paths are structurally different, not
// a matter of one flag:
//
// v4l2 / mtplvcap: consume the DASHBOARD's own /camera/stream MJPEG relay
// (a separate process, src/dashboard/server.ts) over HTTP, rather than
// spawning a second ffmpeg/mtplvcap process in this daemon. Deliberate:
// mtplvcapSpawner's own module doc notes "only ONE mtplvcap may hold the
// camera's USB/PTP session at a time" and its serialization guard is
// module-scoped, i.e. useless across two separate Node processes -- a
// second capture process spawned here would fight the dashboard's for the
// camera and wedge both. CameraStreamer's /camera/stream already supports
// multiple concurrent readers (`writers: Set<ServerResponse>`), so this
// just becomes one more viewer of a pipeline that's already running (or
// already retrying) on its own. JpegFrameParser (already used for both
// mtplvcap's multipart body and ffmpeg's bare stream) splits either shape
// identically, so this one implementation covers both sources.
//
// mediamtx (fix round 6 / operator correction -- confirmed against the
// live host config: mtplvcap is dead, the rig actually runs mediamtx):
// CameraStreamer's HTTP relay does NOT exist on this path -- the camera is
// a MediaMtxPublisher instead (WebRTC-only in the dashboard; no attach()/
// MJPEG relay -- see dashboard/server.ts's CameraLike comment), so
// /camera/stream 404s and the relay approach above retries a 404
// indefinitely, reporting no_frame forever. Vision instead spawns its OWN
// ffmpeg reading cfg.cameraMediamtxRtspUrl directly and re-encoding to
// MJPEG on stdout -- MediaMTX natively serves multiple concurrent RTSP
// readers, so this does not contend with the browser's WebRTC session (the
// original reason the HTTP-relay approach was chosen for v4l2/mtplvcap
// does not apply here: there is no second process fighting over a
// camera device, only a second READER of a stream MediaMTX already
// fans out). Also drops the Authorization/authGate dependency entirely for
// this path, since MediaMTX's RTSP port is loopback-only.
//
// Retry backoff between reconnect attempts. Not configurable in production;
// exposed as an optional param so tests don't have to wait 2s per retry to
// exercise the retry-and-log path.
const FRAME_SOURCE_RETRY_MS = 2000;
// "the first failure plus every Nth retry" (fix round 2 / IMPORTANT 4): the
// first is unconditional (a hardened host must never go silent from the
// very first attempt), and after that only every Nth keeps a PERSISTENT
// failure visible in the journal without flooding it every 2s forever.
// Shared by both pipe implementations below.
const FRAME_SOURCE_LOG_EVERY_N_RETRIES = 10;

// Not unit-tested for the real dashboard/HTTP round-trip end-to-end (same
// convention as mtplvcapSpawner/ffmpegV4l2Spawner in dashboard/camera/*.ts:
// "NOT unit-tested: real subprocess + stdout relay; verified on-host"), but
// as of fix round 2 the auth header, retry/logging path, and frame-parsing
// ARE covered against a real node:http server in test/vision-tools.test.ts
// (the reviewer's own point: this is a fetch + a parser loop, not a
// subprocess, and is exactly as testable as vision-detector-client.test.ts's
// DetectorClient).
function spawnHttpRelayPipe(cfg: Config, retryMs: number): FramePipe {
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
}

// The ffmpeg argv for pulling MediaMTX's RTSP stream and re-encoding it to
// MJPEG on stdout. Split out and exported so flag ORDER (all input options
// before -i) can be pinned in a unit test the same way ffmpegV4l2Args is --
// the spawner itself is not unit-tested (real subprocess), same convention
// as every other ffmpeg spawner in this codebase.
//
// -rtsp_transport tcp: matches the ingest side's own choice
// (dashboard/camera/rtsp.ts) for a reliable loopback connection.
// -rw_timeout 5000000 (NP-4, round 4): a read timeout, in microseconds, on
// the RTSP input itself. Without it, a half-open connection (TCP up, no
// data -- e.g. MediaMTX wedged, or the publish side silently stalled) makes
// ffmpeg block forever: neither 'exit' nor 'error' fires, finish() never
// runs, and the pull never reconnects. C3's frame_stale check makes this
// fail CLOSED rather than wind up the aim offset, so it was never unsafe --
// but it stayed wedged until a daemon restart. 5s is generous relative to
// the default 1Hz visionTickHz and C3's own 3000ms frameMaxAgeMs default,
// while still bounding the worst case to a single-digit number of seconds.
// -c:v mjpeg: MediaMTX serves H.264 (that is what the WebRTC/RTSP publish
// side encodes -- see rtsp.ts), so this is a genuine decode+re-encode, not
// a passthrough copy like ffmpegV4l2Args's "-c:v copy". Decode+re-encode
// does not itself resize the frame, so resolveVisionFrameSizePx's
// cameraMediamtxSize (the size the INGEST side commanded, rtsp.ts:54)
// remains the correct ground truth for what arrives here.
// -q:v 2 (NP-3, round 4): WITHOUT an explicit quality, ffmpeg's mjpeg
// encoder falls back to bitrate rate control and produces a badly
// quantized frame -- measured (ffmpeg 8.1.2, this exact output chain,
// frame-aligned PSNR against the losslessly-decoded source at 1080p):
// unset = 32.9dB Y-PSNR at ~33KB/frame; -q:v 2 = 46.9dB at ~110KB/frame.
// 14dB of quality is precisely what this loop needs on a small,
// low-contrast target, and losing it produces no error of any kind --
// every downstream symptom (a miss, a low-confidence detection) reads
// identically to a genuine geometry bug. -q:v 2 is ffmpeg's mjpeg
// near-lossless setting (scale is 2-31, lower is better).
export function visionRtspPullArgs(cfg: Config): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-rw_timeout", "5000000",
    "-i", cfg.cameraMediamtxRtspUrl,
    "-c:v", "mjpeg",
    "-q:v", "2",
    "-f", "mjpeg",
    "pipe:1",
  ];
}

// Mirrors dashboard/camera/mtplvcap.ts's own KILL_GRACE_MS (not imported
// directly -- that module's public surface, dashboard/camera/index.ts,
// does not re-export the constant, and every other symbol this daemon
// pulls from dashboard/camera/* already comes through that barrel; adding
// a second, non-barrel import path for one constant was not worth it).
const VISION_RTSP_KILL_GRACE_MS = 4000;

// The subprocess itself is not injected as a Spawner-shaped abstraction
// (dashboard/camera's own pattern) -- it is the raw node:child_process.spawn
// signature, injected as a plain function default-valued to the real thing.
// That is what makes reconnect/logging/per-connection-parser behaviour
// testable without a real ffmpeg: a test passes a fake `spawnChild` that
// returns an EventEmitter-shaped stub instead.
type SpawnChild = typeof spawn;

// Not unit-tested for the real subprocess round-trip (same convention as
// spawnHttpRelayPipe/ffmpegV4l2Spawner above: real ffmpeg process, verified
// on-host) -- but with spawnChild injected, reconnect/logging behaviour and
// per-connection parser construction ARE covered with a fake child process
// in test/vision-tools.test.ts, and visionRtspPullArgs's flag order is
// pinned separately.
function spawnRtspPullPipe(cfg: Config, retryMs: number, spawnChild: SpawnChild): FramePipe {
  let stopped = false;
  let cb: ((jpeg: Buffer) => void) | null = null;
  let proc: ReturnType<SpawnChild> | null = null;
  let attempt = 0;

  const connect = (): void => {
    if (stopped) return;
    // Fresh parser per connection, same rationale as spawnHttpRelayPipe's
    // own doc: a reused parser can carry a partial frame across a dropped
    // connection and read back garbled bytes on the next one.
    const parser = new JpegFrameParser();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      proc = null;
      if (stopped) return;
      attempt += 1;
      if (attempt === 1 || attempt % FRAME_SOURCE_LOG_EVERY_N_RETRIES === 0) {
        console.error(
          `[tb3-vision] mediamtx RTSP pull failed (attempt ${attempt}), retrying in ${retryMs}ms`,
        );
      }
      setTimeout(connect, retryMs);
    };

    // child_process.spawn does not throw synchronously for a missing
    // binary (ENOENT surfaces via the async 'error' event below) -- no
    // try/catch needed here, matching ffmpegV4l2Spawner's own convention.
    const child = spawnChild(cfg.cameraFfmpegBin, visionRtspPullArgs(cfg), {
      stdio: ["ignore", "pipe", "inherit"],
    });
    proc = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped || done) return;
      attempt = 0; // a frame arriving proves the pull is genuinely live; resets the retry/log counter
      for (const frame of parser.push(chunk)) cb?.(frame);
    });
    // A broken pipe surfaces as the process 'exit' below; swallow it here
    // so it can't become an unhandled 'error' event.
    child.stdout?.on("error", () => { /* handled via exit */ });
    child.on("exit", () => finish());
    child.on("error", () => finish()); // spawn failure: ffmpeg missing or not executable
  };
  connect();

  return {
    onFrame(fn) { cb = fn; },
    kill(): void {
      stopped = true;
      if (!proc) return;
      const p = proc;
      // SIGINT lets ffmpeg close the RTSP connection cleanly; SIGKILL
      // backstop so a wedged ffmpeg can't hold the pipe past teardown.
      try { p.kill("SIGINT"); } catch { /* already dead */ }
      const hard = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch { /* dead */ }
      }, VISION_RTSP_KILL_GRACE_MS);
      p.once("exit", () => clearTimeout(hard));
    },
  };
}

export function buildVisionFrameSource(
  cfg: Config, latencyMs: () => number, retryMs: number = FRAME_SOURCE_RETRY_MS,
  // Injectable for tests only -- see spawnRtspPullPipe's own doc. Every
  // production caller leaves this at the real node:child_process.spawn.
  spawnChild: SpawnChild = spawn,
): FrameSource {
  const spawnPipe = (): FramePipe => (
    cfg.cameraSource === "mediamtx"
      ? spawnRtspPullPipe(cfg, retryMs, spawnChild)
      : spawnHttpRelayPipe(cfg, retryMs)
  );

  return new MjpegPipeSource({ spawnPipe, now: () => Date.now(), latencyMs });
}

export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
  sectorStore: SectorStore, capture: CaptureController, limitsStore: LimitsStore,
  frames: FrameSource, detector: SizeGuardedDetector, visionRuntime: VisionRuntime,
  visionScaleStore: VisionScaleStore, journal: PassJournal,
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
        registerTools(server, device, cfg, session, supervisor, store, capture, limitsStore, journal);
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

// NP-1 (round 4 of independent review): the composition root itself was
// unpinned -- hardcoding VisionCorrector's axisSigns/tiltCalibrated Deps, or
// dropping buildPredictPixel's tiltCalibrated argument, compiled and passed
// every existing test, because nothing exercised these specific WIRING
// EXPRESSIONS; every vision test either hand-assembles its own Deps object
// (vision-corrector.test.ts) or calls registerVisionTools directly
// (vision-sign-audit.test.ts), never main()'s own lines. Returning a handle
// (in-repo precedent: dashboard/server.ts's own main()) lets a test drive
// and tear down the REAL composition root -- see
// test/vision-composition-root.test.ts.
export interface MainHandle {
  close(): void;
  device: Device;
  session: TrackingSession;
  visionRuntime: VisionRuntime;
}

export async function main(): Promise<MainHandle> {
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

  // --- Pass recorder wiring (Task 9) --------------------------------------
  // A SECOND, INDEPENDENT session.onStateChange listener -- deliberately not
  // merged into the capture listener above, and the capture listener above
  // is not touched by this block. CaptureController is called from the
  // real-time tracking tick under a strict never-await rule; it drives a
  // physical rig, and metadata journalling must never be able to
  // destabilise that. TrackingSession.setState (see track/session.ts)
  // already isolates each listener from the others -- a throw in one
  // (PassRecorder guards its own body regardless, see pass-recorder.ts) can
  // never prevent the other from running.
  const journal = new PassJournal(cfg.passJournalFile);
  // Every other file-backed store above announces its resolved path at
  // boot (calibration/limits/vision-scale); the journal gets the same
  // treatment -- it matters MORE here, since cfg.passJournalFile defaults
  // to /var/lib/tb3/passes.jsonl (a different location from the ~/.tb3-mcp/
  // the other stores use) and a write failure there is otherwise swallowed
  // into one `[tb3-pass] finish:` console line PER PASS, with no boot-time
  // signal that list_passes will stay permanently empty. Checks the
  // JOURNAL DIRECTORY's writability only (accessSync, not a real write) --
  // deliberately does not create the file or the directory itself: that is
  // PassJournal.append()'s job, at the moment of the first real write, not
  // main()'s to do speculatively on every boot.
  const journalDirWritable = (() => {
    try { accessSync(dirname(cfg.passJournalFile), fsConstants.W_OK); return true; }
    catch { return false; }
  })();
  console.error(`pass journal file: ${cfg.passJournalFile} (dir writable: ${journalDirWritable})`);
  const passRecorder = new PassRecorder({
    // One observation of the tracking session, right now -- sampled on a
    // timer (deps.sampleMs) while a pass is open, same cadence-independent
    // shape CaptureController itself reads via session.status().
    sample: () => {
      const s = session.status();
      const hex = session.currentIcao();
      const ac = hex ? source.getSnapshot().aircraft.find((a) => a.hex === hex) : undefined;
      return {
        state: s.state,
        targetAzimuthDeg: s.targetAzimuthDeg,
        targetElevationDeg: s.targetElevationDeg,
        targetRangeM: s.targetRangeM,
        pointingErrorDeg: s.pointingErrorDeg,
        panLimited: s.panLimited,
        tiltLimited: s.tiltLimited,
        altitudeM: ac ? aircraftAltitudeM(ac, cfg.adsbAltSource) : null,
      };
    },
    // ADS-B identity fields for a hex, or null if it is not (or no longer)
    // in the feed -- e.g. a target that dropped out of range mid-pass.
    lookup: (icao: string) => {
      const ac = source.getSnapshot().aircraft.find((a) => a.hex === icao);
      return ac ? { category: ac.category, squawk: ac.squawk, gsKt: ac.gsKt } : null;
    },
    // The listing thumbnail: the same lastSnapshot capture's own status()
    // already exposes to get_capture_status, read fresh at pass-finish time
    // rather than duplicating capture's snapshot bookkeeping here.
    lastSnapshot: () => capture.status().lastSnapshot,
    journal,
    now: () => Date.now(),
    scheduler: realScheduler,
    sampleMs: cfg.passSampleMs,
    // MUST equal captureDebounceMs -- this is the same debounce
    // CaptureController uses to bracket a recording, so the journal's pass
    // window matches the recording it describes.
    debounceMs: cfg.captureDebounceMs,
    newId: () => `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
  });
  session.onStateChange((state, icao) => {
    const callsign = session.status().label;
    passRecorder.onTrack(state, icao, callsign);
  });

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
      "contribute nothing every tick; switch to cameraSource=\"v4l2\" or \"mediamtx\"",
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
      // MEDIUM-2: and it must agree on WHETHER tilt is trustworthy at all,
      // not just its sign -- see buildPredictPixel's own doc.
      () => visionRuntime.tiltCalibrated(),
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
  const visionTimer = realScheduler.every(Math.max(20, Math.round(1000 / cfg.visionTickHz)), () => {
    if (!visionRuntime.isEnabled() || visionTicking) return;
    visionTicking = true;
    corrector.tick()
      .catch((e) => console.error("[tb3-vision] tick threw", e))
      .finally(() => { visionTicking = false; });
  });

  const app = buildApp(
    device, cfg, store, session, supervisor, source, follower, sectorStore, capture, limitsStore,
    frames, detector, visionRuntime, visionScaleStore, journal,
  );
  const httpServer = app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });

  return {
    device, session, visionRuntime,
    close(): void {
      visionTimer.cancel();
      passRecorder.dispose();
      frames.stop();
      supervisor.stop();
      if (cfg.adsbEnabled) source.stop();
      session.stop();
      httpServer.close();
      device.close();
    },
  };
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
