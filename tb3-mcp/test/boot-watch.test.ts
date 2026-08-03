import { describe, it, expect } from "vitest";
import { detectBoot, BootState } from "../src/boot-watch.js";

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

  it("does not false-positive when the daemon restarts but the device did not", () => {
    const prev: BootState = { bootId: 1, lastUptimeMs: 900_000, lastSeenAtMs: 1_000_000 };
    // 60s elapsed, uptime advanced by ~60s: same boot.
    const r = detectBoot(prev, 960_000, 1_060_000);
    expect(r.rebooted).toBe(false);
    expect(r.state.bootId).toBe(1);
  });
});
