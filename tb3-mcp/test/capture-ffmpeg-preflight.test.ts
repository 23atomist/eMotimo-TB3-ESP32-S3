import { describe, it, expect } from "vitest";
import { assertCaptureFfmpegUsable } from "../src/capture/ffmpeg-preflight.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";
import { checkCaptureConfig, resolveCaptureAutoEnabled } from "../src/server.js";
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

function fakeCaptureDeps(): CaptureDeps {
  return {
    setRecord: async () => {},
    snapshot: async (icao) => `/tmp/${icao}.jpg`,
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
}

// Proves the plumbing item 6's daemon-side fix relies on: a startup
// preflight failure must surface into status().lastError the SAME way a
// runtime capture failure already does, using the exact field
// get_capture_status (and therefore the dashboard's "Capture: ERROR" chip)
// already reads -- see src/server.ts's checkCaptureConfig(), which calls
// capture.reportError() when assertCaptureFfmpegUsable() rejects.
describe("CaptureController.reportError", () => {
  it("surfaces a startup preflight failure the same way a runtime one would", () => {
    const c = new CaptureController(fakeCaptureDeps(), { debounceMs: 5000, autoEnabled: true });
    expect(c.status().lastError).toBeNull();

    c.reportError("snapshot", "startup preflight", new Error("captureFfmpegBin=\"ffmpeg\" cannot be executed (ENOENT)"));

    expect(c.status().lastError).toContain("startup preflight");
    expect(c.status().lastError).toContain("ENOENT");
  });

  it("a preflight-reported error (category snapshot) clears on the next successful snapshot, like any other", async () => {
    const c = new CaptureController(fakeCaptureDeps(), { debounceMs: 5000, autoEnabled: true });
    c.reportError("snapshot", "startup preflight", new Error("ENOENT"));
    expect(c.status().lastError).toContain("ENOENT");

    await c.manualSnapshot("XYZ");
    expect(c.status().lastError).toBeNull();
  });
});

// --- Fix round: NEW-2, second final-review pass (2026-07-26) ---
//
// checkCaptureConfig() used to preflight captureFfmpegBin unconditionally.
// On a v4l2 (MJPEG) host, that config key is irrelevant -- capture itself
// is inert there (item 4) -- but the preflight still pinned lastError via
// reportError(), and because capture never runs, NOTHING ever succeeds to
// clear it: a permanent red "Capture: ERROR" on a host where capture is
// deliberately disabled. Gating on resolveCaptureAutoEnabled() (the same
// helper item 4 introduced) fixes it. mediamtx is now the DEFAULT source,
// so "capture is inert" is exercised explicitly via TB3_CAMERA_SOURCE=v4l2.
describe("checkCaptureConfig", () => {
  it("reports NO error at all on a v4l2 (inert-capture) host, even with a broken captureFfmpegBin", async () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "v4l2", TB3_CAPTURE_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg",
    });
    expect(resolveCaptureAutoEnabled(cfg)).toBe(false); // capture is inert here (item 4)
    const capture = new CaptureController(fakeCaptureDeps(), { debounceMs: 5000, autoEnabled: false });

    await checkCaptureConfig(cfg, capture);

    expect(capture.status().lastError).toBeNull();
  });

  it("(control) the SAME broken captureFfmpegBin DOES report an error on a mediamtx host", async () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx", TB3_CAPTURE_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg",
    });
    const capture = new CaptureController(fakeCaptureDeps(), { debounceMs: 5000, autoEnabled: true });

    await checkCaptureConfig(cfg, capture);

    expect(capture.status().lastError).toContain("captureFfmpegBin");
  });

  it("reports nothing on a mediamtx host with a WORKING captureFfmpegBin", async () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    const capture = new CaptureController(fakeCaptureDeps(), { debounceMs: 5000, autoEnabled: true });

    await checkCaptureConfig(cfg, capture);

    expect(capture.status().lastError).toBeNull();
  });
});
