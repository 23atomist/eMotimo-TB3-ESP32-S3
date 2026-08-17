import { describe, it, expect, afterEach } from "vitest";
import { keepRecording, unkeepRecording, keepDirUsage } from "../src/recordings/keep.js";
import { RecordingFile } from "../src/recordings/join.js";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | null = null;
function root(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3keep-"));
  mkdirSync(join(dir, "recordings"), { recursive: true });
  return dir;
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function src(r: string, name = "2026-08-16_19-16-12-734710.mp4"): RecordingFile {
  const path = join(r, "recordings", name);
  writeFileSync(path, "video-bytes");
  return {
    id: "f1", path, name,
    startedAtMs: new Date(2026, 7, 16, 19, 16, 12).getTime(),
    endedAtMs: Date.now(), sizeBytes: 11, kept: false,
  };
}

describe("keepRecording", () => {
  it("hardlinks rather than copying, so the data is shared", () => {
    const r = root();
    const f = src(r);
    const out = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    expect(out.method).toBe("link");
    expect(out.path.endsWith("2026-08-16T19-16-12_AAL556_a082ac.mp4")).toBe(true);
    expect(statSync(out.path).ino).toBe(statSync(f.path).ino);
    expect(statSync(out.path).nlink).toBe(2);
  });

  it("survives deletion of the original, which is the whole point", () => {
    const r = root();
    const f = src(r);
    const out = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    rmSync(f.path);                       // MediaMTX's 7-day purge
    expect(existsSync(out.path)).toBe(true);
    expect(readFileSync(out.path, "utf8")).toBe("video-bytes");
  });

  it("is idempotent", () => {
    const r = root();
    const f = src(r);
    const a = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    const b = keepRecording(f, join(r, "keep"), "AAL556", "a082ac");
    expect(b.path).toBe(a.path);
    expect(keepDirUsage(join(r, "keep")).files).toBe(1);
  });

  it("creates the keep directory when missing", () => {
    const r = root();
    const out = keepRecording(src(r), join(r, "keep", "nested"), null, "a082ac");
    expect(existsSync(out.path)).toBe(true);
  });
});

describe("unkeepRecording", () => {
  it("drops the keep link without touching the original", () => {
    const r = root();
    const f = src(r);
    const keepDir = join(r, "keep");
    const out = keepRecording(f, keepDir, "AAL556", "a082ac");
    unkeepRecording({ ...f, id: "k1", path: out.path, name: "x.mp4", kept: true }, keepDir);
    expect(existsSync(out.path)).toBe(false);
    expect(existsSync(f.path)).toBe(true);
  });

  it("refuses to unkeep a file that is not marked kept", () => {
    const r = root();
    const f = src(r);
    const keepDir = join(r, "keep");
    expect(() => unkeepRecording(f, keepDir)).toThrow(/not a kept/i);
    expect(existsSync(f.path)).toBe(true);
  });

  it("refuses to unkeep a path outside the keep dir even when kept is true", () => {
    const r = root();
    const f = src(r);   // f.path lives under recordings/, never linked into keep/
    const keepDir = join(r, "keep");
    mkdirSync(keepDir, { recursive: true });
    expect(() => unkeepRecording({ ...f, kept: true }, keepDir)).toThrow();
    expect(existsSync(f.path)).toBe(true);
  });

  it("refuses a path that merely shares a keep-dir prefix, not a real subdirectory", () => {
    // A naive `resolvedPath.startsWith(resolvedKeepDir)` check would let this
    // through, because "keep-evil" textually starts with "keep" -- this is
    // exactly the traversal shape that check must reject.
    const r = root();
    const keepDir = join(r, "keep");
    mkdirSync(keepDir, { recursive: true });
    const evilDir = join(r, "keep-evil");
    mkdirSync(evilDir, { recursive: true });
    const evilPath = join(evilDir, "x.mp4");
    writeFileSync(evilPath, "evil-bytes");
    const evilFile: RecordingFile = {
      id: "evil", path: evilPath, name: "x.mp4",
      startedAtMs: Date.now(), endedAtMs: Date.now(), sizeBytes: 11, kept: true,
    };
    expect(() => unkeepRecording(evilFile, keepDir)).toThrow();
    expect(existsSync(evilPath)).toBe(true);
  });
});

describe("keepDirUsage", () => {
  it("reports zero for a missing directory", () => {
    expect(keepDirUsage(join(root(), "nope"))).toEqual({ files: 0, bytes: 0 });
  });

  it("reports zero for a directory that exists but cannot be read, rather than throwing", () => {
    const r = root();
    const keepDir = join(r, "keep");
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(keepDir, "a.mp4"), "x");
    chmodSync(keepDir, 0o000);
    try {
      expect(() => keepDirUsage(keepDir)).not.toThrow();
      expect(keepDirUsage(keepDir)).toEqual({ files: 0, bytes: 0 });
    } finally {
      chmodSync(keepDir, 0o755); // restore so afterEach's rmSync can clean up
    }
  });
});
