import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MediaMtxPublisher } from "../src/dashboard/camera/publisher.js";
import type { Spawner } from "../src/dashboard/camera/supervisor.js";

function fakeSpawnerFactory() {
  const state = { starts: 0, kills: 0, lastOnExit: null as ((c: number | null) => void) | null };
  const makeSpawner = (): Spawner => ({
    start(_onFrame, onExit) {
      state.starts += 1;
      state.lastOnExit = onExit;
      return { kill: () => { state.kills += 1; } };
    },
  });
  return { makeSpawner, state };
}

describe("MediaMtxPublisher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not publish until armed", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    expect(f.state.starts).toBe(0);
    expect(p.status().enabled).toBe(false);
  });

  it("publishes on enable() with ZERO viewers -- ingest must not depend on viewers", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    p.enable();
    expect(f.state.starts).toBe(1);
    expect(p.status()).toEqual({ enabled: true, streaming: true, viewers: 0 });
  });

  it("keeps publishing when the reader count drops to zero", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    p.enable();
    p.setReaderCount(3);
    expect(p.status().viewers).toBe(3);
    p.setReaderCount(0);
    expect(p.status().viewers).toBe(0);
    expect(f.state.kills).toBe(0);          // the whole point: unattended recording
    expect(p.status().streaming).toBe(true);
  });

  it("starts armed when constructed with enabled: true", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    expect(f.state.starts).toBe(1);
  });

  it("disable() kills the publisher and releases the device", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    p.disable();
    expect(f.state.kills).toBe(1);
    expect(p.status()).toEqual({ enabled: false, streaming: false, viewers: 0 });
  });

  it("restarts a dead publisher while still armed", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    f.state.lastOnExit!(1);
    vi.advanceTimersByTime(1500);
    expect(f.state.starts).toBe(2);
  });

  it("does not restart after disable()", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    p.disable();
    vi.advanceTimersByTime(10_000);
    expect(f.state.starts).toBe(1);
  });

  it("isArmed reflects the arm state for the capture controller", () => {
    const f = fakeSpawnerFactory();
    const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 1500 });
    expect(p.isArmed()).toBe(false);
    p.enable();
    expect(p.isArmed()).toBe(true);
  });
});
