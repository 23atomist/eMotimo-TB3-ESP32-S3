import { spawn } from "node:child_process";
import type { Config } from "../../config.js";
import type { Spawner } from "./supervisor.js";
import { KILL_GRACE_MS } from "./mtplvcap.js";

// The ffmpeg encoder id for the configured encoder; null means stream copy.
export function encoderName(cfg: Config): string | null {
  switch (cfg.cameraEncoder) {
    case "vulkan": return "h264_vulkan";
    case "nvenc": return "h264_nvenc";
    case "x264": return "libx264";
    case "copy": return null;
  }
}

// Reads the UVC device's MJPEG, transcodes to H.264, publishes RTSP to MediaMTX.
//
// TWO independent ordering rules apply and BOTH fail silently if broken:
//   1. -init_hw_device / -filter_hw_device must precede the input, or the
//      Vulkan filter chain has no device and falls back or errors obscurely.
//   2. All v4l2 input options must precede -i, or ffmpeg ignores them and
//      negotiates some other mode -- yielding a live, plausible, WRONG stream.
export function ffmpegRtspArgs(cfg: Config): string[] {
  const enc = encoderName(cfg);
  const vulkan = cfg.cameraEncoder === "vulkan";

  const pre: string[] = ["-hide_banner", "-loglevel", "error"];
  if (vulkan) pre.push("-init_hw_device", "vulkan=vk:0", "-filter_hw_device", "vk");

  const input: string[] = [
    "-f", "v4l2",
    "-input_format", "mjpeg",
    "-video_size", cfg.cameraMediamtxSize,
    "-framerate", String(cfg.cameraV4l2Framerate),
    "-i", cfg.cameraV4l2Device,
  ];

  const out: string[] = [];
  if (enc === null) {
    out.push("-c:v", "copy");
  } else if (vulkan) {
    // Vulkan encodes from a GPU-side nv12 frame; -pix_fmt does not apply.
    out.push("-vf", "format=nv12,hwupload", "-c:v", enc, "-b:v", cfg.cameraVideoBitrate);
  } else if (enc === "h264_nvenc") {
    out.push("-c:v", enc, "-preset", "p4", "-tune", "ll", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p");
  } else {
    out.push("-c:v", enc, "-preset", "veryfast", "-tune", "zerolatency", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p");
  }

  return [...pre, ...input, ...out, "-f", "rtsp", "-rtsp_transport", "tcp", cfg.cameraMediamtxRtspUrl];
}

// NOT unit-tested (real subprocess), same convention as ffmpegV4l2Spawner.
// Unlike the MJPEG spawners this never calls onFrame: ffmpeg writes straight to
// MediaMTX over RTSP, so there is no frame stream to relay.
export function ffmpegRtspSpawner(cfg: Config): Spawner {
  return {
    start(_onFrame, onExit) {
      let stopped = false;
      let done = false;

      const proc = spawn(cfg.cameraFfmpegBin, ffmpegRtspArgs(cfg), {
        stdio: ["ignore", "ignore", "inherit"],
      });

      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        if (!stopped) onExit(code);
      };

      proc.on("exit", (code) => finish(code));
      proc.on("error", () => finish(1)); // ffmpeg missing or not executable

      return {
        kill(): void {
          stopped = true;
          try { proc.kill("SIGINT"); } catch { /* already dead */ }
          const hard = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* dead */ }
          }, KILL_GRACE_MS);
          proc.once("exit", () => clearTimeout(hard));
        },
      };
    },
  };
}
