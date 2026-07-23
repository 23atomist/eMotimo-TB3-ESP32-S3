import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectorStore } from "../src/sector-store.js";

const file = () => join(mkdtempSync(join(tmpdir(), "sector-")), "sector.json");

describe("SectorStore", () => {
  it("defaults to a disabled sector when the file is missing", () => {
    const s = new SectorStore(file());
    s.load();
    expect(s.get()).toEqual({ enabled: false, startDeg: 0, endDeg: 360 });
  });

  it("persists and reloads a sector", () => {
    const f = file();
    const a = new SectorStore(f);
    a.load();
    a.set({ enabled: true, startDeg: 300, endDeg: 60 });
    const b = new SectorStore(f);
    b.load();
    expect(b.get()).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
  });

  it("falls back to the disabled default on a corrupt file (never throws)", () => {
    const f = file();
    writeFileSync(f, "{ not json");
    const s = new SectorStore(f);
    s.load();
    expect(s.get().enabled).toBe(false);
  });

  it("get() returns a copy, not the internal reference", () => {
    const s = new SectorStore(file());
    s.load();
    const a = s.get();
    a.startDeg = 999;
    expect(s.get().startDeg).not.toBe(999);
  });
});
