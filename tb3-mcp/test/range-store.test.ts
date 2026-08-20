import { describe, it, expect, afterEach } from "vitest";
import { RangeStore } from "../src/range-store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3rng-"));
  return join(dir, "sub", "range.json");
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

describe("RangeStore", () => {
  it("returns the default when no file exists", () => {
    const s = new RangeStore(tmpFile(), 25);
    s.load();
    expect(s.get()).toBe(25);
  });

  it("persists and reloads a set value", () => {
    const f = tmpFile();
    const a = new RangeStore(f, 25);
    a.set(120);
    const b = new RangeStore(f, 25);
    b.load();
    expect(b.get()).toBe(120);
  });

  it("falls back to the default on a corrupt file", () => {
    const f = tmpFile();
    const a = new RangeStore(f, 25);
    a.set(12);
    writeFileSync(f, "{ not json");
    const b = new RangeStore(f, 25);
    b.load();
    expect(b.get()).toBe(25);
  });

  it("rejects a non-positive range", () => {
    const s = new RangeStore(tmpFile(), 25);
    expect(() => s.set(0)).toThrow();
    expect(() => s.set(-5)).toThrow();
  });
});
