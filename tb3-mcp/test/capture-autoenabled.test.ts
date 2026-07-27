import { describe, it, expect } from "vitest";
import { resolveCaptureAutoEnabled } from "../src/server.js";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";
import { loadConfig } from "../src/config.js";

// --- Fix round: item 4, 2026-07-26 final review ---
//
// Before this fix, the daemon constructed CaptureController with
// autoEnabled: cfg.captureAutoEnabled (default true) regardless of
// cfg.cameraSource. On every host that hasn't opted into
// cameraSource="mediamtx" -- mtplvcap and v4l2 are both non-mediamtx
// defaults -- capture's deps are hard-wired to a MediaMTX that isn't
// running, so EVERY track lock fired a refused loopback fetch to
// cameraMediamtxControlUrl, logged a disarmed warning, and pinned a
// permanent amber "Capture: skipped (disarmed)" chip.

describe("resolveCaptureAutoEnabled", () => {
  it("is inert on a default-config host (cameraSource defaults to mtplvcap)", () => {
    const cfg = loadConfig(undefined, {});
    expect(cfg.cameraSource).toBe("mtplvcap");
    expect(cfg.captureAutoEnabled).toBe(true); // the config default itself is unchanged...
    expect(resolveCaptureAutoEnabled(cfg)).toBe(false); // ...but capture stays inert
  });

  it("is inert on the v4l2 (MJPEG) source too, not only the mtplvcap default", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2" });
    expect(resolveCaptureAutoEnabled(cfg)).toBe(false);
  });

  it("is active once the host explicitly opts into cameraSource=mediamtx", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(resolveCaptureAutoEnabled(cfg)).toBe(true);
  });

  it("stays inert on a mediamtx host if the operator explicitly disabled auto capture", () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", TB3_CAPTURE_AUTO_ENABLED: "false" });
    expect(resolveCaptureAutoEnabled(cfg)).toBe(false);
  });
});

describe("a default-config daemon's capture controller does no capture work", () => {
  it("never calls isArmed() and shows no skip reason on a track lock", async () => {
    const cfg = loadConfig(undefined, {}); // defaults: cameraSource="mtplvcap"
    let armedCalls = 0;
    const deps: CaptureDeps = {
      setRecord: async () => {},
      snapshot: async (icao) => `/tmp/${icao}.jpg`,
      // If this ever fires, it's the exact refused loopback fetch to
      // cameraMediamtxControlUrl the bug report describes.
      isArmed: async () => { armedCalls++; return false; },
      now: () => Date.now(),
      nowIso: () => new Date().toISOString(),
    };
    const capture = new CaptureController(
      deps, { debounceMs: cfg.captureDebounceMs, autoEnabled: resolveCaptureAutoEnabled(cfg) },
    );

    capture.onTrack("tracking", "ABC123", "UAL123");

    expect(armedCalls).toBe(0);
    expect(capture.status().lastSkipReason).toBeNull();
    expect(capture.status().autoEnabled).toBe(false);
  });
});
