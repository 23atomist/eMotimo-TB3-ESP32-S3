import { describe, it, expect, afterEach } from "vitest";
import { AimTrimStore } from "../src/aim-trim-store.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3trim-"));
  return join(dir, "sub", "aim-trim.json"); // nested dir must be created on save
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

describe("AimTrimStore", () => {
  it("starts at zero when no file exists", () => {
    const s = new AimTrimStore(tmpFile());
    s.load();
    expect(s.get()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("persists a trim and reloads it", () => {
    const f = tmpFile();
    const a = new AimTrimStore(f);
    a.set({ panDeg: -1.73, tiltDeg: -2.67 });
    const b = new AimTrimStore(f);
    b.load();
    expect(b.get()).toEqual({ panDeg: -1.73, tiltDeg: -2.67 });
  });

  // Same ceiling and same reasoning as the per-pass nudge (track/offset.ts):
  // a few degrees is a real boresight error, tens of degrees is a bug, and a
  // trim above trackReacquireDeg would read as "lost track" on every tick.
  it("clamps both axes to the configured ceiling", () => {
    const s = new AimTrimStore(tmpFile(), 5);
    s.set({ panDeg: 40, tiltDeg: -40 });
    expect(s.get()).toEqual({ panDeg: 5, tiltDeg: -5 });
  });

  it("clamps a value loaded from a hand-edited file too", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ version: 1, panDeg: 99, tiltDeg: -99 }));
    const s = new AimTrimStore(f, 5);
    s.load();
    expect(s.get()).toEqual({ panDeg: 5, tiltDeg: -5 });
  });

  it("a corrupt file loads as zero and does not throw", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{ not json");
    const s = new AimTrimStore(f);
    expect(() => s.load()).not.toThrow();
    expect(s.get()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("clear returns to zero and persists that", () => {
    const f = tmpFile();
    const a = new AimTrimStore(f);
    a.set({ panDeg: -1.7, tiltDeg: -2.6 });
    a.clear();
    const b = new AimTrimStore(f);
    b.load();
    expect(b.get()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });
});
