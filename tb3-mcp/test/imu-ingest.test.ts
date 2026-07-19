import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8803;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });

describe("DeviceState.imu ingestion", () => {
  it("populates imu from the WS tick", async () => {
    mock = new MockTb3(); await mock.start(PORT);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
    dev = new Device(cfg); dev.start();
    await waitFor(() => dev!.getState().imu !== undefined);
    const imu = dev.getState().imu;
    expect(imu).toBeDefined();
    expect(imu!.ok).toBe(true);
    expect(imu!.pitchDeg).toBeCloseTo(1.5, 6);
    expect(imu!.rollDeg).toBeCloseTo(-2.0, 6);
    expect(imu!.tempC).toBeCloseTo(25.4, 6);
    expect(imu!.pressHpa).toBeCloseTo(1013.1, 6);
  });
});
