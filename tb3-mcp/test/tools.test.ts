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
import { registerLimitsTools } from "../src/limits-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";
import { PassJournal } from "../src/capture/pass-journal.js";

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
  const dir = mkdtempSync(join(tmpdir(), "tb3-tools-"));
  const store = new CalibrationStore(join(dir, "cal.json"));
  const limitsStore = new LimitsStore(join(dir, "limits.json"));
  limitsStore.load();
  const session = new TrackingSession(dev, cfg, store);
  const supervisor = new SunSupervisor(dev, cfg, store, session);
  const captureDeps: CaptureDeps = {
    setRecord: async () => {},
    snapshot: async (icao) => `/tmp/${icao}.jpg`,
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
  const capture = new CaptureController(captureDeps, { debounceMs: 5000, autoEnabled: true });
  const journal = new PassJournal(join(dir, "passes.jsonl"));
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerTools(server, dev, cfg, session, supervisor, store, capture, limitsStore, journal);
  registerLimitsTools(server, dev, cfg, limitsStore);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, session, store, supervisor, capture, limitsStore, journal, cfg };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

const STEPS_PER_DEG = 444.444;

// Intercepts every write to mock.lastJog so a test can see EVERY frame sent
// during a jog() call, not just whatever is left once the call has already
// resolved and self-cleared to zero (see device-jog.test.ts's identical
// helper — jog() always ends by clearing the vector, so a bare post-await
// read of mock.lastJog can never distinguish "blocked the whole time" from
// "ran fine and then stopped normally").
function captureJogFrames(m: MockTb3): Array<{ x: number; y: number; aux: number }> {
  const frames: Array<{ x: number; y: number; aux: number }> = [];
  Object.defineProperty(m, "lastJog", {
    configurable: true,
    get: () => frames[frames.length - 1] ?? null,
    set: (v: { x: number; y: number; aux: number }) => { frames.push(v); },
  });
  return frames;
}

describe("MCP tools", () => {
  // 14 from registerTools (13 + list_passes) + 3 from registerLimitsTools (teach/get/clear), both
  // wired into this file's shared harness — the Part 1 jog-guard tests below
  // need teach_limit available on the same server as "jog".
  it("lists all 17 tools", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "capture_snapshot", "clear_taught_limits", "get_capture_status", "get_status",
      "get_taught_limits", "goto_angle", "jog", "list_passes", "list_programs", "select_program",
      "set_capture_mode", "set_home", "start_recording", "stop", "stop_recording",
      "teach_limit", "trigger_camera",
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

  // REGRESSION: duration_ms required .positive(), so the dashboard's
  // press-and-hold jog (dashboard/public/jog-hold.js) posting an explicit
  // (0,0,0) stop vector on release was rejected by THIS tool's own schema on
  // every single release -- an MCP error dialog on every jog release, and
  // the designed "stop right away" behaviour never actually ran (motion
  // only ever stopped via the 500ms jogVectorTtlMs dead-man). duration_ms:0
  // must be accepted, and must actually zero the rig.
  it("REGRESSION: jog accepts duration_ms: 0 as an explicit stop, not rejected", async () => {
    const { client } = await harness();
    mock!.lastJog = { x: 1, y: 1, aux: 1 }; // seed a non-zero value so the assertion below is meaningful
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 0, tilt_dps: 0, duration_ms: 0 } });
    expect(res.isError).toBeFalsy();
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

  // Part 2 requirement: taught travel limits are captured relative to the
  // software zero, exactly like CalibrationStore's orientation/sightings —
  // set_home already clears those (see calibration.ts's invalidateCalibration
  // and the test above it protects) for exactly this reason, and must do the
  // same for taught limits.
  it("set_home clears any taught travel limits (they are relative to the old zero)", async () => {
    const { client, limitsStore } = await harness();
    limitsStore.setEdge("panMax", 30);
    expect(limitsStore.get().panMax).toBe(30);
    const res: any = await client.callTool({ name: "set_home", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/taught travel limits cleared/i);
    expect(limitsStore.get()).toEqual({ version: 1 });
  });
});

// Part 1: the safety-critical fix. Rate jog (device.jog, driven by both the
// dashboard's press-and-hold control and the joystick — see tools.ts's "jog"
// handler doc comment for the traced call path) previously reached the
// device with NO check against panMin/panMax/tiltMin/tiltMax at all: holding
// a direction slewed straight through the software limit into the mechanical
// stop. These tests pin the fix directly at the MCP "jog" tool, the one
// choke point both dashboard control loops actually post through.
describe("jog rate-limit enforcement (Part 1 safety fix)", () => {
  it("rate jog toward a limit the rig is already AT commands zero on that axis", async () => {
    const { client } = await harness();
    mock!.setPosition(30 * STEPS_PER_DEG, 0); // sitting exactly at pan 30
    await new Promise((r) => setTimeout(r, 200));
    const frames = captureJogFrames(mock!);
    // Teach a tighter pan_max right at the current position, then try to
    // keep pushing further in the SAME direction.
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.x).toBe(0); // pan NEVER commanded, not just eventually zeroed
  });

  it("rate jog toward a limit from BEYOND it (already over-travelled) also commands zero", async () => {
    const { client } = await harness({ TB3_PAN_MAX: "30" });
    mock!.setPosition(35 * STEPS_PER_DEG, 0); // already past the configured ceiling
    await new Promise((r) => setTimeout(r, 200));
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, duration_ms: 200 },
    });
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.x).toBe(0);
  });

  // THE TRAP: a naive "am I outside the range" check would also block motion
  // back toward safety. It must not.
  it("rate jog AWAY from a limit is always permitted, even sitting exactly at it", async () => {
    const { client } = await harness();
    mock!.setPosition(30 * STEPS_PER_DEG, 0);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: -10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/held at travel limit/);
    await new Promise((r) => setTimeout(r, 50));
    // The commanded (negative) rate reached the device at least once before
    // jog()'s own trailing zero — same non-zero-then-zero shape
    // device-jog.test.ts's REGRESSION case pins for the unguarded path.
    expect(frames.some((f) => f.x < 0)).toBe(true);
  });

  it("blocks only the offending axis — the other axis keeps its commanded rate", async () => {
    const { client } = await harness();
    mock!.setPosition(30 * STEPS_PER_DEG, 0); // pan at its taught limit, tilt at 0 (wide open)
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 5, duration_ms: 300 },
    });
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    expect(textOf(res)).not.toMatch(/tilt/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.x).toBe(0);          // pan: fully suppressed
    expect(frames.some((f) => f.y > 0)).toBe(true);        // tilt: still commanded
  });

  // Enforcement must use the EFFECTIVE (taught-or-config) limit: the same
  // command that is fine under the bare config ceiling must be caught once a
  // tighter limit is taught.
  it("a taught limit stops rate jog earlier than the bare config limit would", async () => {
    const { client, limitsStore } = await harness(); // config panMax defaults to 180
    mock!.setPosition(170 * STEPS_PER_DEG, 0);
    await new Promise((r) => setTimeout(r, 200));

    // Under the config-only ceiling (180), this command is not even close to
    // the limit and must NOT be blocked.
    const before: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(textOf(before)).not.toMatch(/held at travel limit/);
    // Let the "before" call's own trailing frame finish crossing the loopback
    // socket before the next call starts capturing — otherwise a message
    // still in flight from THIS call can land after captureJogFrames() below
    // is installed and be misread as belonging to the next one (same
    // settling wait device-jog.test.ts uses after every jog() call).
    await new Promise((r) => setTimeout(r, 100));

    // Teach a tighter ceiling that the SAME command would now cross.
    limitsStore.setEdge("panMax", 170);
    const frames = captureJogFrames(mock!);
    const after: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(textOf(after)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.x).toBe(0);
  });

  // Both the dashboard's press-and-hold ramp (jog-hold.js) and the joystick
  // (joystick-hold.js) post to /api/control/jog -> controls.ts's "jog" case
  // -> McpDashboardClient.jog() -> this exact MCP tool (traced in tools.ts's
  // jog handler doc comment) — there is no third way to command a rate. Each
  // caller sends a DIFFERENT (rate, duration) shape (a ramped rate refreshed
  // at ~2/3 of jogVectorTtlMs for the hold; a stick-proportional rate posted
  // every ~100ms for the joystick), so exercise both shapes against the same
  // near-limit position rather than assuming one code path stands in for the
  // other.
  it("both the press-and-hold shape and the joystick shape hit the same enforcement", async () => {
    const { client } = await harness();
    mock!.setPosition(30 * STEPS_PER_DEG, 0);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });

    // jog-hold.js's JogHold posts at holdIntervalMs(jogVectorTtlMs) with a
    // ramped rate; a mid-ramp value + its own interval, duration-shaped like
    // its keep-alive posts (see jog-hold.js's _tick).
    const holdFrames = captureJogFrames(mock!);
    const holdRes: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 12, tilt_dps: 0, duration_ms: 333 },
    });
    expect(textOf(holdRes)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 60));
    for (const f of holdFrames) expect(f.x).toBe(0);

    // joystick-hold.js's JoystickHold posts every POLL_INTERVAL_MS (100ms)
    // with a stick-proportional rate.
    const joyFrames = captureJogFrames(mock!);
    const joyRes: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 19, tilt_dps: 0, duration_ms: 100 },
    });
    expect(textOf(joyRes)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 60));
    for (const f of joyFrames) expect(f.x).toBe(0);
  });
});
