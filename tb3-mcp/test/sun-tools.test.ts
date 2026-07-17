import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { registerSunTools } from "../src/sun-tools.js";

const PORT = 8801;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function harness() {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  const filepath = `/tmp/tb3-suntest-${Math.random().toString(36).slice(2, 9)}.json`;
  const store = new CalibrationStore(filepath); store.load();
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerSunTools(server, dev, cfg, store);
  const client = new Client({ name: "c", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store };
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("get_sun", () => {
  it("reports sun az/el and the assumed UTC", async () => {
    const { client, store } = await harness();
    // Set rig location (but not orientation, so uncalibrated).
    store.setRigLocation(40.7128, -74.0060, 10); // NYC
    const res = await client.callTool({ name: "get_sun", arguments: {} });
    const p = JSON.parse(textOf(res));
    expect(typeof p.azimuth_deg).toBe("number");
    expect(typeof p.elevation_deg).toBe("number");
    expect(typeof p.assumed_utc).toBe("string");
    // Uncalibrated → no boresight separation.
    expect(p.boresight_separation_deg).toBeNull();
    expect(p.calibrated).toBe(false);
  });

  it("returns nulls and false when uncalibrated (no rig location set)", async () => {
    const { client } = await harness();
    // Do NOT call store.setRigLocation - test the fail-safe path
    const res = await client.callTool({ name: "get_sun", arguments: {} });
    const p = JSON.parse(textOf(res));
    // All fields must be null or false per the fail-safe branch
    expect(p.azimuth_deg).toBeNull();
    expect(p.elevation_deg).toBeNull();
    expect(p.above_horizon).toBeNull();
    expect(p.rig_location_set).toBe(false);
    expect(p.boresight_separation_deg).toBeNull();
    expect(p.calibrated).toBe(false);
  });
});
