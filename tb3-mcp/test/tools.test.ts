import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/tools.js";

const PORT = 8793;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function harness(env: Record<string, string> = {}) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, ...env });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerTools(server, dev, cfg);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("MCP tools", () => {
  it("lists all 8 tools", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_status", "goto_angle", "jog", "list_programs",
      "select_program", "set_home", "stop", "trigger_camera",
    ]);
  });

  it("get_status reports position in degrees", async () => {
    const client = await harness();
    mock!.setPosition(30 * 444.444, 0);
    await new Promise((r) => setTimeout(r, 200));
    const res = await client.callTool({ name: "get_status", arguments: {} });
    // The mock broadcasts position over the websocket tick rounded to the
    // nearest integer step (Math.round in mock-tb3.ts pushTick), and
    // 30deg * 444.444 steps/deg = 13333.32 is not an integer step count, so
    // the value that round-trips through the tick is ~29.999, not exactly
    // 30. Use a numeric tolerance instead of a strict "30" prefix match.
    const parsed = JSON.parse(textOf(res));
    expect(parsed.pan_deg).toBeCloseTo(30, 1);
  });

  it("goto_angle moves and reports arrival", async () => {
    const client = await harness();
    mock!.setPosition(0, 0);
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(20, 5);
    expect(textOf(res)).toMatch(/arrived|pan_deg/i);
  });

  it("goto_angle refuses an out-of-limit target", async () => {
    const client = await harness();
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 999, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outside the allowed range/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("goto_angle applies pan_sign to reach device frame", async () => {
    const client = await harness({ TB3_PAN_SIGN: "-1" });
    mock!.setPosition(0, 0);
    await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(-20, 5); // user +20 → device -20
  });

  it("jog maps dps to joystick units", async () => {
    const client = await harness(); // maxJogDps default 20
    await client.callTool({ name: "jog", arguments: { pan_dps: 20, tilt_dps: 0, duration_ms: 150 } });
    // full-scale: 20/20*100 = 100, then zeroed
    await new Promise((r) => setTimeout(r, 50));
    expect(mock!.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("stop, set_home, trigger_camera, select_program reach the device", async () => {
    const client = await harness();
    await client.callTool({ name: "stop", arguments: {} });
    expect(mock!.stopCount).toBe(1);
    await client.callTool({ name: "set_home", arguments: {} });
    expect(mock!.homeCount).toBe(1);
    await client.callTool({ name: "trigger_camera", arguments: { action: "shoot", ms: 120 } });
    expect(mock!.lastCamera).toEqual({ action: "shoot", ms: 120 });
    await client.callTool({ name: "select_program", arguments: { index: 2, commit: true } });
    expect(mock!.lastProgram).toEqual({ type: 2, select: true });
  });
});
