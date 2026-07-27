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
//
// GOP / keyframe options (below) exist because of a THIRD, subtler failure
// mode found during live bring-up: with no -g set, NVENC's default GOP is
// long (~250 frames, ~8s @30fps) and carries no in-band SPS/PPS repetition.
// A WebRTC viewer that (re)connects mid-stream -- every page reload, every
// reconnect after a network blip, every additional viewer -- receives RTP
// continuously and the browser acks it over RTCP, but the decoder never
// initializes (readyState stays 0, videoWidth stays 0) because it never
// gets the SPS/PPS it needs and ffmpeg-over-RTSP cannot honour the
// browser's RTCP PLI keyframe requests. A short, framerate-scaled GOP plus
// forcing the SPS/PPS to be re-emitted in-band before every keyframe makes
// the stream joinable at any moment. Do not remove these as "redundant."
const KEYFRAME_INTERVAL_SECONDS = 2;

// GOP size in frames for a ~KEYFRAME_INTERVAL_SECONDS keyframe cadence at
// the configured capture framerate. Framerate is configurable, so this is
// derived rather than a hardcoded frame count.
function gopSize(cfg: Config): number {
  return Math.max(1, Math.round(cfg.cameraV4l2Framerate * KEYFRAME_INTERVAL_SECONDS));
}

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

  // -g: generic AVCodecContext GOP-size option, honoured by all three
  //     encoders here (maps to NVENC's gopLength/idrPeriod, the Vulkan
  //     encoder's base.gop_size, and libx264's i_keyint_max).
  // -bsf:v dump_extra=freq=keyframe: re-injects the stream's extradata
  //     (SPS/PPS) immediately before every keyframe packet, so a receiver
  //     joining mid-stream gets parameter sets in-band without depending on
  //     out-of-band SDP signalling. Codec-agnostic; runs on the muxed
  //     packet stream after encoding.
  const keyframeArgs: string[] = ["-g", String(gopSize(cfg)), "-bsf:v", "dump_extra=freq=keyframe"];

  const out: string[] = [];
  if (enc === null) {
    // Stream copy: ffmpeg is not encoding, so it cannot impose a GOP on
    // frames it never touches -- no -g here. There is also no reliable,
    // codec-agnostic parameter-set fix to apply blind to an unknown
    // pass-through bitstream, so this branch intentionally gains nothing.
    out.push("-c:v", "copy");
  } else if (vulkan) {
    // Vulkan encodes from a GPU-side nv12 frame; -pix_fmt does not apply.
    out.push("-vf", "format=nv12,hwupload", "-c:v", enc, "-b:v", cfg.cameraVideoBitrate, ...keyframeArgs);
  } else if (enc === "h264_nvenc") {
    // -forced-idr: NVENC-specific; without it, a forced keyframe becomes a
    // plain (non-IDR) I-frame with no fresh SPS/PPS -- defeats the point.
    out.push(
      "-c:v", enc, "-preset", "p4", "-tune", "ll", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p",
      ...keyframeArgs, "-forced-idr", "1",
    );
  } else {
    out.push(
      "-c:v", enc, "-preset", "veryfast", "-tune", "zerolatency", "-b:v", cfg.cameraVideoBitrate, "-pix_fmt", "yuv420p",
      ...keyframeArgs,
    );
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
