import { describe, it, expect } from "vitest";
import { ffmpegRtspArgs, encoderName } from "../src/dashboard/camera/rtsp.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/config.js";

function cfg(over: Record<string, string> = {}): Config {
  return loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", ...over });
}
const idx = (a: string[], f: string): number => a.indexOf(f);

describe("ffmpegRtspArgs — ordering invariants", () => {
  it("puts every v4l2 input option BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg());
    const i = idx(a, "-i");
    expect(i).toBeGreaterThan(-1);
    for (const flag of ["-f", "-input_format", "-video_size", "-framerate"]) {
      expect(idx(a, flag)).toBeLessThan(i);
    }
  });

  it("puts vulkan hw-device init BEFORE -i", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(idx(a, "-init_hw_device")).toBeLessThan(idx(a, "-i"));
    expect(idx(a, "-filter_hw_device")).toBeLessThan(idx(a, "-i"));
  });

  it("puts the RTSP target last", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/tb3");
    expect(a[a.length - 3]).toBe("-rtsp_transport");   // -f rtsp -rtsp_transport tcp <url>
  });
});

describe("ffmpegRtspArgs — encoder selection", () => {
  it("vulkan uses hwupload and never -pix_fmt yuv420p", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "vulkan" }));
    expect(a).toContain("h264_vulkan");
    expect(a).toContain("format=nv12,hwupload");
    expect(a).not.toContain("yuv420p");
  });

  it("nvenc uses -pix_fmt yuv420p and no vulkan device", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "nvenc" }));
    expect(a).toContain("h264_nvenc");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
    expect(a).not.toContain("format=nv12,hwupload");
  });

  it("x264 uses libx264 with a low-latency preset", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "x264" }));
    expect(a).toContain("libx264");
    expect(a).toContain("veryfast");
    expect(a).toContain("yuv420p");
    expect(a).not.toContain("-init_hw_device");
  });

  it("copy passes through and sets no bitrate", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_ENCODER: "copy" }));
    expect(a).toContain("copy");
    expect(a).not.toContain("-b:v");
  });

  it("encoderName maps config to the ffmpeg encoder id", () => {
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "vulkan" }))).toBe("h264_vulkan");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "nvenc" }))).toBe("h264_nvenc");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "x264" }))).toBe("libx264");
    expect(encoderName(cfg({ TB3_CAMERA_ENCODER: "copy" }))).toBeNull();
  });
});

describe("ffmpegRtspArgs — plumbing", () => {
  it("uses cameraMediamtxSize, NOT cameraV4l2Size", () => {
    const a = ffmpegRtspArgs(cfg({ TB3_CAMERA_MEDIAMTX_SIZE: "3840x2160", TB3_CAMERA_V4L2_SIZE: "640x480" }));
    expect(a[idx(a, "-video_size") + 1]).toBe("3840x2160");
  });

  it("plumbs device, framerate, bitrate and target", () => {
    const a = ffmpegRtspArgs(cfg({
      TB3_CAMERA_V4L2_DEVICE: "/dev/v4l/by-id/usb-4K_USB_Camera-video-index0",
      TB3_CAMERA_V4L2_FRAMERATE: "25",
      TB3_CAMERA_VIDEO_BITRATE: "12M",
      TB3_CAMERA_MEDIAMTX_RTSP_URL: "rtsp://127.0.0.1:8554/cam2",
    }));
    expect(a[idx(a, "-i") + 1]).toBe("/dev/v4l/by-id/usb-4K_USB_Camera-video-index0");
    expect(a[idx(a, "-framerate") + 1]).toBe("25");
    expect(a[idx(a, "-b:v") + 1]).toBe("12M");
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/cam2");
  });

  it("requests MJPEG input (the camera has no native H.264)", () => {
    const a = ffmpegRtspArgs(cfg());
    expect(a[idx(a, "-input_format") + 1]).toBe("mjpeg");
  });
});
