import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8792;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

function makeDevice(): Device {
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  return new Device(cfg);
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  if (!pred()) throw new Error("waitFor timed out");
}

describe("Device", () => {
  it("caches telemetry from the WS feed", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(444.444 * 30, 0);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected && dev!.getState().panSteps > 0);
    expect(dev.getState().panSteps).toBeCloseTo(444.444 * 30, -1);
    expect(dev.getState().moving).toBe(false);
  });

  it("gotoAngle triggers a move that waitForArrival resolves", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(0, 0);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.gotoAngle(15, 0);
    expect(mock.lastGoto).toEqual({ pan_deg: 15, tilt_deg: 0, speed_dps: undefined });
    const final = await dev.waitForArrival(15 * 444.444, 0, 8000);
    expect(final.panSteps).toBeCloseTo(15 * 444.444, -1);
  });

  it("gotoAngle throws 409 message while a program is engaged", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setProgramEngaged(true);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await expect(dev.gotoAngle(1, 0)).rejects.toThrow(/program engaged/);
  });

  it("setHome zeroes and stop/camera/program reach the device", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    mock.setPosition(9999, 8888);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.setHome();
    expect(mock.homeCount).toBe(1);
    await dev.stop();
    expect(mock.stopCount).toBe(1);
    await dev.triggerCamera("shoot", 200);
    expect(mock.lastCamera).toEqual({ action: "shoot", ms: 200 });
    await dev.selectProgram(3, true);
    expect(mock.lastProgram).toEqual({ type: 3, select: true });
    const progs = await dev.listPrograms();
    expect(progs.names.length).toBe(8);
  });

  it("jog streams a joystick frame then a zero frame", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    dev = makeDevice(); dev.start();
    await waitFor(() => dev!.getState().connected);
    await dev.jog(50, 0, 0, 250);
    await waitFor(() => mock!.lastJog !== null && mock!.lastJog.x === 0);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });
});
