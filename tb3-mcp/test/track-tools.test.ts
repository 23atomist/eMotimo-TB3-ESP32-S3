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
import { registerTrackTools } from "../src/track-tools.js";

// Ports 8791-8798 are already taken by other test files (mock-tb3, device,
// tools, server, geo-tools, server-error, device-jog). Do not reuse them.
const PORT = 8799;
const RIG = { lat: 45, lon: 10, height: 0 };
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

let mock: MockTb3; let device: Device; let client: Client; let store: CalibrationStore;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

async function harness(calibrated = true) {
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
  const server = new McpServer({ name: "t", version: "0" });
  registerTrackTools(server, session);
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
});
