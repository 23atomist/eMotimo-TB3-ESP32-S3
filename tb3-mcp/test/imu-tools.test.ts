import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCharacterizeImu, panSweepGuard } from "../src/imu-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { LimitsStore } from "../src/limits-store.js";
import { BootWatcher } from "../src/boot-watch.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

// Never taught -- panMin/panMax both undefined, the state onReboot's
// clearAxis("pan") leaves behind on every exit path (rezero-tools.ts).
function untaughtLimits(): LimitsStore {
  const l = new LimitsStore(join(mkdtempSync(join(tmpdir(), "limits-")), "limits.json"));
  l.load();
  return l;
}

describe("characterize_imu core (runCharacterizeImu)", () => {
  it("sweeps, reads gravity, solves R_s, and persists it", async () => {
    // Map each swept position to the field gravity sample so the solve is exercised
    // end-to-end against the golden R_s.
    const byPos = new Map<string, Vec3>();
    for (const s of field.sweep) byPos.set(`${s.pan},${s.tilt}`, normalize([s.ax, s.ay, s.az] as Vec3));
    const positions = field.sweep.map((s: { pan: number; tilt: number }) => ({ panDeg: s.pan, tiltDeg: s.tilt }));

    const getGravity = vi.fn(async () => byPos.get(`${cur.pan},${cur.tilt}`)!);
    let cur = { pan: 0, tilt: 0 };
    const moveTo = vi.fn(async (p: number, t: number) => { cur = { pan: p, tilt: t }; });

    const f = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");
    const store = new CalibrationStore(f); store.load();
    const boot = new BootWatcher(join(mkdtempSync(join(tmpdir(), "cal-")), "boot.json")); boot.load();

    const res = await runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store, isSunLocked: () => false, boot, limits: untaughtLimits(),
    });
    expect(res.rmsDeg).toBeLessThan(1.7);
    const gold = [[0.986919, 0.106064, 0.121417], [0.028234, -0.855185, 0.517554], [0.158728, -0.507355, -0.846992]];
    const rS = store.getImuMounting()!.rS;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(rS[i][j]).toBeCloseTo(gold[i][j], 2);
  });

  it("aborts mid-sweep when the sun guard trips, persisting nothing", async () => {
    const byPos = new Map<string, Vec3>();
    for (const s of field.sweep) byPos.set(`${s.pan},${s.tilt}`, normalize([s.ax, s.ay, s.az] as Vec3));
    const positions = field.sweep.map((s: { pan: number; tilt: number }) => ({ panDeg: s.pan, tiltDeg: s.tilt }));

    const getGravity = vi.fn(async () => byPos.get(`${cur.pan},${cur.tilt}`)!);
    let cur = { pan: 0, tilt: 0 };
    const moveTo = vi.fn(async (p: number, t: number) => { cur = { pan: p, tilt: t }; });

    const f = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");
    const store = new CalibrationStore(f); store.load();
    const boot = new BootWatcher(join(mkdtempSync(join(tmpdir(), "cal-")), "boot.json")); boot.load();

    let calls = 0;
    const isSunLocked = () => { calls += 1; return calls > 2; }; // locks partway through the sweep

    await expect(runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store, isSunLocked, boot, limits: untaughtLimits(),
    })).rejects.toThrow(/sun guard locked mid-sweep/);
    expect(store.getImuMounting()).toBeUndefined();
  });
});

// I-B: after a reboot, onReboot clears the taught pan limits on every exit
// path (rezero-tools.ts) and marks needsRezero, so effLimits() silently
// falls back to the bare config ceiling for pan. sweepPositionsFor() derives
// its waypoints from exactly that effective range -- with a +-180deg config
// ceiling that is a ~354deg unattended pan sweep, and re-characterizing
// right after a reboot is a natural next step for an operator to take.
// panSweepGuard (imu-tools.ts) closes this: runCharacterizeImu refuses
// outright, before any moveTo, whenever pan is untaught AND a re-zero is
// pending.
describe("runCharacterizeImu refuses the sweep when pan is untaught and a re-zero is pending (I-B)", () => {
  function calibNeedingRezero(): CalibrationStore {
    const f = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json");
    const store = new CalibrationStore(f);
    store.load();
    store.markRezeroNeeded(2);
    return store;
  }
  function freshBoot(): BootWatcher {
    const b = new BootWatcher(join(mkdtempSync(join(tmpdir(), "boot-")), "boot.json"));
    b.load();
    return b;
  }

  it("panSweepGuard itself: refuses only when BOTH pan is untaught AND a re-zero is pending", () => {
    const untaught = untaughtLimits();
    const taught = untaughtLimits();
    taught.setEdge("panMin", -90);
    taught.setEdge("panMax", 90);
    const needsRezero = calibNeedingRezero();
    const clean = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "cal-")), "cal.json"));
    clean.load();

    expect(panSweepGuard(untaught, needsRezero)).toMatch(/pan/i);
    expect(panSweepGuard(untaught, needsRezero)).toMatch(/re-zero|rezero/i);
    // Pan re-taught since the reboot -> no refusal, even with a re-zero pending.
    expect(panSweepGuard(taught, needsRezero)).toBeUndefined();
    // No re-zero pending -> no refusal, even with pan untaught.
    expect(panSweepGuard(untaught, clean)).toBeUndefined();
  });

  it("refuses the resweep outright, before any moveTo is issued, naming pan and the pending re-zero", async () => {
    const store = calibNeedingRezero();
    const boot = freshBoot();
    const moveTo = vi.fn(async () => {});
    const getGravity = vi.fn(async () => [0, 0, 1] as Vec3);

    const call = runCharacterizeImu({
      positions: [{ panDeg: 0, tiltDeg: 0 }, { panDeg: 30, tiltDeg: 30 }],
      geoPanSign: -1, samplesPerPos: 1,
      moveTo, getGravity, store, isSunLocked: () => false, boot,
      limits: untaughtLimits(),
    });
    await expect(call).rejects.toThrow(/pan/i);
    // A fresh promise for the second assertion -- the first one already
    // settled (rejected) and awaiting it again is fine, but a second
    // independent call keeps this from depending on vitest's handling of a
    // shared, already-rejected promise across two `rejects.toThrow` calls.
    const store2 = calibNeedingRezero();
    await expect(runCharacterizeImu({
      positions: [{ panDeg: 0, tiltDeg: 0 }], geoPanSign: -1, samplesPerPos: 1,
      moveTo, getGravity, store: store2, isSunLocked: () => false, boot: freshBoot(),
      limits: untaughtLimits(),
    })).rejects.toThrow(/re-zero|rezero/i);

    expect(moveTo).not.toHaveBeenCalled();        // refused before any motion was commanded
    expect(store.getImuMounting()).toBeUndefined(); // nothing persisted from the refused sweep
  });

  it("proceeds with a real resweep when pan IS taught, even while a re-zero is still pending", async () => {
    const byPos = new Map<string, Vec3>();
    for (const s of field.sweep) byPos.set(`${s.pan},${s.tilt}`, normalize([s.ax, s.ay, s.az] as Vec3));
    const positions = field.sweep.map((s: { pan: number; tilt: number }) => ({ panDeg: s.pan, tiltDeg: s.tilt }));

    const getGravity = vi.fn(async () => byPos.get(`${cur.pan},${cur.tilt}`)!);
    let cur = { pan: 0, tilt: 0 };
    const moveTo = vi.fn(async (p: number, t: number) => { cur = { pan: p, tilt: t }; });

    const store = calibNeedingRezero();
    const boot = freshBoot();
    const limits = untaughtLimits();
    limits.setEdge("panMin", -170);
    limits.setEdge("panMax", 170);

    const res = await runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store, isSunLocked: () => false, boot, limits,
    });
    expect(res.rmsDeg).toBeLessThan(1.7);
    expect(moveTo).toHaveBeenCalledTimes(positions.length);
  });
});
