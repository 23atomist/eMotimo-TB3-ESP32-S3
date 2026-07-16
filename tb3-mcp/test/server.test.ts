import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { CalibrationStore } from "../src/calibration.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV_PORT = 8794;
const MCP_PORT = 8795;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let httpServer: Server | null = null;

afterEach(async () => {
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r())); httpServer = null;
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

describe("server", () => {
  it("serves MCP over streamable HTTP and returns tool results", async () => {
    mock = new MockTb3(); await mock.start(DEV_PORT);
    mock.setPosition(45 * 444.444, 0);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${DEV_PORT}`, TB3_MCP_PORT: String(MCP_PORT) });
    dev = new Device(cfg); dev.start();
    await new Promise((r) => setTimeout(r, 300));

    const app = buildApp(dev, cfg, new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "calibration.json")));
    await new Promise<void>((r) => { httpServer = app.listen(MCP_PORT, r); });

    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(15); // 8 base tools + 7 geo tools (4 calibration state + solve/point_at/point_at_azel)

    const res: any = await client.callTool({ name: "get_status", arguments: {} });
    expect(res.content[0].text).toMatch(/"pan_deg":\s*45/);

    await transport.close();
  });

  it("rejects requests without a token when a token is configured", async () => {
    mock = new MockTb3(); await mock.start(DEV_PORT);
    const cfg = loadConfig(undefined, {
      TB3_DEVICE_HOST: `127.0.0.1:${DEV_PORT}`, TB3_MCP_PORT: String(MCP_PORT), TB3_MCP_TOKEN: "sekret",
    });
    dev = new Device(cfg); dev.start();
    await new Promise((r) => setTimeout(r, 200));
    const app = buildApp(dev, cfg, new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "calibration.json")));
    await new Promise<void>((r) => { httpServer = app.listen(MCP_PORT, r); });

    const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(r.status).toBe(401);
  });
});
