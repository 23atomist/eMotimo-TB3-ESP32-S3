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
import { registerGeoTools, reachablePanTilt } from "../src/geo-tools.js";
import { CalibrationStore } from "../src/calibration.js";

const PORT = 8795;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let dir: string | null = null;

async function harness(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), "tb3geo-"));
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, ...env });
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

describe("geo tools — solve + point", () => {
  // Build a self-consistent calibration by sighting two targets AT the pan/tilt
  // the mock currently reports, so the solved R maps those ENU dirs to those
  // aims. Then point_at a third target and assert the mock was driven to a
  // pan/tilt consistent with re-sighting it.
  async function calibrate(client: any, mock: MockTb3) {
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    // Sighting A: aim pan=0,tilt=2 at a landmark to the north-ish
    mock.setPosition(0 * 444.444, 2 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 46, lon: 10, height_m: 100, label: "N" } });
    // Sighting B: aim pan=80,tilt=1 at a landmark to the east-ish
    mock.setPosition(80 * 444.444, 1 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 45, lon: 11.4, height_m: 100, label: "E" } });
  }

  it("solve_calibration reports heading + separation and marks calibrated", async () => {
    const { client, store } = await harness();
    await calibrate(client, mock!);
    const res: any = await client.callTool({ name: "solve_calibration", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body).toHaveProperty("heading_deg");
    expect(body).toHaveProperty("separation_deg");
    expect(body.separation_deg).toBeGreaterThan(15);
    expect(store.isCalibrated()).toBe(true);
  });

  it("point_at refuses before calibration", async () => {
    const { client } = await harness();
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not calibrated/i);
  });

  it("point_at drives the rig and reports az/el/range/pan/tilt", async () => {
    const { client } = await harness();
    await calibrate(client, mock!);
    await client.callTool({ name: "solve_calibration", arguments: {} });

    // Re-sighting landmark A (pan≈0,tilt≈2). point_at that same point:
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    const body = JSON.parse(textOf(res));
    expect(body.pan_deg).toBeCloseTo(0, 0);
    expect(body.tilt_deg).toBeCloseTo(2, 0);
    // due north — azElRange now snaps the ~359.9999...° floating-point
    // artifact down to the equivalent 0° at this same-longitude boundary.
    expect(body.azimuth_deg).toBeCloseTo(0, 1);
    expect(body.range_m).toBeGreaterThan(1000);
    // the mock recorded a goto to the device-frame equivalent
    expect(mock!.lastGoto).not.toBeNull();
  });

  it("point_at_azel points and returns finite pan/tilt", async () => {
    const { client } = await harness();
    await calibrate(client, mock!);
    await client.callTool({ name: "solve_calibration", arguments: {} });
    const res: any = await client.callTool({
      name: "point_at_azel", arguments: { azimuth_deg: 5, elevation_deg: 3 },
    });
    expect(res.isError ?? false).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(Number.isFinite(body.pan_deg)).toBe(true);
    expect(Number.isFinite(body.tilt_deg)).toBe(true);
    expect(mock!.lastGoto).not.toBeNull();
  });

  it("point_at returns a friendly error when the target coincides with the rig location", async () => {
    const { client } = await harness();
    await calibrate(client, mock!);
    await client.callTool({ name: "solve_calibration", arguments: {} });
    const res: any = await client.callTool({
      // same lat/lon/height as the rig set in calibrate() — zero range.
      name: "point_at", arguments: { lat: 45, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/coincides with (the )?rig location/i);
    expect(mock!.lastGoto).toBeNull();
  });

  it("solve_calibration returns a friendly error when a sighted landmark coincides with the rig location", async () => {
    const { client } = await harness();
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    mock!.setPosition(0, 0);
    await new Promise((r) => setTimeout(r, 200));
    // Sight a "landmark" at the exact rig location — zero range, degenerate direction.
    await client.callTool({ name: "sight_landmark", arguments: { lat: 45, lon: 10, height_m: 100, label: "self" } });
    mock!.setPosition(80 * 444.444, 1 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 45, lon: 11.4, height_m: 100, label: "E" } });
    const res: any = await client.callTool({ name: "solve_calibration", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/coincides with (the )?rig location/i);
  });
});

describe("geo tools — height_m sane-band validation", () => {
  it("set_rig_location rejects a height_m above the sane band", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 500_000 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/height_m/i);
  });

  it("sight_landmark rejects a height_m below the sane band", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "sight_landmark", arguments: { lat: 46, lon: 10, height_m: -5_000 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/height_m/i);
  });

  it("point_at rejects a height_m above the sane band", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 200_000 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/height_m/i);
  });
});

describe("geo tools — sign-frame round trip (regression)", () => {
  // The highest-risk correctness path in this feature: sight_landmark
  // captures device pan/tilt in *user* frame as applySign(stepsToDeg(steps),
  // sign); point_at inverts back to user-frame pan/tilt and moveToUserAngle
  // re-applies the sign to reach device frame. With panSign=+1/tiltSign=+1
  // (the default used elsewhere in this file) user frame == device frame, so
  // a bug that dropped or double-applied the sign would be invisible. Flip
  // both signs here so the round trip only holds if the sign math is right
  // in both directions.
  it("sighting a landmark then pointing at it returns the rig to the same device position under panSign=-1, tiltSign=-1", async () => {
    const { client } = await harness({ TB3_PAN_SIGN: "-1", TB3_TILT_SIGN: "-1" });
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });

    // Sighting A: aim the device (device-frame steps) at a landmark to the
    // north-ish. With both signs flipped, the *user*-frame pan/tilt that
    // sight_landmark actually records is the negation of these device angles.
    const devicePanA = 15, deviceTiltA = 2;
    mock!.setPosition(devicePanA * 444.444, deviceTiltA * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 46, lon: 10, height_m: 100, label: "A" } });

    // Sighting B: aim at a well-separated landmark to the east-ish.
    const devicePanB = 95, deviceTiltB = 1;
    mock!.setPosition(devicePanB * 444.444, deviceTiltB * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 45, lon: 11.4, height_m: 100, label: "B" } });

    await client.callTool({ name: "solve_calibration", arguments: {} });

    // Move the rig away from A's aim point first, so the round-trip
    // assertion below can only pass if point_at actually re-commands it
    // there — not because it never moved.
    mock!.setPosition(0, 0);
    await new Promise((r) => setTimeout(r, 200));

    // point_at landmark A must drive the rig back to the exact device-frame
    // pan/tilt it was aimed at when A was sighted, regardless of sign.
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError ?? false).toBe(false);
    expect(mock!.lastGoto).not.toBeNull();
    // The mock broadcasts position rounded to the nearest integer step (see
    // pushTick in mock-tb3.ts), so the sighted angle round-trips through
    // ~0.001° of step-quantization noise rather than landing bit-exact.
    expect(mock!.lastGoto!.pan_deg).toBeCloseTo(devicePanA, 2);
    expect(mock!.lastGoto!.tilt_deg).toBeCloseTo(deviceTiltA, 2);

    // Cross-check via the tool's own reported (user-frame) pan/tilt, applying
    // the sign back out to device frame — should agree with lastGoto.
    const body = JSON.parse(textOf(res));
    expect(body.pan_deg * -1).toBeCloseTo(devicePanA, 0);
    expect(body.tilt_deg * -1).toBeCloseTo(deviceTiltA, 0);
  });
});

describe("reachablePanTilt (reachability)", () => {
  it("passes an in-range pan/tilt through", () => {
    expect(reachablePanTilt(45, 10, -180, 180, -90, 90)).toEqual({ pan: 45, tilt: 10 });
  });
  it("wraps pan into range", () => {
    const r = reachablePanTilt(200, 10, -180, 180, -90, 90) as any;
    expect("error" in r).toBe(false);
    expect(r.pan).toBeCloseTo(-160, 9);
  });
  it("refuses a tilt below the range (below horizon)", () => {
    const r = reachablePanTilt(0, -95, -180, 180, -90, 90) as any;
    expect(r.error).toMatch(/tilt/i);
  });
  it("refuses an unreachable pan", () => {
    const r = reachablePanTilt(135, 0, -90, 90, -90, 90) as any;
    expect(r.error).toMatch(/pan/i);
  });
});
