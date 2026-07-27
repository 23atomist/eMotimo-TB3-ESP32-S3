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

  // --- Fix round: retry()/isDegraded() -- the self-heal a give-up state has
  // no other way out of (see MediaMtxPublisher's recovery timer). ---
  describe("degraded state and retry()", () => {
    it("isDegraded() is false until the restart budget is actually exhausted", () => {
      const f = fakeSpawnerFactory();
      const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => true, maxRestarts: 3 });
      sup.sync();
      expect(sup.isDegraded()).toBe(false);
      f.state.lastOnExit!(1);
      expect(sup.isDegraded()).toBe(false); // one failure -- still within budget
    });

    it("isDegraded() flips true once the budget is exhausted", () => {
      const f = fakeSpawnerFactory();
      const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => true, maxRestarts: 3 });
      sup.sync();
      for (let i = 0; i < 4; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(sup.isDegraded()).toBe(true);
      expect(sup.running()).toBe(false);
    });

    it("retry() resets the budget and restarts immediately, clearing degraded", () => {
      const f = fakeSpawnerFactory();
      const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => true, maxRestarts: 3 });
      sup.sync();
      for (let i = 0; i < 4; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(sup.isDegraded()).toBe(true);
      const startsBefore = f.state.starts;

      sup.retry();
      expect(f.state.starts).toBe(startsBefore + 1); // restarted right away, no fallbackMs wait
      expect(sup.isDegraded()).toBe(false);
      expect(sup.running()).toBe(true);

      // The budget is genuinely fresh, not merely masked: it survives
      // another full run through maxRestarts before giving up again.
      for (let i = 0; i < 4; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(sup.isDegraded()).toBe(true);
    });

    it("retry() is a no-op after stop() -- a permanent shutdown must stay permanent", () => {
      const f = fakeSpawnerFactory();
      const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => true, maxRestarts: 3 });
      sup.sync();
      for (let i = 0; i < 4; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      sup.stop();
      const startsBefore = f.state.starts;
      sup.retry();
      expect(f.state.starts).toBe(startsBefore);
      expect(sup.running()).toBe(false);
    });

    it("a deliberate teardown (shouldRun() goes false) clears degraded -- OFF, not \"gave up\"", () => {
      const f = fakeSpawnerFactory();
      let run = true;
      const sup = new SpawnSupervisor(f.makeSpawner, { fallbackMs: 10, shouldRun: () => run, maxRestarts: 3 });
      sup.sync();
      for (let i = 0; i < 4; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(sup.isDegraded()).toBe(true);
      run = false;
      sup.sync(); // reconciles against shouldRun() -> teardown()
      expect(sup.isDegraded()).toBe(false);
    });
  });
});
