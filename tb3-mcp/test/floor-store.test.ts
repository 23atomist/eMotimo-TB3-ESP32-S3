import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FloorStore } from "../src/floor-store.js";
import { DISABLED_FLOOR } from "../src/track/floor.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb3-floor-"));
  path = join(dir, "floor.json");
});

describe("FloorStore", () => {
  it("starts disabled when the file does not exist", () => {
    const s = new FloorStore(path);
    s.load();
    expect(s.get()).toEqual(DISABLED_FLOOR);
  });

  it("round-trips through disk", () => {
    const a = new FloorStore(path);
    a.set({ enabled: true, minElevationDeg: 12.5 });
    const b = new FloorStore(path);
    b.load();
    expect(b.get()).toEqual({ enabled: true, minElevationDeg: 12.5 });
  });

  // Same contract as SectorStore: a corrupt or hand-edited file must never
  // throw on load. But note the DIRECTION of the fallback -- this guard is a
  // safety feature, and falling back to "disabled" means a corrupt file
  // silently unblocks the rig. That is the deliberate choice (matching the
  // sector, and never wedging tracking), so it is pinned here to make any
  // future change to it explicit.
  it("falls back to disabled on a corrupt file rather than throwing", () => {
    writeFileSync(path, "{ this is not json");
    const s = new FloorStore(path);
    expect(() => s.load()).not.toThrow();
    expect(s.get()).toEqual(DISABLED_FLOOR);
  });

  it("falls back to disabled when the schema does not match", () => {
    writeFileSync(path, JSON.stringify({ enabled: "yes", minElevationDeg: "high" }));
    const s = new FloorStore(path);
    s.load();
    expect(s.get()).toEqual(DISABLED_FLOOR);
  });

  it("rejects a non-finite elevation rather than persisting it", () => {
    writeFileSync(path, JSON.stringify({ enabled: true, minElevationDeg: null }));
    const s = new FloorStore(path);
    s.load();
    expect(s.get()).toEqual(DISABLED_FLOOR);
  });

  it("returns a copy, so a caller cannot mutate stored state", () => {
    const s = new FloorStore(path);
    s.set({ enabled: true, minElevationDeg: 8 });
    const got = s.get();
    got.minElevationDeg = 99;
    expect(s.get().minElevationDeg).toBe(8);
  });

  it("writes atomically and leaves no temp file behind", () => {
    const s = new FloorStore(path);
    s.set({ enabled: true, minElevationDeg: 5 });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ enabled: true, minElevationDeg: 5 });
  });
});
