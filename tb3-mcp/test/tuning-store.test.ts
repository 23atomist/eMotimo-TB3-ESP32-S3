import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuningStore } from "../src/tuning-store.js";

function store(): { s: TuningStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "tb3-")), "tuning.json");
  const s = new TuningStore(path); s.load();
  return { s, path };
}

describe("TuningStore", () => {
  it("starts empty and round-trips a patch through the file", () => {
    const { s, path } = store();
    expect(s.get()).toEqual({});
    s.set({ maxAimOffsetDeg: 30 });
    const b = new TuningStore(path); b.load();
    expect(b.get().maxAimOffsetDeg).toBe(30);
  });

  it("set() MERGES rather than replacing", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30 });
    s.set({ trackLeadMs: 400 });
    expect(s.get()).toEqual({ maxAimOffsetDeg: 30, trackLeadMs: 400 });
  });

  it("clear() removes one override and leaves the rest", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30, trackLeadMs: 400 });
    s.clear("maxAimOffsetDeg");
    expect(s.get()).toEqual({ trackLeadMs: 400 });
  });

  it("rejects an out-of-range value WITHOUT corrupting what is stored", () => {
    const { s } = store();
    s.set({ maxAimOffsetDeg: 30 });
    expect(() => s.set({ maxAimOffsetDeg: 90 })).toThrow();   // schema max is 45
    expect(s.get().maxAimOffsetDeg).toBe(30);                 // previous value intact
  });

  it("get() returns a copy, not a live reference into stored state", () => {
    const { s } = store();
    s.set({ trackLeadMs: 400 });
    const a = s.get();
    (a as { trackLeadMs?: number }).trackLeadMs = 9999;
    expect(s.get().trackLeadMs).toBe(400);
  });

  it("a missing file loads empty, and a corrupt file loads empty rather than throwing", () => {
    const { s } = store();
    expect(s.get()).toEqual({});
    const p2 = join(mkdtempSync(join(tmpdir(), "tb3-")), "tuning.json");
    writeFileSync(p2, "not json {");
    const c = new TuningStore(p2);
    expect(() => c.load()).not.toThrow();
    expect(c.get()).toEqual({});
  });
});
