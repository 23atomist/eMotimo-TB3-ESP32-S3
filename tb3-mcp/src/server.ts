import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { Device } from "./device.js";
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
import { MediaMtxClient } from "./mediamtx/client.js";
import { CaptureController } from "./capture/controller.js";
import { takeSnapshot } from "./capture/snapshot.js";
import { assertCaptureFfmpegUsable } from "./capture/ffmpeg-preflight.js";

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

export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
  sectorStore: SectorStore, capture: CaptureController,
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
        registerTools(server, device, cfg, session, supervisor, store, capture);
        registerGeoTools(server, device, cfg, store, session, supervisor, source);
        registerImuTools(server, device, cfg, store, supervisor, session);
        registerTrackTools(server, session, supervisor);
        registerSunTools(server, device, cfg, store, supervisor);
        registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore);
        registerSectorTools(server, sectorStore);
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
  const session = new TrackingSession(device, cfg, store, Date.now, realScheduler, () => sectorStore.get());
  const supervisor = new SunSupervisor(device, cfg, store, session);
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

  const app = buildApp(device, cfg, store, session, supervisor, source, follower, sectorStore, capture);
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
