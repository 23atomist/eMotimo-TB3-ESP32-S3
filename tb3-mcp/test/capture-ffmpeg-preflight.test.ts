import { describe, it, expect } from "vitest";
import { assertCaptureFfmpegUsable } from "../src/capture/ffmpeg-preflight.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";
import { loadConfig } from "../src/config.js";

// --- Fix round: item 6, 2026-07-26 final review ---
//
// captureFfmpegBin (schema default: bare "ffmpeg") had no preflight at all,
// unlike the dashboard's cameraFfmpegBin (assertFfmpegUsable). On a systemd
// unit with a minimal PATH, every snapshot silently failed, surfaced only
// via the sticky lastError from item 5, with no mention in HOST-SETUP.md.

describe("assertCaptureFfmpegUsable", () => {
  it("resolves for the schema default 'ffmpeg' when it is resolvable on PATH", async () => {
    const cfg = loadConfig(undefined, {});
    await expect(assertCaptureFfmpegUsable(cfg)).resolves.toBeUndefined();
  });

  it("rejects with a message naming the missing path and the config key", async () => {
    const cfg = loadConfig(undefined, { TB3_CAPTURE_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg" });
    await expect(assertCaptureFfmpegUsable(cfg)).rejects.toThrow(/\/nope\/does\/not\/exist\/ffmpeg/);
    await expect(assertCaptureFfmpegUsable(cfg)).rejects.toThrow(/captureFfmpegBin/);
  });

  it("rejects a directory path (directories pass fs.access but spawn fails)", async () => {
    const cfg = loadConfig(undefined, { TB3_CAPTURE_FFMPEG_BIN: "/tmp" });
    await expect(assertCaptureFfmpegUsable(cfg)).rejects.toThrow(/captureFfmpegBin/);
  });
});

// Proves the plumbing item 6's daemon-side fix relies on: a startup
// preflight failure must surface into status().lastError the SAME way a
// runtime capture failure already does, using the exact field
// get_capture_status (and therefore the dashboard's "Capture: ERROR" chip)
// already reads -- see src/server.ts's main(), which calls
// capture.reportError() when assertCaptureFfmpegUsable() rejects.
describe("CaptureController.reportError", () => {
  it("surfaces a startup preflight failure the same way a runtime one would", () => {
    const deps: CaptureDeps = {
      setRecord: async () => {},
      snapshot: async (icao) => `/tmp/${icao}.jpg`,
      isArmed: async () => true,
      now: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    };
    const c = new CaptureController(deps, { debounceMs: 5000, autoEnabled: true });
    expect(c.status().lastError).toBeNull();

    c.reportError("startup preflight", new Error("captureFfmpegBin=\"ffmpeg\" cannot be executed (ENOENT)"));

    expect(c.status().lastError).toContain("startup preflight");
    expect(c.status().lastError).toContain("ENOENT");
  });
});
