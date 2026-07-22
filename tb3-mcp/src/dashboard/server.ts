import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { tokenFromCookie } from "./auth.js";
import { CameraStreamer, realSpawner } from "./camera.js";
import { emergencyStop, runAction, type ControlDeps } from "./controls.js";
import { McpDashboardClient } from "./client.js";
import { RigDirectClient } from "./rig.js";
import { RealSystemctl, readServices } from "./services.js";
import { mergeState, type AdsbRaw, type DashboardState, type Result, type SourceInputs } from "./state.js";
import { withTimeout } from "./util.js";

// The daemon (dashboard aggregator) and the ESP32/systemctl/readsb sources it
// polls. Bundled so collect()/buildControlDeps() don't have to prop-drill
// four separate parameters.
interface Sources {
  client: McpDashboardClient;
  rig: RigDirectClient;
  sc: RealSystemctl;
  cfg: Config;
  camera: CameraStreamer;
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

// Per-MCP-call budget for the poller's collect() (see util.ts for why: the
// SDK's 60s default would otherwise let a wedged daemon freeze a poll tick).
const COLLECT_CALL_TIMEOUT_MS = 4000;
// Per-leg budget for the E-STOP fan-out's daemon-bound legs (stopTracking,
// agentStop), so a wedged daemon/systemctl can't lag the E-STOP result.
const ESTOP_LEG_TIMEOUT_MS = 5000;

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
    // scanTrackable() is also a daemon MCP call reached from collect()'s
    // Promise.all — bounded the same as the client.get*() calls below so a
    // wedged daemon can't stall the poll through this leg either.
    const trackable = await withTimeout(client.scanTrackable(), COLLECT_CALL_TIMEOUT_MS, "scanTrackable");
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
    tryResult(() => withTimeout(s.client.getDeviceStatus(), COLLECT_CALL_TIMEOUT_MS, "getDeviceStatus")),
    tryResult(() => s.rig.status()), // already bounded: rig.ts uses AbortSignal.timeout per host
    tryResult(() => withTimeout(s.client.getTrackingStatus(), COLLECT_CALL_TIMEOUT_MS, "getTrackingStatus")),
    tryResult(() => withTimeout(s.client.getTracked(), COLLECT_CALL_TIMEOUT_MS, "getTracked")),
    tryResult(() => withTimeout(s.client.getCalibration(), COLLECT_CALL_TIMEOUT_MS, "getCalibration")),
    tryResult(() => withTimeout(s.client.getSun(), COLLECT_CALL_TIMEOUT_MS, "getSun")),
    getAdsb(s.client, s.cfg),
    readServices(s.sc), // already bounded: services.ts passes { timeout: 5000 } to execFile
  ]);
  // camera status is in-process + synchronous — no await, never fails.
  return { deviceStatus, rigDirect, tracking, tracked, calibration, sun, adsb, services, camera: s.camera.status() };
}

function buildControlDeps(s: Sources): ControlDeps {
  return {
    track: s.client.track.bind(s.client),
    // stopTracking/agentStop are the daemon/systemctl-bound legs of the
    // E-STOP fan-out (see controls.ts's emergencyStop) as well as the
    // regular "Stop tracking" button — bounded so a wedged daemon or
    // systemctl can't leave either waiting on the SDK's 60s default.
    stopTracking: () => withTimeout(s.client.stopTracking(), ESTOP_LEG_TIMEOUT_MS, "stopTracking"),
    jog: s.client.jog.bind(s.client),
    setRigLocation: s.client.setRigLocation.bind(s.client),
    sightLandmark: s.client.sightLandmark.bind(s.client),
    solveCalibration: s.client.solveCalibration.bind(s.client),
    clearCalibration: s.client.clearCalibration.bind(s.client),
    firmwareStop: s.rig.stop.bind(s.rig), // already bounded: rig.ts uses AbortSignal.timeout
    agentStop: () => withTimeout(s.sc.stop("tb3-agent"), ESTOP_LEG_TIMEOUT_MS, "agentStop"),
    agentStart: () => s.sc.start("tb3-agent"),
    cameraStart: (source) => s.camera.enable(source),
    cameraStop: () => s.camera.disable(),
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
    camera: { enabled: false, source: "v4l2", streaming: false, viewers: 0 },
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

function registerRoutes(
  app: Express, cfg: Config, agg: Aggregator, deps: ControlDeps, publicDir: string, camera: CameraStreamer,
): void {
  app.use(express.json());
  app.use(express.static(publicDir));

  // Optional token gate, scoped to the API/camera surface (matches
  // src/server.ts's "/mcp" token middleware, applied here to "/api" + "/camera"
  // instead so the static SPA shell always loads).
  //
  // Three ways to present the token, any of which is accepted:
  //  - `Authorization: Bearer <token>` header (only usable by plain fetch();
  //    EventSource and <img src> cannot set custom headers)
  //  - `?token=<token>` query param (a one-time link into the dashboard)
  //  - `tb3_token` cookie (what app.js's bootstrapAuthToken() stores after
  //    reading the query param once, so subsequent same-origin EventSource/
  //    <img>/fetch requests all authenticate automatically)
  // If dashboardAuth is on but mcpToken isn't set, fail closed regardless of
  // what's presented (see deploy/HOST-SETUP.md §4).
  const authGate = (req: Request, res: Response, next: NextFunction): void => {
    if (!cfg.dashboardAuth) { next(); return; }
    if (!cfg.mcpToken) { res.status(401).json({ error: "unauthorized" }); return; }
    const auth = req.header("authorization") ?? "";
    const headerOk = auth === `Bearer ${cfg.mcpToken}`;
    const queryToken = req.query.token;
    const queryOk = typeof queryToken === "string" && queryToken === cfg.mcpToken;
    const cookieOk = tokenFromCookie(req.headers.cookie, "tb3_token") === cfg.mcpToken;
    if (headerOk || queryOk || cookieOk) { next(); return; }
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

  app.get("/camera/stream", (_req: Request, res: Response) => {
    camera.attach(res);
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
  const camera = new CameraStreamer(
    (source) => realSpawner(cfg, source),
    { fallbackMs: cfg.cameraFallbackMs, enabled: cfg.cameraStartEnabled, source: cfg.cameraDefaultSource },
  );
  const sources: Sources = { client, rig, sc, cfg, camera };
  const deps = buildControlDeps(sources);
  const agg = new Aggregator(sources);

  void agg.poll();
  setInterval(() => { void agg.poll(); }, 1000);

  const app: Express = express();
  // dist/dashboard/server.js -> ../../dashboard/public == tb3-mcp/dashboard/public
  // (sibling of src/ and dist/ at the package root).
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../dashboard/public");
  registerRoutes(app, cfg, agg, deps, publicDir, camera);

  app.listen(cfg.dashboardPort, cfg.dashboardBind, () => {
    console.log(`[tb3-dashboard] listening on http://${cfg.dashboardBind}:${cfg.dashboardPort}` +
      (cfg.dashboardAuth ? " (token required)" : "") +
      ` -> daemon :${cfg.mcpPort}, rig ${cfg.deviceHost}`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
