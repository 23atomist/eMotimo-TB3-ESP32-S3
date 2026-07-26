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
        registerGeoTools(server, device, cfg, store, session, supervisor);
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
    // `icao` here is always a hex: TrackingSession.currentIcao() (threaded
    // through onStateChange below) for auto-capture, or the operator's raw
    // input for a manual snapshot. Only attach the human-readable callsign
    // when it can be proven to belong to the SAME hex currently tracked, so
    // an unrelated manual snapshot never gets mislabeled with whatever the
    // rig happens to be tracking at that moment.
    snapshot: (icao) => {
      const trackedHex = session.currentIcao();
      const callsign = trackedHex !== null && trackedHex.toLowerCase() === icao.toLowerCase()
        ? session.status().label
        : null;
      return takeSnapshot(cfg, icao, callsign, new Date().toISOString());
    },
    // The daemon does not own the camera; MediaMTX reporting the path ready
    // IS the armed signal, and it needs no dashboard round-trip.
    isArmed: async () => (await mtx.pathInfo())?.ready === true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  }, { debounceMs: cfg.captureDebounceMs, autoEnabled: cfg.captureAutoEnabled });
  session.onStateChange((state, icao) => capture.onTrack(state, icao));

  const app = buildApp(device, cfg, store, session, supervisor, source, follower, sectorStore, capture);
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
