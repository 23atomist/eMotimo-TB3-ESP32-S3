import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpawnSupervisor, type Spawner } from "../src/dashboard/camera/supervisor.js";

function fakeSpawnerFactory() {
  const state = {
    starts: 0,
    kills: 0,
    lastOnFrame: null as ((jpeg: Buffer) => void) | null,
    lastOnExit: null as ((code: number | null) => void) | null,
  };
  const makeSpawner = (): Spawner => ({
    start(onFrame, onExit) {
      state.starts += 1;
      state.lastOnFrame = onFrame;
      state.lastOnExit = onExit;
      return { kill: () => { state.kills += 1; } };
    },
  });
  return { makeSpawner, state };
}

describe("SpawnSupervisor", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start while shouldRun() is false", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => false });
    sup.sync();
    expect(f.state.starts).toBe(0);
    expect(sup.running()).toBe(false);
  });

  it("starts once when shouldRun() is true and is idempotent", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => true });
    sup.sync();
    sup.sync();
    sup.sync();
    expect(f.state.starts).toBe(1);
    expect(sup.running()).toBe(true);
  });

  it("ignores frames from a torn-down generation", () => {
    const f = fakeSpawnerFactory();
    const frames: Buffer[] = [];
    const sup = new SpawnSupervisor(f.makeSpawner, {
      fallbackMs: 1500, shouldRun: () => true, onFrame: (b) => frames.push(b),
    });
    sup.sync();
    const staleOnFrame = f.state.lastOnFrame!;
    sup.teardown();
    staleOnFrame(Buffer.from([0xff, 0xd8]));
    expect(frames).toHaveLength(0);
  });

  it("restarts after fallbackMs when the pipeline exits", () => {
    const f = fakeSpawnerFactory();
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 1500, shouldRun: () => true });
    sup.sync();
    f.state.lastOnExit!(1);
    expect(f.state.starts).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(f.state.starts).toBe(2);
  });

  it("gives up and reports degraded after exceeding the restart budget", () => {
    const f = fakeSpawnerFactory();
    const onDegraded = vi.fn();
    const sup = new SpawnSupervisor(f.makeSpawner, {
      fallbackMs: 10, shouldRun: () => true, onDegraded, maxRestarts: 3, restartWindowMs: 60_000,
    });
    sup.sync();
    for (let i = 0; i < 4; i++) {
      f.state.lastOnExit!(1);
      vi.advanceTimersByTime(10);
    }
    expect(onDegraded).toHaveBeenCalled();
    expect(f.state.starts).toBe(4); // initial + 3 restarts, then the budget stops it
  });

  it("does not restart when shouldRun() has gone false", () => {
    const f = fakeSpawnerFactory();
    let run = true;
    const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => run });
    sup.sync();
    run = false;
    f.state.lastOnExit!(1);
    vi.advanceTimersByTime(100);
    expect(f.state.starts).toBe(1);
  });
});
