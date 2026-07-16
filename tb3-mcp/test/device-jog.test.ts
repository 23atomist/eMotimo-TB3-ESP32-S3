import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8798;
let mock: MockTb3;
let device: Device;
let clockMs = 1_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  clockMs = 1_000_000;
  mock = new MockTb3();
  await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  device = new Device(cfg, () => clockMs);
  device.start();
  await sleep(150);   // let the websocket connect
});

afterEach(async () => {
  device.close();
  await mock.stop();
});

describe("Device jog vector", () => {
  it("repeats the vector to the device while it is fresh", async () => {
    device.setJogVector(50, -25, 0, 500);
    await sleep(250);
    expect(mock.lastJog).toEqual({ x: 50, y: -25, aux: 0 });
  });

  it("clearJog zeroes the vector immediately", async () => {
    device.setJogVector(50, 0, 0, 500);
    await sleep(150);
    device.clearJog();
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("SAFETY: an un-refreshed vector expires and the rig is zeroed", async () => {
    device.setJogVector(80, 0, 0, 500);
    await sleep(150);
    expect(mock.lastJog).toEqual({ x: 80, y: 0, aux: 0 });

    // Simulate the session dying: nothing refreshes the vector, and time passes
    // beyond its TTL. The keep-alive must refuse to re-send it and zero instead.
    clockMs += 600;
    await sleep(250);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("SAFETY: a refreshed vector keeps running past the TTL", async () => {
    for (let i = 0; i < 6; i++) {
      device.setJogVector(40, 0, 0, 500);
      clockMs += 100;
      await sleep(60);
    }
    expect(mock.lastJog).toEqual({ x: 40, y: 0, aux: 0 });
  });

  it("the timed jog tool path still zeroes when it finishes", async () => {
    await device.jog(30, 0, 0, 300);
    // jog() resolves the instant it calls ws.send(0,0,0); the frame still has
    // to cross the loopback socket and be parsed by the mock before lastJog
    // reflects it (same reasoning as the existing device.test.ts jog case).
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });
});
