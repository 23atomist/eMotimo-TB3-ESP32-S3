import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { registerTrackTools } from "../src/track-tools.js";

// Ports 8791-8798 are already taken by other test files (mock-tb3, device,
// tools, server, geo-tools, server-error, device-jog). Do not reuse them.
const PORT = 8799;
const RIG = { lat: 45, lon: 10, height: 0 };
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

let mock: MockTb3; let device: Device; let client: Client; let store: CalibrationStore;
let supervisor: SunSupervisor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

// supervisorNowMs, when given, freezes the supervisor's clock far ahead of the
// device's telemetry timestamp so a single tickForTest() trips telemetry_stale
// (a fault, hence locked) without needing a real sun-aligned boresight fixture.
async function harness(calibrated = true, supervisorNowMs?: number) {
  mock = new MockTb3();
  await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  device = new Device(cfg);
  device.start();
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-tt-")), "cal.json"));
  store.load();
  if (calibrated) {
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I as never, new Date(0).toISOString());
  }
  const session = new TrackingSession(device, cfg, store);
  // Unstarted (no timer) — matches every other harness that constructs a
  // SunSupervisor for tool-gating tests; only isSunLocked()'s flag matters.
  supervisor = new SunSupervisor(
    device, cfg, store, session,
    supervisorNowMs !== undefined ? () => supervisorNowMs : undefined,
  );
  const server = new McpServer({ name: "t", version: "0" });
  registerTrackTools(server, session, supervisor);
  client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  await sleep(150);
  return session;
}

afterEach(async () => { device?.close(); await mock?.stop(); });

describe("track tools", () => {
  it("registers exactly the four tracking tools", async () => {
    await harness();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_tracking_status", "start_tracking", "stop_tracking", "update_target"]);
  });

  it("start_tracking refuses without a calibration", async () => {
    await harness(false);
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/calibrat/i);
  });

  it("start_tracking begins a session and reports state", async () => {
    const session = await harness();
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0, speed_mps: 100, heading_deg: 90, label: "test" },
    });
    expect(r.isError ?? false).toBe(false);
    expect(session.isActive()).toBe(true);
    session.stop();
  });

  it("start_tracking returns immediately (it does not block to arrival)", async () => {
    const session = await harness();
    const t0 = Date.now();
    await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(Date.now() - t0).toBeLessThan(500);
    session.stop();
  });

  it("update_target before start_tracking is refused", async () => {
    await harness();
    const r: any = await client.callTool({
      name: "update_target",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not tracking/i);
  });

  it("get_tracking_status reports pointing error and state", async () => {
    const session = await harness();
    await client.callTool({ name: "start_tracking", arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 } });
    await sleep(300);
    const r: any = await client.callTool({ name: "get_tracking_status", arguments: {} });
    const body = JSON.parse(textOf(r));
    expect(["acquiring", "tracking", "waiting"]).toContain(body.state);
    expect(body).toHaveProperty("pointing_error_deg");
    expect(body).toHaveProperty("target_range_m");
    session.stop();
  });

  it("stop_tracking ends the session", async () => {
    const session = await harness();
    await client.callTool({ name: "start_tracking", arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 } });
    await client.callTool({ name: "stop_tracking", arguments: {} });
    expect(session.isActive()).toBe(false);
  });

  it("rejects an out-of-band height", async () => {
    await harness();
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 500000 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/height_m/i);
  });

  // C-1 (belt): start_tracking/update_target must be gated by the sun lockout —
  // a track begun while parked/parking/fault would otherwise slew the rig
  // toward the sun via the goto reacquire path, which the jog latch does not
  // cover. Trip the guard via stale telemetry (no sun-aligned fixture needed)
  // and confirm both tools refuse, no session starts, and no goto is issued.
  // Pre-fix (ungated) this would start tracking successfully — non-vacuous.
  it("start_tracking and update_target refuse while the sun guard is locked, and issue no goto", async () => {
    const session = await harness(true, Date.now() + 60_000);
    supervisor.tickForTest(); // now() far ahead of device telemetry -> stale -> fault -> locked
    expect(supervisor.isSunLocked()).toBe(true);

    const r1: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/sun guard active/);
    expect(session.isActive()).toBe(false);
    expect(mock!.lastGoto).toBeNull();

    const r2: any = await client.callTool({
      name: "update_target",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/sun guard active/);
  });

  it("get_tracking_status and stop_tracking are NOT gated by the sun lockout", async () => {
    await harness(true, Date.now() + 60_000);
    supervisor.tickForTest();
    expect(supervisor.isSunLocked()).toBe(true);

    const statusR: any = await client.callTool({ name: "get_tracking_status", arguments: {} });
    expect(statusR.isError ?? false).toBe(false);

    const stopR: any = await client.callTool({ name: "stop_tracking", arguments: {} });
    expect(stopR.isError ?? false).toBe(false);
  });
});
