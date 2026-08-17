import { describe, it, expect, afterEach } from "vitest";
import { PassJournal, PassRecord } from "../src/capture/pass-journal.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3pass-"));
  return join(dir, "sub", "passes.jsonl");
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function rec(over: Partial<PassRecord> = {}): PassRecord {
  return {
    id: "p1", icao: "a082ac", callsign: "AAL556",
    startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_060_000,
    snapshotFile: "/var/lib/tb3/snapshots/a082ac-AAL556-x.jpg",
    category: "A3", squawk: "1200", gsKt: 240, maxAltitudeM: 3000,
    minRangeM: 5700, maxElevationDeg: 31.2,
    azStartDeg: 350, azEndDeg: 40, azArcDeg: 50,
    meanPointingErrorDeg: 1.3, maxPointingErrorDeg: 2.9,
    waitingMs: 0, limitHitMs: 0, samples: 120,
    ...over,
  };
}

describe("PassJournal", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(new PassJournal(tmpFile()).list()).toEqual([]);
  });

  it("appends and reads back in order, creating nested dirs", () => {
    const f = tmpFile();
    const j = new PassJournal(f);
    j.append(rec({ id: "p1" }));
    j.append(rec({ id: "p2" }));
    const got = new PassJournal(f).list();
    expect(got.map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(got[0].callsign).toBe("AAL556");
  });

  it("skips a truncated final line instead of throwing", () => {
    const f = tmpFile();
    const j = new PassJournal(f);
    j.append(rec({ id: "p1" }));
    // Simulate a crash mid-write: append a truncated line after the good one.
    writeFileSync(f, '{"id":"p2","icao":"aaa', { flag: "a" });
    const got = new PassJournal(f).list();
    expect(got.map((r) => r.id)).toEqual(["p1"]);
  });

  it("skips a record missing required fields rather than failing the whole read", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ id: "bad" }) + "\n" + JSON.stringify(rec({ id: "good" })) + "\n");
    expect(new PassJournal(f).list().map((r) => r.id)).toEqual(["good"]);
  });

  it("tolerates unknown fields from a future version", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ ...rec(), somethingNew: 42 }) + "\n");
    expect(new PassJournal(f).list()).toHaveLength(1);
  });

  it("reports an empty list for a file that exists but cannot be read, rather than throwing", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(rec()) + "\n");
    chmodSync(f, 0o000);
    try {
      expect(() => new PassJournal(f).list()).not.toThrow();
      expect(new PassJournal(f).list()).toEqual([]);
    } finally {
      chmodSync(f, 0o644); // restore so afterEach's rmSync can clean up
    }
  });
});
