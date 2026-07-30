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
import { LimitsStore } from "../src/limits-store.js";
import { registerLimitsTools, applyTeachLimit } from "../src/limits-tools.js";

const STEPS_PER_DEG = 444.444;
const PORT = 8799;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

function store() {
  const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "lt-")), "limits.json"));
  s.load();
  return s;
}

async function harness(env: Record<string, string> = {}) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, ...env });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const s = store();
  const server = new McpServer({ name: "tb3-limits", version: "test" });
  registerLimitsTools(server, dev, cfg, s);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, srv] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(srv), client.connect(c)]);
  return { client, store: s, cfg };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("applyTeachLimit (the teach_limit core)", () => {
  it("accepts a taught limit tighter than config", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});
    const r = applyTeachLimit(s, cfg, "tiltMin", -40);
    expect(r).toEqual({ value: -40, clamped: false });
    expect(s.get().tiltMin).toBe(-40);
  });

  it("clamps a candidate wider than config to the config ceiling", () => {
    const s = store();
    const cfg = loadConfig(undefined, {}); // default panMax 180
    const r = applyTeachLimit(s, cfg, "panMax", 200);
    expect(r).toEqual({ value: 180, clamped: true });
    expect(s.get().panMax).toBe(180);
  });

  it("clamps a below-ceiling candidate on a min edge too", () => {
    const s = store();
    const cfg = loadConfig(undefined, {}); // default tiltMin -90
    const r = applyTeachLimit(s, cfg, "tiltMin", -120);
    expect(r).toEqual({ value: -90, clamped: true });
  });

  it("refuses (without persisting) a candidate that would invert the axis", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});
    s.setEdge("panMax", 10);
    const r = applyTeachLimit(s, cfg, "panMin", 10.5);
    expect("error" in r).toBe(true);
    expect(s.get().panMin).toBeUndefined(); // nothing persisted
  });

  it("clear then re-teach recovers from a would-be lockout", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});
    s.setEdge("panMin", 50);
    s.setEdge("panMax", 60);
    s.clear();
    const r = applyTeachLimit(s, cfg, "panMin", -10);
    expect(r).toEqual({ value: -10, clamped: false });
  });
});

describe("MCP limits tools", () => {
  it("teach_limit captures the current position for the named edge", async () => {
    const { client, store: s } = await harness();
    mock!.setPosition(30 * STEPS_PER_DEG, -10 * STEPS_PER_DEG);
    await new Promise((r) => setTimeout(r, 200));
    const res = await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.value_deg).toBeCloseTo(30, 0);
    expect(parsed.clamped).toBe(false);
    expect(s.get().panMax).toBeCloseTo(30, 0);
  });

  it("teach_limit on tilt_min reads the tilt axis, not pan", async () => {
    const { client, store: s } = await harness();
    mock!.setPosition(0, -15 * STEPS_PER_DEG);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "tilt_min" } });
    expect(s.get().tiltMin).toBeCloseTo(-15, 0);
    expect(s.get().panMin).toBeUndefined();
  });

  it("teach_limit reports a clamp when the position exceeds the config ceiling", async () => {
    // tiltMax configured to 10 -- well inside where the mock can actually sit,
    // so we can drive the rig past it and observe the clamp.
    const { client } = await harness({ TB3_TILT_MAX: "10" });
    mock!.setPosition(0, 45 * STEPS_PER_DEG);
    await new Promise((r) => setTimeout(r, 200));
    const res = await client.callTool({ name: "teach_limit", arguments: { edge: "tilt_max" } });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.clamped).toBe(true);
    expect(parsed.value_deg).toBeCloseTo(10, 0);
  });

  it("get_taught_limits reports taught, config_ceiling, and effective", async () => {
    const { client, store: s } = await harness();
    s.setEdge("tiltMin", -30);
    const res = await client.callTool({ name: "get_taught_limits", arguments: {} });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.taught.tilt_min).toBe(-30);
    expect(parsed.taught.pan_min).toBeNull();
    expect(parsed.config_ceiling.tilt_min).toBe(-90);
    expect(parsed.effective.tilt_min).toBe(-30);
    expect(parsed.effective.pan_min).toBe(-180);
  });

  it("clear_taught_limits reverts effective back to the config ceiling", async () => {
    const { client, store: s } = await harness();
    s.setEdge("tiltMin", -30);
    await client.callTool({ name: "clear_taught_limits", arguments: {} });
    expect(s.get()).toEqual({ version: 1 });
    const res = await client.callTool({ name: "get_taught_limits", arguments: {} });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.effective.tilt_min).toBe(-90);
  });
});

// FIELD BUG 2026-07-29. The operator taught, in this order: tilt_min at the
// bottom stop, tilt_max at the top, pan_max at the right, pan_min at the left
// -- the natural mental model. On this rig the user frame runs the other way
// on those axes, so half the captures arrived inverted, the second of each
// pair was REFUSED, and the rig was left half-taught and parked outside its
// own effective range. Combined with limitGuard's membership-only test (see
// test/control.test.ts) that produced a total lockout: it would not move at
// all until the limits were cleared.
//
// Both captures were correct as POSITIONS; only the labels were swapped. So
// the pair is now assigned by value instead of being refused.
describe("teach_limit with an inverted axis (field bug 2026-07-29)", () => {
  it("assigns the pair by value when the second capture lands on the far side of the first", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});

    // "tilt_min at the bottom" -- but bottom reads HIGH on this rig.
    const a = applyTeachLimit(s, cfg, "tiltMin", 40);
    expect("error" in a).toBe(false);

    // "tilt_max at the top" -- top reads LOW. Previously refused outright.
    const b = applyTeachLimit(s, cfg, "tiltMax", -30);
    expect("error" in b).toBe(false);
    expect((b as { swappedWith?: string }).swappedWith).toBe("tiltMin");

    // Both ends survive, assigned by value rather than by label.
    expect(s.get().tiltMin).toBe(-30);
    expect(s.get().tiltMax).toBe(40);
  });

  it("does not silently accept a degenerate pair", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});
    applyTeachLimit(s, cfg, "panMin", 10);
    const r = applyTeachLimit(s, cfg, "panMax", 9.5); // inverted AND < MIN_SPAN apart
    expect("error" in r).toBe(true);
    expect(s.get().panMax).toBeUndefined();
    expect(s.get().panMin).toBe(10); // the first capture is left untouched
  });

  it("leaves a correctly-ordered pair exactly as taught (no spurious swapping)", () => {
    const s = store();
    const cfg = loadConfig(undefined, {});
    applyTeachLimit(s, cfg, "panMin", -60);
    const r = applyTeachLimit(s, cfg, "panMax", 75);
    expect((r as { swappedWith?: string }).swappedWith).toBeUndefined();
    expect(s.get().panMin).toBe(-60);
    expect(s.get().panMax).toBe(75);
  });
});
