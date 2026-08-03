import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { rezeroGuard, registerRezeroTools } from "../src/rezero-tools.js";
import { registerTools } from "../src/tools.js";
import { registerGeoTools } from "../src/geo-tools.js";
import { registerTrackTools } from "../src/track-tools.js";
import { registerAdsbTools } from "../src/adsb-tools.js";
import { registerLimitsTools } from "../src/limits-tools.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { AdsbSource } from "../src/adsb/source.js";
import { AdsbFollower } from "../src/adsb/follower.js";
import { SectorStore } from "../src/sector-store.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";

function calib(): CalibrationStore {
  const s = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "calibration.json"));
  s.load();
  return s;
}

// Rig at the origin, identity orientation: due-north puts pan/tilt at ~0, the
// same fixture test/track-tools.test.ts uses so tracking settles quickly.
const RIG = { lat: 45, lon: 10, height: 0 };
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rezeroGuard", () => {
  it("passes when the origin is known", () => {
    expect(rezeroGuard(calib())).toBeUndefined();
  });

  it("blocks when a re-zero is pending, and says how to fix it", () => {
    const c = calib();
    c.markRezeroNeeded(2);
    const msg = rezeroGuard(c);
    expect(msg).toBeDefined();
    expect(msg).toMatch(/rezero_from_landmark/);
  });
});

// Integration-level wiring: confirms the four automated-motion tools actually
// call rezeroGuard (not just that the guard function itself works in
// isolation), and that jog/teach_limit deliberately do NOT — see
// task-6-brief.md. Registers the REAL tool-registration functions (not a
// reimplementation of the handlers) against an in-memory MCP transport, same
// convention as test/geo-tools.test.ts and test/track-tools.test.ts.
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

const PORT = 8804;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

async function harness(): Promise<{ client: Client; store: CalibrationStore; session: TrackingSession }> {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3rzg-")), "calibration.json"));
  store.load();
  const session = new TrackingSession(dev, cfg, store);
  const supervisor = new SunSupervisor(dev, cfg, store, session);
  const follower = new AdsbFollower(session, cfg.adsbAltSource, cfg.adsbLostSec * 1000);
  const source = new AdsbSource(cfg); // not started; adsbEnabled defaults false
  const sectorStore = new SectorStore(join(mkdtempSync(join(tmpdir(), "tb3rzg-")), "sector.json"));
  sectorStore.load();
  const limitsStore = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3rzg-")), "limits.json"));
  limitsStore.load();
  const bootWatcher = new BootWatcher(join(mkdtempSync(join(tmpdir(), "tb3rzg-")), "boot.json"));
  bootWatcher.load();

  const server = new McpServer({ name: "tb3-rezero-gating", version: "test" });
  registerTools(server, dev, cfg, session, supervisor, store, fakeCapture(), limitsStore);
  registerGeoTools(server, dev, cfg, store, session, supervisor, source, limitsStore);
  registerTrackTools(server, session, supervisor, store);
  registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore);
  registerLimitsTools(server, dev, cfg, limitsStore);
  // get_rezero_status (below) needs this registered too -- no real gravity/
  // posture/aircraft path is exercised by these tests, so those deps are
  // stubbed, same as test/rezero-mcp-tools.test.ts's own harness.
  registerRezeroTools(server, {
    calib: store, limits: limitsStore, boot: bootWatcher, cfg,
    gravity: async () => undefined,
    posture: async () => ({ panDeg: 0, tiltDeg: 0, moving: false, staleMs: 0 }),
    aircraftEnu: async () => undefined,
    session, supervisor,
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store, session };
}

describe("automated motion refuses while a re-zero is pending", () => {
  it("point_at refuses and names rezero_from_landmark", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rezero_from_landmark/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("point_at_azel refuses and names rezero_from_landmark", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "point_at_azel", arguments: { azimuth_deg: 5, elevation_deg: 3 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rezero_from_landmark/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("start_tracking refuses and names rezero_from_landmark", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "start_tracking", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rezero_from_landmark/);
  });

  it("track_aircraft refuses and names rezero_from_landmark", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "track_aircraft", arguments: { hex: "a1b2c3" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rezero_from_landmark/);
  });

  it("jog is NOT gated — the operator must be able to drive to the landmark", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, aux: 0, duration_ms: 50 },
    });
    expect(res.isError ?? false).toBe(false);
  });

  it("teach_limit is NOT gated — the operator must be able to re-teach limits", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({
      name: "teach_limit", arguments: { edge: "pan_min" },
    });
    expect(res.isError ?? false).toBe(false);
  });

  it("with no re-zero pending, the ordinary 'not calibrated' precondition still fires (no false-positive gating)", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not calibrated/i);
    expect(textOf(res)).not.toMatch(/rezero_from_landmark/);
  });
});

// Finding I4: rezeroGuard is only called at the four automated-motion tool
// entry points above. A session already tracking when a reboot happens is
// NEVER re-checked at any of those entry points -- it just keeps ticking --
// and its deadman is refreshed by AdsbFollower.onSnapshot from the ADS-B poll,
// independent of whether the device itself is even connected. So it survives
// the outage and resumes commanding jog vectors, on the stale calibration,
// the moment the WebSocket reconnects. This section proves the fix is in
// tick() itself, not just at the entry points: it drives a REAL session
// through a REAL start_tracking call, confirms it is actually commanding the
// mock rig, marks a re-zero pending mid-flight (exactly what onReboot() does
// on a real reboot), and confirms the session parks and stays parked -- it
// must not self-resume once telemetry/device state look healthy again.
describe("an in-flight tracking session parks when a re-zero comes due mid-session", () => {
  it("parks, stops commanding, and does not self-resume", async () => {
    const { client, store, session } = await harness();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I as never, new Date(0).toISOString());

    const start: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(start.isError ?? false).toBe(false);

    // Non-vacuous: let the real (10Hz) tick loop actually drive the mock rig
    // before the fault, so this isn't parking on a session that was never
    // going to move anyway.
    await sleep(400);
    expect(["acquiring", "tracking"]).toContain(session.status().state);
    const gotoSnapshotBefore = mock!.lastGoto ? { ...mock!.lastGoto } : null;

    // The reboot happens mid-flight -- exactly what onReboot() records.
    store.markRezeroNeeded(1);

    // Several more real ticks with the guard now tripped.
    await sleep(400);

    const status = session.status();
    expect(status.state).toBe("waiting");
    expect(status.reason).toBe("rezero_pending");
    // No NEW goto was dispatched, and any standing jog was zeroed rather than
    // driven -- this is the "no device command issued" assertion, expressed
    // against this harness's real mock instead of an illustrative stub.
    expect(mock!.lastGoto).toEqual(gotoSnapshotBefore);
    expect(mock!.lastJog).toEqual({ x: 0, y: 0, aux: 0 });

    // Self-resume check: telemetry keeps arriving fresh and the device keeps
    // reporting healthy, yet the session must stay parked -- only a completed
    // re-zero (or an operator stop/restart) may clear it.
    await sleep(300);
    expect(session.status().state).toBe("waiting");
    expect(session.status().reason).toBe("rezero_pending");

    session.stop();
  });
});

// SunSupervisor is deliberately NOT gated by rezeroGuard (it would remove sun
// protection outright rather than degrade it -- see task-6-brief.md), so the
// operator must be told through get_rezero_status instead: both in the
// payload an agent reads and in the tool description a human reads before
// invoking it.
describe("get_rezero_status reports the sun guard as degraded while a re-zero is pending", () => {
  it("says so in the payload when a re-zero is pending", async () => {
    const { client, store } = await harness();
    store.markRezeroNeeded(1);
    const res: any = await client.callTool({ name: "get_rezero_status", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    const body = textOf(res);
    expect(body).toMatch(/sun/i);
    expect(body).toMatch(/degraded/i);
    expect(JSON.parse(body).needs_rezero).toBe(true);
  });

  it("does not claim degradation when no re-zero is pending", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "get_rezero_status", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body.needs_rezero).toBe(false);
    expect(body.sun_guard.degraded).toBe(false);
  });

  it("the registered tool description also documents the degraded sun guard", async () => {
    const { client } = await harness();
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === "get_rezero_status");
    expect(t?.description).toMatch(/sun/i);
    expect(t?.description).toMatch(/degrad/i);
  });
});
