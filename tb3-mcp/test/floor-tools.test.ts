import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorStore } from "../src/floor-store.js";
import { applyFloorUpdate } from "../src/floor-tools.js";
import { runAction, type ControlDeps } from "../src/dashboard/controls.js";

const store = () => {
  const s = new FloorStore(join(mkdtempSync(join(tmpdir(), "fl-")), "f.json"));
  s.load();
  return s;
};

describe("applyFloorUpdate (the set_min_track_elevation core)", () => {
  it("stores a valid floor and returns it", () => {
    const s = store();
    const r = applyFloorUpdate(s, { minElevationDeg: 12, enabled: true });
    expect(r).toEqual({ enabled: true, minElevationDeg: 12 });
    expect(s.get()).toEqual({ enabled: true, minElevationDeg: 12 });
  });

  it("rejects out-of-range elevations without persisting", () => {
    const s = store();
    expect(() => applyFloorUpdate(s, { minElevationDeg: 91, enabled: true })).toThrow();
    expect(() => applyFloorUpdate(s, { minElevationDeg: -91, enabled: true })).toThrow();
    expect(s.get().enabled).toBe(false);   // nothing persisted
  });

  it("rejects a non-finite elevation without persisting", () => {
    const s = store();
    expect(() => applyFloorUpdate(s, { minElevationDeg: NaN, enabled: true })).toThrow();
    expect(s.get().enabled).toBe(false);
  });

  // Negative floors stay legal: a rig on a hilltop may legitimately film below
  // level. The feature is "the operator chooses", not "above the horizon".
  it("accepts a negative floor", () => {
    const s = store();
    expect(applyFloorUpdate(s, { minElevationDeg: -10, enabled: true }))
      .toEqual({ enabled: true, minElevationDeg: -10 });
  });

  it("can disable the restriction while keeping the value", () => {
    const s = store();
    applyFloorUpdate(s, { minElevationDeg: 20, enabled: true });
    expect(applyFloorUpdate(s, { minElevationDeg: 20, enabled: false }))
      .toEqual({ enabled: false, minElevationDeg: 20 });
  });
});

describe("floor/set dashboard action", () => {
  const deps = (calls: unknown[][]): ControlDeps => ({
    setTrackFloor: async (minElevationDeg: number, enabled: boolean) => {
      calls.push([minElevationDeg, enabled]);
    },
  } as unknown as ControlDeps);

  it("forwards the elevation and enabled flag", async () => {
    const calls: unknown[][] = [];
    const r = await runAction(deps(calls), "floor/set", { min_elevation_deg: 15, enabled: true });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([[15, true]]);
  });

  it("treats a missing enabled flag as false rather than silently enabling", async () => {
    const calls: unknown[][] = [];
    await runAction(deps(calls), "floor/set", { min_elevation_deg: 15 });
    expect(calls).toEqual([[15, false]]);
  });
});
