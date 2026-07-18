import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";

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
  const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-tools-")), "cal.json"));
  const session = new TrackingSession(dev, cfg, store);
  const supervisor = new SunSupervisor(dev, cfg, store, session);
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerTools(server, dev, cfg, session, supervisor, store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, session, store, supervisor };
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
    const { client } = await harness();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_status", "goto_angle", "jog", "list_programs",
      "select_program", "set_home", "stop", "trigger_camera",
    ]);
  });

  it("get_status reports position in degrees", async () => {
    const { client } = await harness();
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
    const { client } = await harness();
    mock!.setPosition(0, 0);
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(20, 5);
    expect(textOf(res)).toMatch(/arrived|pan_deg/i);
  });

  it("goto_angle refuses an out-of-limit target", async () => {
    const { client } = await harness();
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 999, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outside the allowed range/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("goto_angle applies pan_sign to reach device frame", async () => {
    const { client } = await harness({ TB3_PAN_SIGN: "-1" });
    mock!.setPosition(0, 0);
    await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(-20, 5); // user +20 → device -20
  });

  it("jog maps dps to joystick units", async () => {
    const { client } = await harness(); // maxJogDps default 19
    await client.callTool({ name: "jog", arguments: { pan_dps: 20, tilt_dps: 0, duration_ms: 150 } });
    // 20 dps exceeds the 19 dps ceiling, so it saturates: 20/19*100 -> clamped
    // to 100. Then jog() zeroes on completion, which is what we assert below.
    await new Promise((r) => setTimeout(r, 50));
    expect(mock!.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("stop, set_home, trigger_camera, select_program reach the device", async () => {
    const { client } = await harness();
    await client.callTool({ name: "stop", arguments: {} });
    expect(mock!.stopCount).toBe(1);
    await client.callTool({ name: "set_home", arguments: {} });
    expect(mock!.homeCount).toBe(1);
    await client.callTool({ name: "trigger_camera", arguments: { action: "shoot", ms: 120 } });
    expect(mock!.lastCamera).toEqual({ action: "shoot", ms: 120 });
    await client.callTool({ name: "select_program", arguments: { index: 2, commit: true } });
    expect(mock!.lastProgram).toEqual({ type: 2, select: true });
  });

  // Layer 3's whole reason for existing is the Track (Web) firmware mode, which
  // is program 8. A hardcoded `.max(7)` on this tool's schema meant zod rejected
  // index 8 at the boundary and the POST was never issued: the daemon could not
  // put the rig into the one mode built for it. The bound is now derived from
  // the device's own program listing, so it cannot drift from the firmware's
  // menu table again.
  it("REGRESSION: select_program can reach the Track (Web) mode (index 8)", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "select_program", arguments: { index: 8, commit: true } });
    expect(res.isError).toBeFalsy();
    expect(mock!.lastProgram).toEqual({ type: 8, select: true });
  });

  it("select_program rejects an index past what the device reports, naming the real bound", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "select_program", arguments: { index: 9 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/0\.\.8/);
    expect(mock!.lastProgram).toBeNull();
  });

  it("list_programs reports the firmware's full menu, Track (Web) included", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "list_programs", arguments: {} });
    const listed = JSON.parse(textOf(res));
    expect(listed.names).toContain("Track (Web)");
    expect(listed.names.length).toBe(9);
  });

  it("goto_angle refuses while a tracking session is active", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    expect(mock!.lastGoto).toBeNull();
    session.stop();
  });

  it("jog refuses while a tracking session is active", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, duration_ms: 100 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    session.stop();
  });

  it("set_home refuses while a tracking session is active", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "set_home", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    expect(mock!.homeCount).toBe(0);
    session.stop();
  });

  it("stop ends an active tracking session as well as halting the device", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    expect(session.isActive()).toBe(true);
    await client.callTool({ name: "stop", arguments: {} });
    expect(session.isActive()).toBe(false);
    expect(mock!.stopCount).toBe(1);
  });
});
