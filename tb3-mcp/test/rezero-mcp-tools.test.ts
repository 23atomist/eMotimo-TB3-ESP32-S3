// MCP-surface tests for rezero-tools.ts's four registered tools plus
// rezeroGuard. test/rezero-tools.test.ts already covers the core
// onReboot/rezeroFromEnu math exhaustively (per the task brief, verbatim);
// this file exercises the thin MCP wrappers around them -- refusal paths,
// wiring to the stores, and the diagnostic get_rezero_status/rezeroGuard
// surface -- with no real Device/rig involved (RezeroDeps is fully injected).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { loadConfig } from "../src/config.js";
import { registerRezeroTools, rezeroGuard, onReboot, RezeroDeps } from "../src/rezero-tools.js";
import { Mat3, Vec3, matMul, rotX, rotZ, deg2rad, matVec, normalize } from "../src/geo/vec3.js";
import { mountHeadRotation } from "../src/geo/boresight.js";
import { boresightEnu } from "../src/track/control.js";

const GP = -1;
const R: Mat3 = matMul(rotZ(deg2rad(20)), rotX(deg2rad(3)));
const C: Vec3 = normalize([0.02, 0.99, 0.08]);
const RS: Mat3 = matMul(rotZ(deg2rad(-35)), rotX(deg2rad(80)));
const DB: Vec3 = normalize([-0.008, -0.024, -0.9997]);

function gravityAt(pan: number, tilt: number): Vec3 {
  const M = mountHeadRotation(GP * pan, tilt);
  const t = (m: Mat3): Mat3 => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
  return matVec(matMul(t(RS), t(M)), DB);
}

function harness(overrides: Partial<RezeroDeps> = {}) {
  const d = mkdtempSync(join(tmpdir(), "tb3-"));
  // GP (-1) is what every test in this file solves against; getOrientation()/
  // getCHead() derive using the store's own geoPanSign, so the default of 1
  // would silently mismatch (see test/rezero-tools.test.ts's stores()).
  const calib = new CalibrationStore(join(d, "calibration.json"), GP); calib.load();
  const limits = new LimitsStore(join(d, "limits.json")); limits.load();
  const boot = new BootWatcher(join(d, "boot.json")); boot.load();
  const cfg = loadConfig(undefined, { TB3_GEO_PAN_SIGN: String(GP) });
  const deps: RezeroDeps = {
    calib, limits, boot, cfg,
    gravity: async () => undefined,
    posture: async () => ({ panDeg: 0, tiltDeg: 0, moving: false, staleMs: 0 }),
    aircraftEnu: async () => undefined,
    ...overrides,
  };
  return { calib, limits, boot, cfg, deps };
}

async function connect(deps: RezeroDeps) {
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerRezeroTools(server, deps);
  const client = new Client({ name: "c", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("set_landmark", () => {
  it("refuses when not calibrated", async () => {
    const { deps } = harness();
    const client = await connect(deps);
    const res = await client.callTool({ name: "set_landmark", arguments: { label: "tower" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not calibrated/);
  });

  it("records the boresight ENU at the current posture when calibrated", async () => {
    const { calib, deps } = harness({ posture: async () => ({ panDeg: 12, tiltDeg: 7, moving: false, staleMs: 0 }) });
    calib.setRigLocation(0, 0, 0);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    const client = await connect(deps);
    const res = await client.callTool({ name: "set_landmark", arguments: { label: "tower" } });
    expect(res.isError).toBeFalsy();
    const lm = calib.getLandmark();
    expect(lm?.label).toBe("tower");
    const expectedEnu = boresightEnu(R, 12, 7, C, GP);
    expect(lm?.enu[0]).toBeCloseTo(expectedEnu[0], 6);
    expect(lm?.enu[1]).toBeCloseTo(expectedEnu[1], 6);
    expect(lm?.enu[2]).toBeCloseTo(expectedEnu[2], 6);
  });
});

describe("rezero_from_landmark", () => {
  it("errors when no landmark is recorded", async () => {
    const { deps } = harness();
    const client = await connect(deps);
    const res = await client.callTool({ name: "rezero_from_landmark", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/set_landmark/);
  });

  it("errors when the IMU has no gravity", async () => {
    const { calib, deps } = harness({ gravity: async () => undefined });
    calib.setRigLocation(0, 0, 0);
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    calib.setLandmark({ label: "tower", enu: [0, 1, 0], panDeg: 0, tiltDeg: 0, recordedAt: new Date().toISOString() });
    calib.markRezeroNeeded(2);
    const client = await connect(deps);
    const res = await client.callTool({ name: "rezero_from_landmark", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no IMU gravity/);
  });

  it("solves and applies a re-zero, clearing needsRezero and leaving cleared pan limits absent", async () => {
    // Realistic sequence: a reboot happens first (onReboot clears pan and
    // shifts tilt -- round 2, operator decision 2026-08-03), THEN the
    // operator centres the landmark and calls rezero_from_landmark --
    // mirrors test/rezero-tools.test.ts's "restores pointing for an
    // independent posture" but driven through the MCP tool.
    const dPan = 9, dTilt = 5;
    const { calib, limits, boot, deps } = harness({
      gravity: async () => gravityAt(-25, 19),
      posture: async () => ({ panDeg: -25 - dPan, tiltDeg: 19 - dTilt, moving: false, staleMs: 0 }),
    });
    calib.setRigLocation(0, 0, 0);
    calib.setImuMounting(RS, DB);
    calib.setGravityCalibration(R, C, new Date().toISOString());
    limits.setEdge("panMin", -90);
    await onReboot({
      calib, limits, boot, geoPanSign: GP,
      gravity: async () => gravityAt(40, 8),
      posture: async () => ({ panDeg: 40, tiltDeg: 8 - dTilt, moving: false, staleMs: 0 }),
      bootId: 2,
    });
    expect(limits.get().panMin).toBeUndefined(); // cleared -- as test/rezero-tools.test.ts pins

    const refEnu = boresightEnu(R, -25, 19, C, GP);
    calib.setLandmark({ label: "tower", enu: refEnu, panDeg: -25, tiltDeg: 19, recordedAt: new Date().toISOString() });
    const client = await connect(deps);
    const res = await client.callTool({ name: "rezero_from_landmark", arguments: {} });
    expect(res.isError).toBeFalsy();
    const p = JSON.parse(textOf(res)) as { delta_pan_deg: number; delta_tilt_deg: number };
    expect(p.delta_pan_deg).toBeCloseTo(dPan, 0);
    expect(p.delta_tilt_deg).toBeCloseTo(dTilt, 0);
    expect(calib.needsRezero()).toBe(false);
    // Nothing left to shift -- pan was cleared and never re-taught.
    expect(limits.get().panMin).toBeUndefined();
  });
});

describe("rezero_from_aircraft", () => {
  it("errors when the aircraft is not usable as a reference", async () => {
    const { deps } = harness({ aircraftEnu: async () => undefined });
    const client = await connect(deps);
    const res = await client.callTool({ name: "rezero_from_aircraft", arguments: { hex: "a1b2c3" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not usable/);
  });
});

describe("get_rezero_status", () => {
  it("reports pending state, landmark label, and taught axes", async () => {
    const { calib, limits, deps } = harness();
    calib.markRezeroNeeded(3);
    calib.setLandmark({ label: "tower", enu: [0, 1, 0], panDeg: 0, tiltDeg: 0, recordedAt: new Date().toISOString() });
    limits.setEdge("tiltMin", -10);
    const client = await connect(deps);
    const res = await client.callTool({ name: "get_rezero_status", arguments: {} });
    const p = JSON.parse(textOf(res)) as {
      needs_rezero: boolean; landmark_label: string | null; taught_axes: { pan: boolean; tilt: boolean };
    };
    expect(p.needs_rezero).toBe(true);
    expect(p.landmark_label).toBe("tower");
    expect(p.taught_axes).toEqual({ pan: false, tilt: true });
  });
});

describe("rezeroGuard", () => {
  it("passes when the origin is known", () => {
    const { calib } = harness();
    expect(rezeroGuard(calib)).toBeUndefined();
  });

  it("blocks when a re-zero is pending, and says how to fix it", () => {
    const { calib } = harness();
    calib.markRezeroNeeded(2);
    const msg = rezeroGuard(calib);
    expect(msg).toBeDefined();
    expect(msg).toMatch(/rezero_from_landmark/);
  });
});
