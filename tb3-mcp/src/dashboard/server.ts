import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { emergencyStop, runAction, type ControlDeps } from "./controls.js";
import { McpDashboardClient } from "./client.js";
import { RigDirectClient } from "./rig.js";
import { RealSystemctl, readServices } from "./services.js";
import { mergeState, type AdsbRaw, type DashboardState, type Result, type SourceInputs } from "./state.js";

// The daemon (dashboard aggregator) and the ESP32/systemctl/readsb sources it
// polls. Bundled so collect()/buildControlDeps() don't have to prop-drill
// four separate parameters.
interface Sources {
  client: McpDashboardClient;
  rig: RigDirectClient;
  sc: RealSystemctl;
  cfg: Config;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function tryResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const ADSB_FETCH_TIMEOUT_MS = 3000;

function countAircraft(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const aircraft = (body as { aircraft?: unknown }).aircraft;
  return Array.isArray(aircraft) ? aircraft.length : null;
}

// trackable comes from the daemon (already sun/limit/reachability-filtered);
// rawCount is a direct, best-effort peek at readsb so the dashboard can show
// "N aircraft seen, M trackable" even if the daemon leg fails. A failed
// rawCount fetch degrades to `null`, not a whole-adsb-entry error — only a
// failing scanTrackable() call does that.
async function getAdsb(client: McpDashboardClient, cfg: Config): Promise<Result<AdsbRaw>> {
  try {
    const trackable = await client.scanTrackable();
    let rawCount: number | null = null;
    try {
      const r = await fetch(cfg.adsbUrl, { signal: AbortSignal.timeout(ADSB_FETCH_TIMEOUT_MS) });
      rawCount = r.ok ? countAircraft(await r.json()) : null;
    } catch { /* best-effort: raw readsb count stays null on failure */ }
    return { ok: true, value: { rawCount, trackable } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function collect(s: Sources): Promise<SourceInputs> {
  const [deviceStatus, rigDirect, tracking, tracked, calibration, sun, adsb, services] = await Promise.all([
    tryResult(() => s.client.getDeviceStatus()),
    tryResult(() => s.rig.status()),
    tryResult(() => s.client.getTrackingStatus()),
    tryResult(() => s.client.getTracked()),
    tryResult(() => s.client.getCalibration()),
    tryResult(() => s.client.getSun()),
    getAdsb(s.client, s.cfg),
    readServices(s.sc),
  ]);
  return { deviceStatus, rigDirect, tracking, tracked, calibration, sun, adsb, services };
}

function buildControlDeps(s: Sources): ControlDeps {
  return {
    track: s.client.track.bind(s.client),
    stopTracking: s.client.stopTracking.bind(s.client),
    jog: s.client.jog.bind(s.client),
    setRigLocation: s.client.setRigLocation.bind(s.client),
    sightLandmark: s.client.sightLandmark.bind(s.client),
    solveCalibration: s.client.solveCalibration.bind(s.client),
    clearCalibration: s.client.clearCalibration.bind(s.client),
    firmwareStop: s.rig.stop.bind(s.rig),
    agentStop: () => s.sc.stop("tb3-agent"),
    agentStart: () => s.sc.start("tb3-agent"),
  };
}

// Every Result-typed field starts in this state until the first poll lands,
// so /api/state and a client that connects to /api/stream before the first
// tick still get a well-formed (fully degraded) DashboardState instead of
// undefined/a crash.
const NOT_POLLED_YET = { ok: false as const, error: "not polled yet" };

function emptySources(): SourceInputs {
  return {
    deviceStatus: NOT_POLLED_YET, rigDirect: NOT_POLLED_YET, tracking: NOT_POLLED_YET,
    tracked: NOT_POLLED_YET, calibration: NOT_POLLED_YET, sun: NOT_POLLED_YET, adsb: NOT_POLLED_YET,
    services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
  };
}

// Holds the latest merged snapshot and fans it out to SSE subscribers.
// poll() is non-overlapping (a `running` guard) and never throws.
class Aggregator {
  latest: DashboardState;
  private readonly clients = new Set<Response>();
  private running = false;

  constructor(private readonly sources: Sources) {
    this.latest = mergeState(emptySources(), Date.now());
  }

  addClient(res: Response): void {
    this.clients.add(res);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.latest = mergeState(await collect(this.sources), Date.now());
      this.broadcast();
    } catch (e) {
      console.error("[tb3-dashboard] poll error:", e);
    } finally {
      this.running = false;
    }
  }

  private broadcast(): void {
    const payload = `data: ${JSON.stringify(this.latest)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

function registerRoutes(app: Express, cfg: Config, agg: Aggregator, deps: ControlDeps, publicDir: string): void {
  app.use(express.json());
  app.use(express.static(publicDir));

  // Optional bearer-token gate, scoped to the API/camera surface (matches
  // src/server.ts's "/mcp" token middleware, applied here to "/api" + "/camera"
  // instead so the static SPA shell always loads).
  const authGate = (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.dashboardAuth) { next(); return; }
    const auth = req.header("authorization") ?? "";
    if (cfg.mcpToken && auth === `Bearer ${cfg.mcpToken}`) { next(); return; }
    res.status(401).json({ error: "unauthorized" });
  };
  app.use("/api", authGate);
  app.use("/camera", authGate);

  app.get("/api/state", (_req: Request, res: Response) => {
    res.json(agg.latest);
  });

  app.get("/api/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(`data: ${JSON.stringify(agg.latest)}\n\n`);
    agg.addClient(res);
    const cleanup = (): void => { agg.removeClient(res); };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  // Direct-to-firmware E-STOP fan-out; registered ahead of the generic
  // /api/control/* handler below so "estop" is never routed through runAction.
  app.post("/api/control/estop", async (_req: Request, res: Response) => {
    res.json(await emergencyStop(deps));
  });

  // Splat route: action strings like "calibrate/set-location" contain a "/",
  // so a plain ":action" param (no slash) would truncate it — req.params[0]
  // captures everything after "/api/control/", slashes included.
  app.post("/api/control/*", async (req: Request, res: Response) => {
    const action = req.params[0];
    res.json(await runAction(deps, action, (req.body ?? {}) as Record<string, unknown>));
  });

  // TODO(Task 8): replace with `camera.attach(res)` once src/dashboard/camera.ts
  // (the gphoto2->ffmpeg MJPEG streamer) lands.
  app.get("/camera/stream", (_req: Request, res: Response) => {
    res.status(503).type("text/plain").send("camera not wired yet");
  });
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");

  const client = new McpDashboardClient(`http://127.0.0.1:${cfg.mcpPort}/mcp`, cfg.mcpToken);
  try {
    await client.connect();
  } catch (e) {
    // Tolerate a failed connect: collect() wraps every client.* call in its
    // own Result, so the aggregator just degrades those fields instead of
    // refusing to start.
    console.error("[tb3-dashboard] daemon MCP connect failed (continuing, degraded):", errMsg(e));
  }

  const rig = new RigDirectClient([cfg.deviceHost, cfg.deviceIpFallback].filter((h): h is string => !!h));
  const sc = new RealSystemctl();
  const sources: Sources = { client, rig, sc, cfg };
  const deps = buildControlDeps(sources);
  const agg = new Aggregator(sources);

  void agg.poll();
  setInterval(() => { void agg.poll(); }, 1000);

  const app: Express = express();
  // dist/dashboard/server.js -> ../../dashboard/public == tb3-mcp/dashboard/public
  // (sibling of src/ and dist/ at the package root).
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../dashboard/public");
  registerRoutes(app, cfg, agg, deps, publicDir);

  app.listen(cfg.dashboardPort, cfg.dashboardBind, () => {
    console.log(`[tb3-dashboard] listening on http://${cfg.dashboardBind}:${cfg.dashboardPort}` +
      (cfg.dashboardAuth ? " (token required)" : "") +
      ` -> daemon :${cfg.mcpPort}, rig ${cfg.deviceHost}`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
