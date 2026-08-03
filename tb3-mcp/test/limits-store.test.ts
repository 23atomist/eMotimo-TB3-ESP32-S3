import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitsStore, effectiveLimits, CeilingLimits } from "../src/limits-store.js";

const file = () => join(mkdtempSync(join(tmpdir(), "limits-")), "limits.json");

const CEILING: CeilingLimits = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };

describe("LimitsStore", () => {
  it("defaults to nothing taught when the file is missing", () => {
    const s = new LimitsStore(file());
    s.load();
    expect(s.get()).toEqual({ version: 1 });
  });

  it("persists and reloads a taught edge", () => {
    const f = file();
    const a = new LimitsStore(f);
    a.load();
    a.setEdge("tiltMin", -40);
    const b = new LimitsStore(f);
    b.load();
    expect(b.get().tiltMin).toBe(-40);
  });

  it("persists all four edges independently", () => {
    const f = file();
    const a = new LimitsStore(f);
    a.load();
    a.setEdge("panMin", -60);
    a.setEdge("panMax", 45);
    a.setEdge("tiltMin", -20);
    a.setEdge("tiltMax", 30);
    const b = new LimitsStore(f);
    b.load();
    // edgeBootId stamps each edge with the boot generation it was taught
    // under (see setEdge/shiftToOffset) -- {} here because no bootId has ever
    // been set, so every stamp round-trips as undefined and JSON drops it.
    expect(b.get()).toEqual({
      version: 1, panMin: -60, panMax: 45, tiltMin: -20, tiltMax: 30, edgeBootId: {},
    });
  });

  it("falls back to nothing taught on a corrupt file (never throws)", () => {
    const f = file();
    writeFileSync(f, "{ not json");
    const s = new LimitsStore(f);
    expect(() => s.load()).not.toThrow();
    expect(s.get()).toEqual({ version: 1 });
  });

  it("get() returns a copy, not the internal reference", () => {
    const s = new LimitsStore(file());
    s.load();
    const a = s.get();
    a.panMin = -999;
    expect(s.get().panMin).not.toBe(-999);
  });

  it("get() returns a deep copy that does not share nested objects", () => {
    const s = new LimitsStore(file());
    s.load();
    s.setAppliedOffset(10.5, 20.5);
    const a = s.get();
    if (a.appliedOffset) {
      a.appliedOffset.panDeg = 999;  // mutate nested object from get()
    }
    const b = s.get();
    expect(b.appliedOffset?.panDeg).toBe(10.5);  // should be unchanged
  });

  it("clear() erases every taught edge and persists the clear", () => {
    const f = file();
    const a = new LimitsStore(f);
    a.load();
    a.setEdge("panMin", -60);
    a.clear();
    expect(a.get()).toEqual({ version: 1 });
    const b = new LimitsStore(f);
    b.load();
    expect(b.get()).toEqual({ version: 1 });
  });
});

describe("effectiveLimits", () => {
  it("falls back to the config ceiling when nothing is taught", () => {
    expect(effectiveLimits(CEILING, {})).toEqual(CEILING);
  });

  it("a taught edge tighter than the ceiling narrows that side only", () => {
    const eff = effectiveLimits(CEILING, { panMax: 45 });
    expect(eff).toEqual({ panMin: -180, panMax: 45, tiltMin: -90, tiltMax: 90 });
  });

  it("all four edges taught narrows every side", () => {
    const eff = effectiveLimits(CEILING, { panMin: -60, panMax: 45, tiltMin: -20, tiltMax: 30 });
    expect(eff).toEqual({ panMin: -60, panMax: 45, tiltMin: -20, tiltMax: 30 });
  });

  // Defence in depth: even if a stale taught value somehow exceeds the
  // ceiling (e.g. the ceiling was tightened in config.json after teaching),
  // effectiveLimits() itself never returns something wider than the ceiling.
  it("re-clamps a taught edge that is wider than the ceiling instead of trusting it", () => {
    const eff = effectiveLimits(CEILING, { panMin: -200, tiltMax: 120 });
    expect(eff.panMin).toBe(-180);
    expect(eff.tiltMax).toBe(90);
  });
});

describe("re-zero limit maintenance", () => {
  function store(): LimitsStore {
    const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json"));
    s.load();
    return s;
  }

  it("shiftAxis moves only the named axis", () => {
    const s = store();
    s.setEdge("panMin", -90); s.setEdge("panMax", 36);
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    s.shiftAxis("tilt", 23.33);
    expect(s.get().tiltMin).toBeCloseTo(3.33, 6);
    expect(s.get().tiltMax).toBeCloseTo(57.33, 6);
    expect(s.get().panMin).toBe(-90);
    expect(s.get().panMax).toBe(36);
  });

  it("clearAxis drops one axis and leaves the other taught", () => {
    const s = store();
    s.setEdge("panMin", -90); s.setEdge("tiltMin", -20);
    s.clearAxis("pan");
    expect(s.get().panMin).toBeUndefined();
    expect(s.get().tiltMin).toBe(-20);
  });

  it("shiftAxis on an untaught axis is a no-op, not a NaN", () => {
    const s = store();
    s.shiftAxis("pan", 10);
    expect(s.get().panMin).toBeUndefined();
    expect(s.get().panMax).toBeUndefined();
  });

  it("shifting preserves where the rig sits relative to its limits", () => {
    // The escape guarantee in track/control.ts's axisBlocked depends only on
    // where `cur` sits relative to min/max -- it permits the direction that
    // moves back into range. Shifting both edges by the same offset preserves
    // that relationship exactly, so a rig parked outside its range before the
    // shift is still outside, and still able to escape, after it.
    const s = store();
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    const before = -28.64;              // measured 2026-08-02: parked below tiltMin
    const d = 23.33;
    s.shiftAxis("tilt", d);
    expect(before < -20).toBe(true);
    expect(before + d < (s.get().tiltMin as number)).toBe(true);
    expect((s.get().tiltMax as number) - (s.get().tiltMin as number)).toBeCloseTo(54, 6);
  });

  it("bootId round-trips", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json");
    const a = new LimitsStore(path); a.load(); a.setBootId(4);
    const b = new LimitsStore(path); b.load();
    expect(b.getBootId()).toBe(4);
  });
});

describe("appliedOffset", () => {
  it("defaults to zero and round-trips through the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json");
    const a = new LimitsStore(path); a.load();
    expect(a.getAppliedOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    a.setAppliedOffset(16.4, 23.33);
    const b = new LimitsStore(path); b.load();
    expect(b.getAppliedOffset()).toEqual({ panDeg: 16.4, tiltDeg: 23.33 });
  });

  // The delta is what makes repeated re-zeros safe for the limits.
  it("shifting by the delta twice equals shifting once", () => {
    const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json"));
    s.load();
    s.setEdge("tiltMin", -20); s.setEdge("tiltMax", 34);
    const applyCumulative = (tiltTotal: number) => {
      const prev = s.getAppliedOffset();
      s.shiftAxis("tilt", -(tiltTotal - prev.tiltDeg));
      s.setAppliedOffset(prev.panDeg, tiltTotal);
    };
    applyCumulative(23.33);
    const once = { ...s.get() };
    applyCumulative(23.33);                       // same cumulative value again
    expect(s.get().tiltMin).toBeCloseTo(once.tiltMin as number, 9);
    expect(s.get().tiltMax).toBeCloseTo(once.tiltMax as number, 9);
  });

  it("getAppliedOffset returns a copy, not a live reference into state", () => {
    const s = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "limits.json"));
    s.load();
    s.setAppliedOffset(10.5, 20.5);
    const offset1 = s.getAppliedOffset();
    offset1.panDeg = 999;  // mutate the returned object
    const offset2 = s.getAppliedOffset();
    expect(offset2.panDeg).toBe(10.5);  // should be unchanged
    expect(offset2.tiltDeg).toBe(20.5);
  });
});
