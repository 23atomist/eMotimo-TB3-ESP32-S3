import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCharacterizeImu } from "../src/imu-tools.js";
import { CalibrationStore } from "../src/calibration.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3 } from "../src/geo/vec3.js";

const field = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/imu-calib-field.json", import.meta.url)), "utf8"));

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

    const res = await runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store, isSunLocked: () => false,
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

    let calls = 0;
    const isSunLocked = () => { calls += 1; return calls > 2; }; // locks partway through the sweep

    await expect(runCharacterizeImu({
      positions, geoPanSign: -1, samplesPerPos: 100,
      moveTo, getGravity, store, isSunLocked,
    })).rejects.toThrow(/sun guard locked mid-sweep/);
    expect(store.getImuMounting()).toBeUndefined();
  });
});
