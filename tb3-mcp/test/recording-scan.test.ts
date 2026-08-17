import { describe, it, expect, afterEach } from "vitest";
import { scanRecordings, scanSnapshots, passesFromSnapshots } from "../src/recordings/scan.js";
import { RecordingFile } from "../src/recordings/join.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function tmpRoot(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3rec-"));
  mkdirSync(join(dir, "recordings"), { recursive: true });
  mkdirSync(join(dir, "keep"), { recursive: true });
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  return dir;
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function put(path: string, bytes = 10, mtimeMs?: number): void {
  writeFileSync(path, Buffer.alloc(bytes));
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe("scanRecordings", () => {
  it("returns parsed mp4s from both directories, marking kept ones", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"), 100);
    put(join(root, "keep", "2026-08-16T17-04-21_AAL556_a082ac.mp4"), 200);
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "keep") });
    expect(got).toHaveLength(2);
    expect(got.filter((f) => f.kept)).toHaveLength(1);
    expect(got.every((f) => f.id.length > 0)).toBe(true);
  });

  it("ignores non-recording files and missing directories", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "notes.txt"));
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"));
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "nope") });
    expect(got).toHaveLength(1);
  });

  it("gives distinct ids to files with the same basename in different dirs", () => {
    const root = tmpRoot();
    put(join(root, "recordings", "2026-08-16_19-16-12-734710.mp4"));
    put(join(root, "keep", "2026-08-16_19-16-12-734710.mp4"));
    const got = scanRecordings({ recordings: join(root, "recordings"), keep: join(root, "keep") });
    expect(new Set(got.map((f) => f.id)).size).toBe(2);
  });
});

describe("passesFromSnapshots", () => {
  it("synthesises a pass for a snapshot falling inside a file's window", () => {
    const start = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const files: RecordingFile[] = [{
      id: "f1", path: "/rec/a.mp4", name: "a.mp4",
      startedAtMs: start, endedAtMs: start + 300_000, sizeBytes: 1, kept: false,
    }];
    const snaps = [{ name: "a082ac-AAL556-x.jpg", path: "/s/a082ac-AAL556-x.jpg", icao: "a082ac", callsign: "AAL556", atMs: start + 2000 }];
    const got = passesFromSnapshots(snaps, files, 7000);
    expect(got).toHaveLength(1);
    expect(got[0].icao).toBe("a082ac");
    expect(got[0].callsign).toBe("AAL556");
    expect(got[0].snapshotFile).toBe("/s/a082ac-AAL556-x.jpg");
    expect(got[0].startedAtMs).toBe(start);
    expect(got[0].samples).toBe(0);
    expect(got[0].minRangeM).toBeNull();
  });

  it("ignores a snapshot that matches no recording", () => {
    const got = passesFromSnapshots(
      [{ name: "x.jpg", path: "/s/x.jpg", icao: "aaa", callsign: null, atMs: 1 }], [], 7000,
    );
    expect(got).toEqual([]);
  });

  it("keeps only the first snapshot per file", () => {
    const start = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const files: RecordingFile[] = [{
      id: "f1", path: "/rec/a.mp4", name: "a.mp4",
      startedAtMs: start, endedAtMs: start + 300_000, sizeBytes: 1, kept: false,
    }];
    const snaps = [
      { name: "b.jpg", path: "/s/b.jpg", icao: "bbb", callsign: null, atMs: start + 9000 },
      { name: "a.jpg", path: "/s/a.jpg", icao: "aaa", callsign: null, atMs: start + 2000 },
    ];
    const got = passesFromSnapshots(snaps, files, 7000);
    expect(got).toHaveLength(1);
    expect(got[0].icao).toBe("aaa");
  });
});

describe("scanSnapshots", () => {
  it("parses identity out of snapshot filenames", () => {
    const root = tmpRoot();
    put(join(root, "snapshots", "a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg"));
    put(join(root, "snapshots", "readme.md"));
    const got = scanSnapshots(join(root, "snapshots"));
    expect(got).toHaveLength(1);
    expect(got[0].callsign).toBe("AAL556");
  });
});
