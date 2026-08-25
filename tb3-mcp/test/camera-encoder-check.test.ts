import { describe, it, expect } from "vitest";
import { parseEncoderList, assertEncoderAvailable, assertFfmpegUsable } from "../src/dashboard/camera/encoder-check.js";
import { loadConfig } from "../src/config.js";

// Real shape of `ffmpeg -encoders` output, including the header it must skip.
const SAMPLE = `Encoders:
 V..... = Video
 ------
 V..... h264_v4l2m2m         V4L2 mem2mem H.264 encoder wrapper (codec h264)
 V....D h264_vulkan          H.264/AVC (Vulkan) (codec h264)
 A..... aac                  AAC (Advanced Audio Coding)
`;

describe("parseEncoderList", () => {
  it("extracts encoder names and skips the header", () => {
    const s = parseEncoderList(SAMPLE);
    expect(s.has("h264_vulkan")).toBe(true);
    expect(s.has("h264_v4l2m2m")).toBe(true);
    expect(s.has("aac")).toBe(true);
    expect(s.has("Encoders:")).toBe(false);
    expect(s.has("=")).toBe(false);
  });

  it("returns an empty set for empty output", () => {
    expect(parseEncoderList("").size).toBe(0);
  });
});

describe("assertEncoderAvailable", () => {
  const cfg = (enc: string) => loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", TB3_CAMERA_ENCODER: enc });

  it("passes when the encoder is present", () => {
    expect(() => assertEncoderAvailable(cfg("vulkan"), parseEncoderList(SAMPLE))).not.toThrow();
  });

  it("throws a remediation message naming the missing encoder", () => {
    expect(() => assertEncoderAvailable(cfg("nvenc"), parseEncoderList(SAMPLE)))
      .toThrow(/h264_nvenc/);
  });

  it("lists what IS available so the operator can pick", () => {
    expect(() => assertEncoderAvailable(cfg("x264"), parseEncoderList(SAMPLE)))
      .toThrow(/h264_vulkan/);
  });

  it("never throws for copy -- no encoder is required", () => {
    expect(() => assertEncoderAvailable(cfg("copy"), new Set())).not.toThrow();
  });

  it("skips the check entirely when the source is not mediamtx", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_ENCODER: "nvenc" });
    expect(() => assertEncoderAvailable(c, new Set())).not.toThrow();
  });
});

describe("assertFfmpegUsable", () => {
  const cfg = (over: Record<string, string> = {}) =>
    loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2", ...over });

  it("accepts the schema default 'ffmpeg' when it is resolvable on PATH", async () => {
    // Regression test: the original fs.access implementation broke working
    // systems because it resolved relative to cwd, not PATH. The default
    // "ffmpeg" (bare name) works with spawn/execFile because they use PATH,
    // and must not be rejected.
    const c = cfg({ TB3_CAMERA_FFMPEG_BIN: "ffmpeg" });
    // This works if ffmpeg is on PATH; it would fail in an environment where
    // ffmpeg is not installed, but that's acceptable (the test environment
    // should have ffmpeg available for testing).
    await expect(assertFfmpegUsable(c)).resolves.toBeUndefined();
  });

  it("rejects with a message naming the missing path and the config key", async () => {
    const c = cfg({ TB3_CAMERA_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg" });
    await expect(assertFfmpegUsable(c)).rejects.toThrow(/\/nope\/does\/not\/exist\/ffmpeg/);
    await expect(assertFfmpegUsable(c)).rejects.toThrow(/cameraFfmpegBin/);
  });

  it("rejects a directory path (directories pass fs.access but spawn fails EACCES)", async () => {
    // fs.access incorrectly accepts directories because they have the
    // execute/traversal bit. spawn fails with EACCES, which would rebuild
    // the silent-restart bug. This test ensures we catch that case.
    const c = cfg({ TB3_CAMERA_FFMPEG_BIN: "/tmp" });
    await expect(assertFfmpegUsable(c)).rejects.toThrow(/cameraFfmpegBin/);
  });

  it("rejects a non-executable file", async () => {
    // Even if a file exists, if it's not executable, spawn will fail.
    // This test is best-effort depending on test environment.
    // We'll create a non-executable file in /tmp for this.
    const nonExecFile = "/tmp/camera-check-test-nonexec.txt";
    try {
      const { writeFileSync, chmodSync } = await import("node:fs");
      writeFileSync(nonExecFile, "test");
      chmodSync(nonExecFile, 0o600); // Not executable
      const c = cfg({ TB3_CAMERA_FFMPEG_BIN: nonExecFile });
      await expect(assertFfmpegUsable(c)).rejects.toThrow(/cameraFfmpegBin/);
    } finally {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(nonExecFile);
      } catch { /* ignore cleanup failure */ }
    }
  });

  it("checks the v4l2 path too, not only mediamtx -- this is the field bug", async () => {
    // The live failure was cameraSource=v4l2 with a dead asdf ffmpeg path;
    // Task 6's encoder check skipped it because it only ran for mediamtx.
    await expect(assertFfmpegUsable(cfg({ TB3_CAMERA_FFMPEG_BIN: "/nope/ffmpeg" })))
      .rejects.toThrow();
  });
});
