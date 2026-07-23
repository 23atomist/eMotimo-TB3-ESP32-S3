import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectorStore } from "../src/sector-store.js";
import { applySectorUpdate } from "../src/sector-tools.js";

const store = () => { const s = new SectorStore(join(mkdtempSync(join(tmpdir(), "st-")), "s.json")); s.load(); return s; };

describe("applySectorUpdate (the set_track_sector core)", () => {
  it("stores a valid sector and returns it", () => {
    const s = store();
    const r = applySectorUpdate(s, { startDeg: 300, endDeg: 60, enabled: true });
    expect(r).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
    expect(s.get()).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
  });

  it("rejects out-of-range bearings without persisting", () => {
    const s = store();
    expect(() => applySectorUpdate(s, { startDeg: -5, endDeg: 60, enabled: true })).toThrow();
    expect(() => applySectorUpdate(s, { startDeg: 0, endDeg: 400, enabled: true })).toThrow();
    expect(s.get().enabled).toBe(false);   // nothing persisted
  });
});
