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

  // --- Fix round: recover from restart-budget exhaustion (final review #2) ---
  //
  // Probed on the roof: 6 spawn attempts in ~9s (fallbackMs 1500) then a
  // PERMANENT give-up -- {enabled:true, streaming:false} renders as
  // "Camera: STARTING..." forever, with nothing left that ever retries.
  // These pin the fix: a `degraded` status flag distinct from "still
  // retrying", and a long-interval nudge that self-heals without an
  // operator pressing Stop/Start.
  describe("recovery from restart-budget exhaustion", () => {
    it("marks degraded once the restart budget is exhausted, distinct from mid-retry", () => {
      const f = fakeSpawnerFactory();
      const p = new MediaMtxPublisher(f.makeSpawner, { fallbackMs: 10, enabled: true });

      // A single failure is a normal, still-retrying restart -- not degraded.
      f.state.lastOnExit!(1);
      expect(p.status().degraded).toBeUndefined();
      vi.advanceTimersByTime(10);

      // Exhaust the default budget (5 restarts): starts=1 (initial) + 5.
      for (let i = 0; i < 5; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(p.status()).toEqual({ enabled: true, streaming: false, viewers: 0, degraded: true });
    });

    it("self-heals via the periodic recovery nudge with no operator action", () => {
      const f = fakeSpawnerFactory();
      const p = new MediaMtxPublisher(f.makeSpawner, {
        fallbackMs: 10, enabled: true, recoveryIntervalMs: 30_000,
      });

      for (let i = 0; i < 6; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(p.status().degraded).toBe(true);
      const startsBeforeRecovery = f.state.starts;

      // The next recovery tick resets the budget and tries again.
      vi.advanceTimersByTime(30_000);
      expect(f.state.starts).toBe(startsBeforeRecovery + 1);
      expect(p.status()).toEqual({ enabled: true, streaming: true, viewers: 0 }); // degraded cleared
    });

    it("does not nudge once disarmed -- Stop stays a hard release", () => {
      const f = fakeSpawnerFactory();
      const p = new MediaMtxPublisher(f.makeSpawner, {
        fallbackMs: 10, enabled: true, recoveryIntervalMs: 30_000,
      });
      for (let i = 0; i < 6; i++) {
        f.state.lastOnExit!(1);
        vi.advanceTimersByTime(10);
      }
      expect(p.status().degraded).toBe(true);

      p.disable();
      const startsAfterDisable = f.state.starts;
      vi.advanceTimersByTime(60_000);
      expect(f.state.starts).toBe(startsAfterDisable); // no zombie restart while disarmed
      expect(p.status().degraded).toBeUndefined();
    });

    it("a recovery nudge while merely mid-retry (not yet degraded) is a no-op", () => {
      const f = fakeSpawnerFactory();
      const p = new MediaMtxPublisher(f.makeSpawner, {
        fallbackMs: 10, enabled: true, recoveryIntervalMs: 30_000,
      });
      f.state.lastOnExit!(1); // one failure -- still well within budget
      vi.advanceTimersByTime(10); // the normal backed-off restart fires on its own
      expect(p.status().degraded).toBeUndefined();
      const startsAfterNormalRestart = f.state.starts;

      vi.advanceTimersByTime(30_000); // the recovery tick fires, but isDegraded() is false
      expect(f.state.starts).toBe(startsAfterNormalRestart); // untouched by the nudge itself
    });
  });
});
