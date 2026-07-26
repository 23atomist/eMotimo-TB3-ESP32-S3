import { describe, it, expect } from "vitest";
import { parseEncoderList, assertEncoderAvailable } from "../src/dashboard/camera/encoder-check.js";
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
