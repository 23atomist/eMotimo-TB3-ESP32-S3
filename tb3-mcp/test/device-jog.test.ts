import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8798;
let mock: MockTb3;
let device: Device;
let clockMs = 1_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Intercepts every write to mock.lastJog so callers can see each frame in the
// order it actually arrived, instead of only the latest one. Same technique
// as the duration=0 test below, factored out for reuse.
function captureJogFrames(m: MockTb3): Array<{ x: number; y: number; aux: number }> {
  const frames: Array<{ x: number; y: number; aux: number }> = [];
  Object.defineProperty(m, "lastJog", {
    configurable: true,
    get: () => frames[frames.length - 1] ?? null,
    set: (v: { x: number; y: number; aux: number }) => { frames.push(v); },
  });
  return frames;
}

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
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 50, y: -25, aux: 0 });
    // Reset the observation so the assertion below can only be satisfied by
    // pumpJog's own re-send, not by setJogVector's initial synchronous send.
    mock.lastJog = null;
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

  it("jog(duration=0) still sends one non-zero frame before the trailing zero", async () => {
    // For durationMs=0, jog()'s tick count is 0, so setJogVector() and
    // clearJog() run back-to-back with no `await` between them -- there is
    // no real time window in which only the non-zero frame has been sent, so
    // racing a sleep() against mock.lastJog (which only ever remembers the
    // latest frame) cannot reliably observe the intermediate value. Instead,
    // intercept every write to mock.lastJog so we capture each frame in the
    // order it actually arrived, and assert on that deterministic record.
    const frames = captureJogFrames(mock);

    await device.jog(60, 0, 0, 0);
    await sleep(50);

    expect(frames[0]).toEqual({ x: 60, y: 0, aux: 0 });
    expect(frames[frames.length - 1]).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("REGRESSION: jog(x,y,aux,300) sends exactly 5 frames, not double", async () => {
    // Before the fix, setJogVector sent directly AND the lazily-started
    // interval also sent, so jog()'s own keep-alive loop (which calls
    // setJogVector at ~JOG_KEEPALIVE_MS) produced roughly double the
    // intended frames (8 observed instead of 5). The interval must be the
    // only sender: one immediate pump on start, then the interval alone
    // carries every subsequent frame until clearJog's trailing zero.
    //
    // This uses real timers (the keep-alive interval always runs on
    // wall-clock time). Empirically this is not flaky: 80/80 local runs
    // produced exactly 5 frames, because the interval is always registered
    // one tick ahead of jog()'s loop-internal sleep at each 100ms boundary,
    // so it consistently wins the race against clearJog(). If this ever
    // proves flaky in CI, loosen to a bound of 5-6 frames (never as high as
    // the old bug's 8) rather than removing the count assertion.
    const frames = captureJogFrames(mock);

    await device.jog(50, 0, 0, 300);
    await sleep(50);

    expect(frames).toEqual([
      { x: 50, y: 0, aux: 0 },
      { x: 50, y: 0, aux: 0 },
      { x: 50, y: 0, aux: 0 },
      { x: 50, y: 0, aux: 0 },
      { x: 0, y: 0, aux: 0 },
    ]);
  });

  it("SAFETY: lockJog stops an in-flight jog from re-arming, until unlockJog releases it", async () => {
    // A 1s keep-alive loop -- long enough to observe several 100ms ticks
    // fighting (or failing to fight) the lock before it naturally finishes.
    const jogPromise = device.jog(50, 0, 0, 1000);
    await sleep(150);
    expect(mock.lastJog).toEqual({ x: 50, y: 0, aux: 0 });

    // Engage the lock mid-jog, as SunSupervisor.setLocked(true) would. This
    // must zero the rig immediately, exactly like the sun guard's clearJog().
    device.lockJog();
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });

    // The jog() loop is STILL running (its 10-tick for-loop keeps calling
    // setJogVector(50,0,0,...) every 100ms) -- it has no idea it was locked
    // out. Watch several more keep-alive ticks: without the guard, one of
    // those re-arms would land on the wire as a fresh {x:50,...} frame and
    // this assertion would fail. With the guard, setJogVector is a no-op
    // while locked, so nothing is ever sent and lastJog never moves off null.
    mock.lastJog = null;
    await sleep(350);
    expect(mock.lastJog).toBeNull();

    // Release the lock and let the still-running jog() finish out its
    // duration and clean up normally.
    device.unlockJog();
    await jogPromise;
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });
});
