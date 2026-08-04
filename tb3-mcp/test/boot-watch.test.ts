import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectBoot, BootState, BootWatcher, UNKNOWN_GENERATION } from "../src/boot-watch.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("detectBoot", () => {
  it("first ever observation is not a reboot", () => {
    const r = detectBoot(undefined, 5_000, 1_000_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(1);
  });

  it("uptime going backwards is a reboot", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    const r = detectBoot(prev, 4_000, 1_010_000);
    expect(r.rebooted).toBe(true);
    expect(r.state.bootId).toBe(2);
  });

  it("uptime advancing normally is not a reboot", () => {
    const prev: BootState = { bootId: 3, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    const r = detectBoot(prev, 910_000, 1_010_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(3);
  });

  // The case polling alone cannot see: the daemon was down across the reboot.
  it("detects a reboot that happened while the daemon was not watching", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    // 10 minutes of wall clock elapsed, but the device claims only 30s of uptime.
    const r = detectBoot(prev, 30_000, 1_000_000 + 600_000);
    expect(r.rebooted).toBe(true);
    expect(r.state.bootId).toBe(2);
  });

  // Isolates the wasDownAcross detection: uptime goes UP but elapsed >> uptime + slack.
  // This proves the unobserved-reboot detection is working, not just the "uptime backwards" branch.
  it("isolates wasDownAcross: reboot detected even though uptime increased", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 10_000, lastSeenAtMs: 1_000_000 };
    // 600s wall-clock elapsed, but device claims only 20s of uptime.
    // Elapsed (600s) - uptime (20s) = 580s, which exceeds UNOBSERVED_SLACK_MS (30s).
    // Uptime did NOT go backwards (20s > 10s), so the "went backwards" branch must NOT fire.
    const r = detectBoot(prev, 20_000, 1_000_000 + 600_000);
    expect(r.rebooted).toBe(true);
    expect(r.state.bootId).toBe(2);
  });

  it("does not false-positive when the daemon restarts but the device did not", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    // 60s elapsed, uptime advanced by ~60s: same boot.
    const r = detectBoot(prev, 960_000, 1_060_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(1);
  });
});

describe("BootWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tb3-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("load() does not throw when the state file does not exist", () => {
    const filePath = join(tmpDir, "nonexistent.json");
    const watcher = new BootWatcher(filePath);
    expect(() => watcher.load()).not.toThrow();
    // First observe after a non-existent load is not a reboot (fresh baseline).
    const rebooted = watcher.observe(5_000, 1_000_000);
    expect(rebooted).toBe(false);
    expect(watcher.bootId()).toBe(1);
  });

  it("load() does not throw when the state file contains corrupt JSON", () => {
    const filePath = join(tmpDir, "corrupt.json");
    const fs = require("node:fs");
    fs.writeFileSync(filePath, "not valid json {");

    const watcher = new BootWatcher(filePath);
    expect(() => watcher.load()).not.toThrow();
    // A corrupt file is treated as missing: next observe is a non-reboot baseline.
    // NOTE: This is a deliberate trade-off. A corrupted state file masks a reboot,
    // but prevents a corrupt file from wedging daemon startup.
    const rebooted = watcher.observe(5_000, 1_000_000);
    expect(rebooted).toBe(false);
    expect(watcher.bootId()).toBe(1);
  });

  it("observe() persists state across BootWatcher instances", () => {
    const filePath = join(tmpDir, "state.json");

    // First instance: observe a non-reboot baseline.
    const watcher1 = new BootWatcher(filePath);
    watcher1.load();
    const rebooted1 = watcher1.observe(5_000, 1_000_000);
    expect(rebooted1).toBe(false);
    expect(watcher1.bootId()).toBe(1);

    // Second instance: load the persisted state and observe again (no reboot).
    const watcher2 = new BootWatcher(filePath);
    watcher2.load();
    const rebooted2 = watcher2.observe(10_000, 1_010_000);
    expect(rebooted2).toBe(false);
    expect(watcher2.bootId()).toBe(1);

    // Third instance: load persisted state and detect a reboot (uptime backwards).
    const watcher3 = new BootWatcher(filePath);
    watcher3.load();
    const rebooted3 = watcher3.observe(3_000, 1_020_000);
    expect(rebooted3).toBe(true);
    expect(watcher3.bootId()).toBe(2);

    // Fourth instance: load the new bootId.
    const watcher4 = new BootWatcher(filePath);
    watcher4.load();
    expect(watcher4.bootId()).toBe(2);
  });
});

// M-1: 0 is a plausible real generation (the very first boot observed), so it
// cannot double as "we don't know" -- an edge freshly taught under generation
// 5 with no boot.json on disk was shifted from -70 to -103 because the old
// "missing file -> 0" fallback read as boot generation 0 instead of unknown.
describe("unknown generation", () => {
  it("reports UNKNOWN_GENERATION, not 0, when no state file exists", () => {
    const w = new BootWatcher(join(mkdtempSync(join(tmpdir(), "tb3-")), "boot.json"));
    w.load();
    expect(w.bootId()).toBe(UNKNOWN_GENERATION);
    expect(w.bootId()).not.toBe(0);   // 0 is a plausible real generation
  });

  it("reports UNKNOWN_GENERATION when the state file is corrupt", () => {
    const p = join(mkdtempSync(join(tmpdir(), "tb3-")), "boot.json");
    writeFileSync(p, "not json {");
    const w = new BootWatcher(p);
    w.load();
    expect(w.bootId()).toBe(UNKNOWN_GENERATION);
  });
});
