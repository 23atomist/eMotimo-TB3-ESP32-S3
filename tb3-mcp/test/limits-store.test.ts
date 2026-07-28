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
    expect(b.get()).toEqual({ version: 1, panMin: -60, panMax: 45, tiltMin: -20, tiltMax: 30 });
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
