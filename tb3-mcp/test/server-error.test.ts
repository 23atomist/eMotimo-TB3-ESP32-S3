import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { AdsbSource } from "../src/adsb/source.js";
import { AdsbFollower } from "../src/adsb/follower.js";
import { SectorStore } from "../src/sector-store.js";
import { LimitsStore } from "../src/limits-store.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";
import { FrameSource } from "../src/vision/frame-source.js";
import { DetectorClient } from "../src/vision/detector-client.js";
import { SizeGuardedDetector, VisionRuntime } from "../src/vision-tools.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";

function fakeCapture(): CaptureController {
  const deps: CaptureDeps = {
    setRecord: async () => {},
    snapshot: async (icao) => `/tmp/${icao}.jpg`,
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
  return new CaptureController(deps, { debounceMs: 5000, autoEnabled: true });
}

// buildApp's vision args: never started (no real camera/detector in this
// test), so latest() always returns null and the guarded detector never
// gets a live server to call.
function fakeFrames(): FrameSource {
  return { latest: () => null, start() {}, stop() {} };
}
function fakeDetector(): SizeGuardedDetector {
  return new SizeGuardedDetector(new DetectorClient("http://127.0.0.1:1/detect", 100), {
    expectedSizePx: () => ({ widthPx: 0, heightPx: 0 }),
  });
}
function fakeVisionRuntime(cfg: Config): VisionRuntime {
  return new VisionRuntime(cfg);
}

// Force a synchronous throw inside the POST /mcp initialize path (registerTools
// runs before server.connect(transport)) so we can prove the handler converts
// it into a clean JSON-RPC 500 instead of an unhandled promise rejection that
// could crash the whole daemon and drop every other live MCP session.
vi.mock("../src/tools.js", () => ({
  registerTools: () => {
    throw new Error("boom: simulated registerTools failure");
  },
}));

const DEV_PORT = 8796;
const MCP_PORT = 8797;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let httpServer: Server | null = null;

afterEach(async () => {
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r())); httpServer = null;
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

describe("server error handling", () => {
  it("returns a JSON-RPC 500 (not an unhandled rejection) when a handler throws", async () => {
    mock = new MockTb3(); await mock.start(DEV_PORT);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${DEV_PORT}`, TB3_MCP_PORT: String(MCP_PORT) });
    dev = new Device(cfg); dev.start();
    await new Promise((r) => setTimeout(r, 200));

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "calibration.json"));
    const session = new TrackingSession(dev, cfg, store);
    const supervisor = new SunSupervisor(dev, cfg, store, session);
    const follower = new AdsbFollower(session, cfg.adsbAltSource, cfg.adsbLostSec * 1000);
    const source = new AdsbSource(cfg); // not started; adsbEnabled defaults false
    const sectorStore = new SectorStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "sector.json"));
    sectorStore.load();
    const limitsStore = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "limits.json"));
    limitsStore.load();
    const app = buildApp(
      dev, cfg, store, session, supervisor, source, follower, sectorStore, fakeCapture(), limitsStore,
      fakeFrames(), fakeDetector(), fakeVisionRuntime(cfg),
    );
    await new Promise<void>((r) => { httpServer = app.listen(MCP_PORT, r); });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "error-test", version: "1.0.0" },
          },
        }),
      });

      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32603);
      expect(body.id).toBeNull();

      // Give any (incorrectly) unhandled rejection a tick to surface.
      await new Promise((res) => setTimeout(res, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
