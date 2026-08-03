// Unit coverage for the RezeroDeps callbacks server.ts builds (Task 7 of the
// reboot-rezero plan) -- none of this is exercised by test/server.test.ts
// (which only proves the tools register and the wiring typechecks) or by
// test/rezero-tools.test.ts / test/rezero-mcp-tools.test.ts (which drive
// RezeroDeps with hand-written fakes, never server.ts's real callbacks).
// The /api/status uptime read and the poll loop itself now live in
// boot-poll.ts -- see test/boot-poll.test.ts for their coverage.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRezeroGravity, buildRezeroPosture, buildRezeroAircraftEnu } from "../src/server.js";
import { Device } from "../src/device.js";
import { AdsbSource } from "../src/adsb/source.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot } from "../src/adsb/types.js";
import type { Vec3 } from "../src/geo/vec3.js";

const cfg = loadConfig(undefined, {});

function tmpCalib(): CalibrationStore {
  const f = join(mkdtempSync(join(tmpdir(), "rezero-deps-")), "calibration.json");
  const s = new CalibrationStore(f);
  s.load();
  return s;
}

describe("buildRezeroGravity", () => {
  it("returns the gravity vector on a successful read", async () => {
    const g: Vec3 = [0.01, 0.02, -0.999];
    const fakeDevice = { getGravity: async (_n: number) => g } as unknown as Device;
    await expect(buildRezeroGravity(fakeDevice)()).resolves.toEqual(g);
  });

  it("swallows a throw (no IMU present) into undefined -- onReboot/rezeroFromEnu treat undefined as unmeasurable, not a crash", async () => {
    const fakeDevice = {
      getGravity: async () => { throw new Error("IMU not present"); },
    } as unknown as Device;
    await expect(buildRezeroGravity(fakeDevice)()).resolves.toBeUndefined();
  });
});

// buildRezeroPosture (Finding I3, Task 5): posture now carries `moving` and
// `staleMs` alongside panDeg/tiltDeg, so onReboot can refuse a gravity read
// paired with a posture it cannot vouch for -- see RezeroPosture's doc in
// rezero-tools.ts. This used to assert the OPPOSITE: that `moving` must NOT
// leak into a narrowed {panDeg, tiltDeg} shape. That narrowing is exactly
// what let onReboot pair a fresh gravity read with a stale WS-cached posture
// in the field; the assertions below pin the fixed, widened contract instead.
describe("buildRezeroPosture", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reads pan/tilt/moving off device.getState() through the same sign/steps conversion as currentUserPanTilt", async () => {
    const fakeDevice = {
      getState: () => ({
        connected: true, panSteps: 4444.44, tiltSteps: -2222.22, auxSteps: 0,
        moving: true, programEngaged: false, batteryV: 12, staIp: "", lastUpdateMs: 0,
      }),
    } as unknown as Device;
    const posture = await buildRezeroPosture(fakeDevice, cfg)();
    // 4444.44 steps / 444.444 steps-per-deg = 10 deg (panSign default +1).
    expect(posture.panDeg).toBeCloseTo(10, 3);
    expect(posture.tiltDeg).toBeCloseTo(-5, 3);
    expect(posture.moving).toBe(true);
  });

  it("derives staleMs as Date.now() - lastUpdateMs while connected", async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fakeDevice = {
      getState: () => ({
        connected: true, panSteps: 0, tiltSteps: 0, auxSteps: 0,
        moving: false, programEngaged: false, batteryV: 12, staIp: "", lastUpdateMs: now - 1500,
      }),
    } as unknown as Device;
    const posture = await buildRezeroPosture(fakeDevice, cfg)();
    expect(posture.staleMs).toBe(1500);
  });

  it("reports staleMs: Infinity when disconnected -- there is no tick to be stale from", async () => {
    const fakeDevice = {
      getState: () => ({
        connected: false, panSteps: 0, tiltSteps: 0, auxSteps: 0,
        moving: false, programEngaged: false, batteryV: 12, staIp: "", lastUpdateMs: 12345,
      }),
    } as unknown as Device;
    const posture = await buildRezeroPosture(fakeDevice, cfg)();
    expect(posture.staleMs).toBe(Infinity);
  });
});

function snapshot(aircraft: AdsbSnapshot["aircraft"]): AdsbSnapshot {
  return { aircraft, fetchedAtMs: 0, ok: true };
}

function ac(overrides: Partial<AdsbSnapshot["aircraft"][number]> = {}): AdsbSnapshot["aircraft"][number] {
  return {
    hex: "a1b2c3", callsign: null, lat: 37.0, lon: -122.0, altBaroFt: 10000, altGeomFt: 10000,
    gsKt: null, trackDeg: null, baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: 1, rssi: null,
    ...overrides,
  };
}

describe("buildRezeroAircraftEnu", () => {
  it("returns undefined when there is no rig location to measure from", async () => {
    const calib = tmpCalib();   // never setRigLocation
    const source = { getSnapshot: () => snapshot([ac()]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3")).resolves.toBeUndefined();
  });

  it("returns undefined when the hex isn't in the current snapshot", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const source = { getSnapshot: () => snapshot([ac({ hex: "deadbe" })]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3")).resolves.toBeUndefined();
  });

  it("matches hex case-insensitively, same as track_aircraft", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const source = { getSnapshot: () => snapshot([ac({ hex: "a1b2c3" })]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("A1B2C3")).resolves.toBeDefined();
  });

  it("returns undefined when the position report is stale beyond trackMaxTargetAgeMs", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const staleSec = cfg.trackMaxTargetAgeMs / 1000 + 1;
    const source = { getSnapshot: () => snapshot([ac({ seenPosSec: staleSec })]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3")).resolves.toBeUndefined();
  });

  it("returns undefined when the position report age is unknown (null)", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const source = { getSnapshot: () => snapshot([ac({ seenPosSec: null })]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3")).resolves.toBeUndefined();
  });

  it("returns undefined when the aircraft has no usable lat/lon/altitude", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const source = { getSnapshot: () => snapshot([ac({ lat: null, lon: null })]) } as unknown as AdsbSource;
    await expect(buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3")).resolves.toBeUndefined();
  });

  it("returns a rig-relative ENU vector for a fresh, positioned, visible aircraft", async () => {
    const calib = tmpCalib(); calib.setRigLocation(37.5, -122.5, 50);
    const source = { getSnapshot: () => snapshot([ac({ lat: 37.51, lon: -122.5, altBaroFt: 10000, altGeomFt: 10000 })]) } as unknown as AdsbSource;
    const enu = await buildRezeroAircraftEnu(source, calib, cfg)("a1b2c3");
    expect(enu).toBeDefined();
    // North of the rig and well above it -> north (index 1) and up (index 2) components positive.
    expect(enu![1]).toBeGreaterThan(0);
    expect(enu![2]).toBeGreaterThan(0);
  });
});
