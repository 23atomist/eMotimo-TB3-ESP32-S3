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
import { registerGeoTools, currentUserPanTilt } from "./geo-tools.js";
import { registerImuTools } from "./imu-tools.js";
import { registerTrackTools } from "./track-tools.js";
import { registerSunTools } from "./sun-tools.js";
import { CalibrationStore } from "./calibration.js";
import { TrackingSession, realScheduler } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { registerAdsbTools } from "./adsb-tools.js";
import { aircraftGeodetic } from "./adsb/convert.js";
import { enuPosition } from "./geo/wgs84.js";
import { Vec3 } from "./geo/vec3.js";
import { SectorStore } from "./sector-store.js";
import { registerSectorTools } from "./sector-tools.js";
import { LimitsStore } from "./limits-store.js";
import { registerLimitsTools } from "./limits-tools.js";
import { BootWatcher } from "./boot-watch.js";
import { registerRezeroTools, onReboot } from "./rezero-tools.js";
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

// RezeroDeps.gravity: mean gravity, or undefined when the IMU is absent.
// device.getGravity throws ("IMU not present", or a burst-read failure) --
// exactly the same fallible read set_north_zero and characterize_imu already
// make (imu-tools.ts) -- so this reuses that same call and turns the throw
// into the `undefined` the rezero math already treats as "unmeasurable".
export function buildRezeroGravity(device: Device): () => Promise<Vec3 | undefined> {
  return async () => {
    try { return await device.getGravity(100); }
    catch { return undefined; }
  };
}

// RezeroDeps.posture: the same live pan/tilt read used throughout geo-tools.ts
// and imu-tools.ts, narrowed to the {panDeg, tiltDeg} shape the rezero math
// needs (dropping `moving`, which onReboot/rezeroFromEnu don't consume).
export function buildRezeroPosture(device: Device, cfg: Config): () => Promise<{ panDeg: number; tiltDeg: number }> {
  return async () => {
    const { panDeg, tiltDeg } = currentUserPanTilt(device, cfg);
    return { panDeg, tiltDeg };
  };
}

// RezeroDeps.aircraftEnu: turns a currently-visible ADS-B hex into a
// rig-relative ENU vector, or undefined when it can't be used as a re-zero
// reference. Reuses the same rig-location + aircraftGeodetic + enuPosition
// path enrichAircraft (adsb/enrich.ts) uses to get azimuth/elevation/range,
// and the same seenPosSec-vs-trackMaxTargetAgeMs staleness threshold
// isTrackable (adsb-tools.ts) applies -- undefined covers every case
// rezero_from_aircraft's error text promises: not visible (no match, or no
// rig location to measure from), or a stale/unknown position report.
export function buildRezeroAircraftEnu(
  source: AdsbSource, store: CalibrationStore, cfg: Config,
): (hex: string) => Promise<Vec3 | undefined> {
  return async (hex: string) => {
    const rig = store.get().rig;
    if (!rig) return undefined;
    const wanted = hex.toLowerCase();
    const ac = source.getSnapshot().aircraft.find((a) => a.hex === wanted);
    if (!ac) return undefined;
    const maxAgeSec = cfg.trackMaxTargetAgeMs / 1000;
    if (ac.seenPosSec === null || ac.seenPosSec > maxAgeSec) return undefined;
    const g = aircraftGeodetic(ac, cfg.adsbAltSource);
    if (!g) return undefined;
    return enuPosition(rig, g);
  };
}

// Timeout/host-fallback mirrors dashboard/rig.ts's RigDirectClient.status():
// try each configured host in turn, swallow per-host failures, and give up
// silently rather than throw -- the poll loop below must never let a network
// fault escape into the interval (see main()'s statusPoll comment). Not built
// on RigDirectClient itself because RigDirect (dashboard/parse.ts) doesn't
// carry uptime_ms -- the one field this poll actually needs -- and widening
// that shared, well-tested type for a single caller isn't worth it.
const STATUS_POLL_TIMEOUT_MS = 3000;
export async function fetchDeviceUptimeMs(cfg: Config): Promise<number | undefined> {
  const hosts = [cfg.deviceHost, ...(cfg.deviceIpFallback ? [cfg.deviceIpFallback] : [])];
  for (const h of hosts) {
    try {
      const r = await fetch(`http://${h}/api/status`, { signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS) });
      if (!r.ok) continue;
      const body = (await r.json()) as Record<string, unknown>;
      if (typeof body.uptime_ms === "number" && Number.isFinite(body.uptime_ms)) return body.uptime_ms;
    } catch { /* try next host */ }
  }
  return undefined;
}

export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
  sectorStore: SectorStore, capture: CaptureController, limitsStore: LimitsStore,
  boot: BootWatcher,
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
        registerTrackTools(server, session, supervisor, store);
        registerSunTools(server, device, cfg, store, supervisor);
        registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore);
        registerSectorTools(server, sectorStore);
        registerLimitsTools(server, device, cfg, limitsStore);
        registerRezeroTools(server, {
          calib: store, limits: limitsStore, boot, cfg,
          gravity: buildRezeroGravity(device),
          posture: buildRezeroPosture(device, cfg),
          aircraftEnu: buildRezeroAircraftEnu(source, store, cfg),
        });
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
  const bootFile = cfg.bootFile ?? join(homedir(), ".tb3-mcp", "boot.json");
  const boot = new BootWatcher(bootFile);
  boot.load();
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

  // Boot-watch poll: the firmware doesn't persist step position (see
  // boot-watch.ts's module doc), so the only way to notice a reboot is to
  // keep asking it how long it's been up. 5s beats every real power cycle by
  // a wide margin without hammering the device.
  //
  // observe() runs on EVERY successful read, not just when a reboot looks
  // likely -- it's what maintains lastUptimeMs/lastSeenAtMs for the
  // wasDownAcross check (the case that catches an MCP-daemon restart that
  // itself crossed a device power cycle). onReboot only fires when observe()
  // actually returns true.
  //
  // Both failure modes this must survive: (1) the device is unreachable
  // (routine on WiFi -- fetchDeviceUptimeMs already swallows that and
  // resolves undefined, so there's nothing to observe this tick), and (2) a
  // read is still in flight when the next tick fires (pollInFlight guards
  // that) -- neither may throw into the interval or stack overlapping reads,
  // or this reinstates the exact "reboot went unnoticed" bug the feature
  // exists to fix.
  const rezeroGravity = buildRezeroGravity(device);
  const rezeroPosture = buildRezeroPosture(device, cfg);
  let pollInFlight = false;
  const statusPollTimer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    (async () => {
      const uptimeMs = await fetchDeviceUptimeMs(cfg);
      if (uptimeMs === undefined) return;   // device unreachable this tick -- nothing to observe
      const rebooted = boot.observe(uptimeMs, Date.now());
      if (!rebooted) return;
      const outcome = await onReboot({
        calib: store, limits: limitsStore, boot, geoPanSign: cfg.geoPanSign,
        gravity: rezeroGravity, posture: rezeroPosture, bootId: boot.bootId(),
      });
      if (outcome.applied) {
        console.log(
          `[tb3-mcp] reboot detected (boot ${boot.bootId()}) -- tilt re-zeroed automatically: ` +
          `Δtilt ${outcome.deltaTiltDeg?.toFixed(2)}° (residual ${outcome.residualDeg?.toFixed(2)}°). ` +
          "Pan limits cleared and needsRezero is set -- rezero_from_landmark or rezero_from_aircraft " +
          "is required before automated pan/tilt motion resumes.",
        );
      } else {
        console.log(
          `[tb3-mcp] reboot detected (boot ${boot.bootId()}) -- automatic tilt re-zero NOT applied: ` +
          `${outcome.reason}. needsRezero is set -- rezero_from_landmark or rezero_from_aircraft is ` +
          "required before automated pan/tilt motion resumes.",
        );
      }
    })()
      .catch((e) => console.error("[tb3-mcp] boot-watch status poll failed:", e))
      .finally(() => { pollInFlight = false; });
  }, 5000);
  // statusPollTimer is intentionally not cleared anywhere: main() has no
  // shutdown/close path (no SIGTERM/SIGINT handler, no server.close()) for
  // any of this process's intervals -- see task-7-report.md.

  const app = buildApp(
    device, cfg, store, session, supervisor, source, follower, sectorStore, capture, limitsStore, boot,
  );
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
