import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerImuTools } from "../src/imu-tools.js";
import { registerGeoTools, currentUserPanTilt } from "../src/geo-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { TrackingSession } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { solveImuMounting, boresightToEnu } from "../src/geo/imu-orientation.js";
import { normalize, rad2deg } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";
import { AdsbSource } from "../src/adsb/source.js";
import { wrapDeg180 } from "../src/track/control.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

const PORT = 8796;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

function azimuthDeg(v: Vec3): number {
  let az = rad2deg(Math.atan2(v[0], v[1]));
  if (az < 0) az += 360;
  return az;
}

async function harness(env: Record<string, string> = {}) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}`, ...env });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const dir = mkdtempSync(join(tmpdir(), "tb3-nz-"));
  const store = new CalibrationStore(join(dir, "calibration.json"));
  store.load();
  const limitsStore = new LimitsStore(join(dir, "limits.json"));
  limitsStore.load();
  const session = new TrackingSession(dev, cfg, store);
  const supervisor = new SunSupervisor(dev, cfg, store, session);
  const source = new AdsbSource(cfg);
  const server = new McpServer({ name: "tb3-imu-nz", version: "test" });
  registerImuTools(server, dev, cfg, store, supervisor, session, limitsStore);
  registerGeoTools(server, dev, cfg, store, session, supervisor, source, limitsStore);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store, cfg, session };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

describe("set_north_zero", () => {
  it("refuses without an IMU characterisation (no characterize_imu run)", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "set_north_zero", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/characterize_imu/i);
  });

  it("refuses while the rig is moving", async () => {
    const { client, store } = await harness({ TB3_GEO_PAN_SIGN: "-1" });
    const samples = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
      panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
    }));
    const { rS, dBase } = solveImuMounting(samples, -1);
    store.setImuMounting(rS, dBase);

    // Stub the gravity read to succeed instantly (the mock has no /api/imu
    // endpoint) -- the point of this test is the BEFORE/AFTER `moving` check,
    // not a gravity-read failure, so a 404 there must not mask it.
    const g0 = field.sweep[0];
    vi.spyOn(dev!, "getGravity").mockResolvedValue(normalize([g0.ax, g0.ay, g0.az] as Vec3));

    // Kick off a real (slow, simulated) goto and query while it is still in
    // flight -- the mock takes real wall-clock time to arrive (SIM_DPS), so
    // there is a genuine window where getState().moving is true.
    void dev!.gotoAngle(120, 0);
    await new Promise((r) => setTimeout(r, 150)); // let a websocket tick report moving=1
    expect(dev!.getState().moving).toBe(true);

    const res: any = await client.callTool({ name: "set_north_zero", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/mov(ed|ing)/i);
    expect(store.getOrientation()).toBeUndefined();
  });

  it("produces a PROVISIONAL orientation once characterized and settled — reported as provisional, not calibrated", async () => {
    const { client, store, cfg } = await harness({ TB3_GEO_PAN_SIGN: "-1" });
    const samples = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
      panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
    }));
    const { rS, dBase } = solveImuMounting(samples, -1);
    store.setImuMounting(rS, dBase);

    // Park at a swept posture and stub Device.getGravity for it (the mock has
    // no /api/imu endpoint -- same convention as geo-tools.test.ts's gravity
    // path tests).
    const g = field.sweep[3];
    mock!.setPosition(g.pan * 444.444, g.tilt * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    vi.spyOn(dev!, "getGravity").mockResolvedValue(normalize([g.ax, g.ay, g.az] as Vec3));

    const res: any = await client.callTool({ name: "set_north_zero", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(body.provisional).toBe(true);

    // Store-level: an orientation exists, but isCalibrated()/isProvisional()
    // correctly distinguish it from a real solve.
    expect(store.getOrientation()).toBeDefined();
    expect(store.isProvisional()).toBe(true);
    expect(store.isCalibrated()).toBe(false);

    // get_calibration must surface the same distinction to the operator/dashboard.
    const calRes: any = await client.callTool({ name: "get_calibration", arguments: {} });
    const cal = JSON.parse(textOf(calRes));
    expect(cal.calibrated).toBe(false);
    expect(cal.provisional).toBe(true);

    // The geometry itself: the declared posture points at azimuth 0. Uses the
    // ACTUAL settled pan/tilt (device state), not the fixture's exact values
    // -- the mock quantizes position to integer steps (~1/444 deg), so the
    // posture set_north_zero solved against is only equal to the fixture up
    // to that quantization.
    const settled = currentUserPanTilt(dev!, cfg);
    const R = store.getOrientation()!;
    const boresight = boresightToEnu(R, [0, 1, 0], cfg.geoPanSign, settled.panDeg, settled.tiltDeg);
    expect(Math.abs(wrapDeg180(azimuthDeg(boresight)))).toBeLessThan(1e-6);
  });

  it("refuses while tracking is active", async () => {
    const { client, store, session } = await harness({ TB3_GEO_PAN_SIGN: "-1" });
    // set_rig_location FIRST (it resets the whole profile) -- matches every
    // other harness/test in this codebase (see calibration.test.ts).
    store.setRigLocation(45, 10, 0);
    const samples = field.sweep.map((s: { pan: number; tilt: number; ax: number; ay: number; az: number }) => ({
      panDeg: s.pan, tiltDeg: s.tilt, gravity: normalize([s.ax, s.ay, s.az] as Vec3),
    }));
    const { rS, dBase } = solveImuMounting(samples, -1);
    store.setImuMounting(rS, dBase);
    // A provisional-orientation track (the whole point of this feature): a
    // pre-existing (even provisional) orientation is enough for start() to
    // accept it -- see TrackingSession.start()'s getOrientation() gate.
    store.setProvisionalOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], new Date(0).toISOString());
    const err = session.start({ lat: 45.09, lon: 10, height: 0 }, [0, 0, 0], null);
    expect(err).toBeNull();
    expect(session.isActive()).toBe(true);

    const res: any = await client.callTool({ name: "set_north_zero", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    session.stop();
  });
});
