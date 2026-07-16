import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerGeoTools } from "../src/geo-tools.js";
import { CalibrationStore } from "../src/calibration.js";

const PORT = 8795;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let dir: string | null = null;

async function harness() {
  dir = mkdtempSync(join(tmpdir(), "tb3geo-"));
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const store = new CalibrationStore(join(dir, "calibration.json"));
  store.load();
  const server = new McpServer({ name: "tb3-geo", version: "test" });
  registerGeoTools(server, dev, cfg, store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("geo tools — state/query", () => {
  it("sight_landmark refuses before a rig location is set", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "sight_landmark",
      arguments: { lat: 45, lon: 10, height_m: 500 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rig location/i);
  });

  it("set_rig_location then sight_landmark captures current pan/tilt", async () => {
    const { client } = await harness();
    mock!.setPosition(20 * 444.444, 5 * 444.444); // pan=20°, tilt=5°
    await new Promise((r) => setTimeout(r, 200));

    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    const res: any = await client.callTool({
      name: "sight_landmark",
      arguments: { lat: 46, lon: 11, height_m: 800, label: "peak" },
    });
    const body = JSON.parse(textOf(res));
    expect(body.slot).toBe(1);
    expect(body.pan_deg).toBeCloseTo(20, 0);
    expect(body.tilt_deg).toBeCloseTo(5, 0);
  });

  it("get_calibration and clear_calibration reflect state", async () => {
    const { client } = await harness();
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    let res: any = await client.callTool({ name: "get_calibration", arguments: {} });
    let body = JSON.parse(textOf(res));
    expect(body.calibrated).toBe(false);
    expect(body.rig).toEqual({ lat: 45, lon: 10, height: 100 });

    await client.callTool({ name: "clear_calibration", arguments: {} });
    res = await client.callTool({ name: "get_calibration", arguments: {} });
    body = JSON.parse(textOf(res));
    expect(body.rig).toBeUndefined();
    expect(body.calibrated).toBe(false);
  });
});
