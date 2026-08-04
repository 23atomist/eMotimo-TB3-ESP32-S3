// Coverage for boot-poll.ts: fetchDeviceUptimeMs's host-fallback parsing, and
// BootWatchPoller's tick control flow -- the piece fix-round-1 flagged as
// unverified-by-the-repo (only the pure helpers in server.ts had tests; the
// setInterval closure's own behaviour was checked by hand, not in CI). Shaped
// after test/adsb-source.test.ts (AdsbSource is the closest existing
// long-lived, Scheduler-injected tick loop in this call graph): a fake
// scheduler captures the tick function and fires it manually, with a
// `flush()` microtask-drain between fires to let the async tick settle.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootWatchPoller, fetchDeviceUptimeMs } from "../src/boot-poll.js";
import { BootWatcher } from "../src/boot-watch.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { loadConfig } from "../src/config.js";
import type { Scheduler } from "../src/track/session.js";
import type { OnRebootArgs } from "../src/rezero-tools.js";
import type { Vec3 } from "../src/geo/vec3.js";

const cfg = loadConfig(undefined, {});

function stores(): { calib: CalibrationStore; limits: LimitsStore } {
  const d = mkdtempSync(join(tmpdir(), "boot-poll-"));
  const calib = new CalibrationStore(join(d, "calibration.json")); calib.load();
  const limits = new LimitsStore(join(d, "limits.json")); limits.load();
  return { calib, limits };
}

const noGravity = async (): Promise<Vec3 | undefined> => undefined;
const zeroPosture = async () => ({ panDeg: 0, tiltDeg: 0, moving: false, staleMs: 0 });

function fakeBoot(observe: (uptimeMs: number, nowMs: number) => boolean, bootId = 1): BootWatcher {
  return { observe: vi.fn(observe), bootId: () => bootId, load: () => {} } as unknown as BootWatcher;
}

// Captures the function AdsbSource-style Scheduler.every() would hand to
// realScheduler, so tests can fire ticks synchronously instead of waiting on
// a real setInterval. Same shape as test/adsb-source.test.ts's inline fake.
function fakeScheduler(): { scheduler: Scheduler; fire: () => void } {
  let fn: (() => void) | null = null;
  const scheduler: Scheduler = {
    every: (_ms: number, f: () => void) => { fn = f; return { cancel: () => { fn = null; } }; },
  };
  return { scheduler, fire: () => fn?.() };
}

// Lets a fired tick's promise chain (fetch -> observe -> onReboot -> log)
// settle before the next assertion, same pattern test/adsb-source.test.ts uses.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("fetchDeviceUptimeMs", () => {
  it("returns uptime_ms parsed from a successful /api/status response", async () => {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ uptime_ms: 12345 }) })) as unknown as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await expect(fetchDeviceUptimeMs(cfg)).resolves.toBe(12345);
    } finally { globalThis.fetch = orig; }
  });

  it("falls back to deviceIpFallback when the primary host fails, mirroring RigDirectClient.status()", async () => {
    const c = loadConfig(undefined, { TB3_DEVICE_HOST: "primary.invalid", TB3_DEVICE_IP_FALLBACK: "1.2.3.4" });
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls += 1;
      if (url.includes("primary.invalid")) throw new Error("unreachable");
      return { ok: true, json: async () => ({ uptime_ms: 999 }) };
    }) as unknown as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await expect(fetchDeviceUptimeMs(c)).resolves.toBe(999);
      expect(calls).toBe(2);
    } finally { globalThis.fetch = orig; }
  });

  it("resolves undefined (never throws) when every host is unreachable", async () => {
    const fetchFn = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await expect(fetchDeviceUptimeMs(cfg)).resolves.toBeUndefined();
    } finally { globalThis.fetch = orig; }
  });

  it("resolves undefined when the body has no numeric uptime_ms", async () => {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ pos: { pan: 0, tilt: 0 } }) })) as unknown as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await expect(fetchDeviceUptimeMs(cfg)).resolves.toBeUndefined();
    } finally { globalThis.fetch = orig; }
  });
});

describe("BootWatchPoller.pollOnceForTest (single-tick behaviour)", () => {
  it("a successful read with no reboot calls observe() but does not call onReboot", async () => {
    const { calib, limits } = stores();
    const observeCalls: Array<[number, number]> = [];
    const boot = fakeBoot((u, n) => { observeCalls.push([u, n]); return false; });
    const onRebootFn = vi.fn();
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      fetchUptimeMs: async () => 1234, now: () => 9999, onRebootFn, log: () => {}, logError: () => {},
    });
    await poller.pollOnceForTest();
    expect(observeCalls).toEqual([[1234, 9999]]);
    expect(onRebootFn).not.toHaveBeenCalled();
  });

  it("does not call observe() at all when the device is unreachable this tick", async () => {
    const { calib, limits } = stores();
    const boot = fakeBoot(() => false);
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      fetchUptimeMs: async () => undefined, onRebootFn: vi.fn(), log: () => {}, logError: () => {},
    });
    await poller.pollOnceForTest();
    expect(boot.observe).not.toHaveBeenCalled();
  });

  it("calls onReboot with the (already-incremented) bootId when observe() returns true, and logs an applied outcome", async () => {
    const { calib, limits } = stores();
    const boot = fakeBoot(() => true, 7);
    const onRebootFn = vi.fn(async (_a: OnRebootArgs) => ({ applied: true, deltaTiltDeg: 1.23, residualDeg: 0.04 }));
    const logs: string[] = [];
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      fetchUptimeMs: async () => 42, onRebootFn, log: (m) => logs.push(m), logError: () => {},
    });
    await poller.pollOnceForTest();
    expect(onRebootFn).toHaveBeenCalledTimes(1);
    expect(onRebootFn.mock.calls[0][0].bootId).toBe(7);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("boot 7");
    expect(logs[0]).toMatch(/tilt re-zeroed automatically/);
    expect(logs[0]).toContain("1.23");
    expect(logs[0]).toContain("0.04");
  });

  it("logs the refusal reason (not a fabricated success) when onReboot does not apply", async () => {
    const { calib, limits } = stores();
    const boot = fakeBoot(() => true, 3);
    const onRebootFn = vi.fn(async (_a: OnRebootArgs) => ({
      applied: false, residualDeg: 9.9, reason: "gravity does not fit an origin-only shift",
    }));
    const logs: string[] = [];
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      fetchUptimeMs: async () => 1, onRebootFn, log: (m) => logs.push(m), logError: () => {},
    });
    await poller.pollOnceForTest();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/NOT applied/);
    expect(logs[0]).toContain("gravity does not fit an origin-only shift");
  });
});

describe("BootWatchPoller (multi-tick loop behaviour, via a fake Scheduler)", () => {
  it("a rejected status read does not kill the loop -- a later tick still runs and still calls observe()", async () => {
    const { calib, limits } = stores();
    const { scheduler, fire } = fakeScheduler();
    let call = 0;
    const fetchUptimeMs = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("network down");
      return 500;
    });
    const observeCalls: number[] = [];
    const boot = fakeBoot((u) => { observeCalls.push(u); return false; });
    const logError = vi.fn();
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, onRebootFn: vi.fn(), log: () => {}, logError,
    });
    // start()'s own immediate tick IS tick 1 now (call 1, the rejection) --
    // it goes through the same try/catch as a scheduled tick, so it must not
    // reject start() itself. See the start()-specific describe block below
    // for that guarantee's own dedicated coverage.
    await poller.start();
    expect(logError).toHaveBeenCalledTimes(1);   // the rejection was caught, not swallowed silently
    expect(observeCalls).toEqual([]);            // tick 1 never reached observe() -- it rejected first

    fire();
    await flush();
    expect(observeCalls).toEqual([500]);         // the loop is still alive and ticking

    poller.stop();
  });

  it("a throwing onReboot does not kill the loop -- a later tick still runs onReboot again", async () => {
    const { calib, limits } = stores();
    const { scheduler, fire } = fakeScheduler();
    const boot = fakeBoot(() => true, 2);
    let call = 0;
    const onRebootFn = vi.fn(async (_a: OnRebootArgs) => {
      call += 1;
      if (call === 1) throw new Error("solve blew up");
      return { applied: true, deltaTiltDeg: 0.5, residualDeg: 0.1 };
    });
    const log = vi.fn();
    const logError = vi.fn();
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs: async () => 10, onRebootFn, log, logError,
    });
    // start()'s own immediate tick is now onRebootFn's first (throwing) call.
    await poller.start();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();

    fire();
    await flush();
    expect(onRebootFn).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);        // the SECOND tick's success was logged

    poller.stop();
  });

  it("skips a tick that fires while the previous one is still in flight, and resumes after it rejects (in-flight flag clears on the failure path, not just success)", async () => {
    const { calib, limits } = stores();
    const { scheduler, fire } = fakeScheduler();
    let calls = 0;
    let rejectSecond: ((e: unknown) => void) | null = null;
    const fetchUptimeMs = vi.fn(() => {
      calls += 1;
      // Call 1 is start()'s own immediate tick -- let it resolve uneventfully
      // so the SCHEDULED overlap under test below (calls 2 and 3) is exactly
      // the same shape this test pinned before start() grew an immediate
      // tick of its own.
      if (calls === 1) return Promise.resolve(1);
      if (calls === 2) return new Promise<number>((_res, rej) => { rejectSecond = rej; });
      return Promise.resolve(999);
    });
    const observeCalls: number[] = [];
    const boot = fakeBoot((u) => { observeCalls.push(u); return false; });
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, onRebootFn: vi.fn(), log: () => {}, logError: () => {},
    });
    await poller.start();
    expect(observeCalls).toEqual([1]);   // start()'s own immediate tick completed normally

    fire();                 // tick 2 (first SCHEDULED tick) starts, blocks on fetchUptimeMs (in flight)
    await flush();
    fire();                 // tick 3 -- must be skipped by the overlap guard
    await flush();
    expect(calls).toBe(2);  // fetchUptimeMs was NOT invoked a third time

    rejectSecond!(new Error("boom"));
    await flush();
    expect(observeCalls).toEqual([1]);   // tick 2 rejected before reaching observe() -- unchanged

    fire();                 // tick 4 -- only runs if the in-flight flag cleared on tick 2's REJECTION
    await flush();
    expect(calls).toBe(3);
    expect(observeCalls).toEqual([1, 999]);

    poller.stop();
  });

  it("observe() runs on every successful read across multiple ticks, not just when a reboot is suspected", async () => {
    const { calib, limits } = stores();
    const { scheduler, fire } = fakeScheduler();
    const observeCalls: number[] = [];
    const boot = fakeBoot((u) => { observeCalls.push(u); return false; });
    let n = 0;
    const fetchUptimeMs = vi.fn(async () => { n += 1000; return n; });
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, onRebootFn: vi.fn(), log: () => {}, logError: () => {},
    });
    // start()'s own immediate tick is the FIRST of these three reads.
    await poller.start();
    fire(); await flush();
    fire(); await flush();

    expect(observeCalls).toEqual([1000, 2000, 3000]);
    expect(fetchUptimeMs).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it("start()/stop() wire and unwire the scheduler -- a fire() after stop() does nothing", async () => {
    const { calib, limits } = stores();
    const { scheduler, fire } = fakeScheduler();
    const boot = fakeBoot(() => false);
    const fetchUptimeMs = vi.fn(async () => 1);
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, onRebootFn: vi.fn(), log: () => {}, logError: () => {},
    });
    await poller.start();
    poller.stop();
    fire();
    await flush();
    // The immediate tick from start() itself already used the fetch once;
    // stop() must prevent anything further.
    expect(fetchUptimeMs).toHaveBeenCalledTimes(1);
  });
});

// I-A: realScheduler.every is setInterval, whose first fire only happens at
// t+intervalMs -- so a daemon restart left needsRezero:false (the pre-reboot
// value read back off disk) for 5-11s before anything ran observe(). Every
// rezeroGuard-gated tool (point_at, start_tracking, ...) would run on that
// stale origin for the whole window. start() must arm the guard itself,
// synchronously (awaited) ahead of any scheduled tick -- server.ts awaits it
// before app.listen().
describe("BootWatchPoller.start (I-A: arms the guard before the server accepts requests)", () => {
  it("marks needsRezero via its OWN immediate tick, before returning -- not by waiting on a scheduled one", async () => {
    const { calib, limits } = stores();
    // A real reboot: observe() reports true, the way BootWatcher genuinely
    // would on the very first poll after a daemon restart (no in-memory
    // lastUptimeMs yet -- see boot-watch.ts).
    const boot = fakeBoot(() => true, 5);
    const { scheduler } = fakeScheduler();
    const fetchUptimeMs = vi.fn(async () => 12345);
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, log: () => {}, logError: () => {},
    });

    await poller.start();

    expect(calib.needsRezero()).toBe(true);
    // The immediate tick alone accounts for the read -- this file's fake
    // scheduler only fires when the test explicitly calls fire() (what a
    // real setInterval firing would trigger), which never happened here, so
    // if this were 2 it would mean the assertion above came from a
    // SCHEDULED tick instead of start()'s own immediate one.
    expect(fetchUptimeMs).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("remains safe when the device is unreachable on the immediate tick, and still schedules the recurring poll", async () => {
    const { calib, limits } = stores();
    const boot = fakeBoot(() => true, 2);
    const { scheduler, fire } = fakeScheduler();
    let calls = 0;
    const fetchUptimeMs = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("device unreachable");
      return 999;
    });
    const logError = vi.fn();
    const poller = new BootWatchPoller(boot, calib, limits, cfg, noGravity, zeroPosture, {
      scheduler, fetchUptimeMs, log: () => {}, logError,
    });

    // Must not reject even though the immediate tick's own fetch rejects --
    // the immediate tick shares pollOnce's try/catch/finally with every
    // scheduled tick.
    await expect(poller.start()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(calib.needsRezero()).toBe(false); // the failed read never reached observe()

    // The recurring interval must still have been scheduled despite the
    // immediate tick's failure -- a later, successful tick proves it.
    fire();
    await flush();
    expect(fetchUptimeMs).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});
