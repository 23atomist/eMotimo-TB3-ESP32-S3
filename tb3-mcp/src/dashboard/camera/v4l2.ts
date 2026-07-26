import { spawn } from "node:child_process";
import type { Config } from "../../config.js";
import type { Spawner } from "./supervisor.js";
import { JpegFrameParser } from "./jpeg-parser.js";
import { KILL_GRACE_MS } from "./mtplvcap.js";

// ---------------------------------------------------------------------------
// ffmpegV4l2Spawner: the spawner itself is NOT unit-tested (real subprocess +
// stdout relay; verified on-host), same as mtplvcapSpawner above. Its argv
// builder is split out and unit-tested because flag ORDER matters: ffmpeg
// ignores input options placed after -i, which would silently give us the
// wrong pixel format or resolution rather than an error.
//
// ffmpeg reads the V4L2/UVC device and writes the camera's NATIVE MJPEG frames
// to stdout as bare concatenated JPEGs -- "-c:v copy" means no re-encode, so
// CPU and latency stay low. JpegFrameParser splits that byte stream into
// frames. Simpler than mtplvcapSpawner: no HTTP relay, no port, no connect
// retry, no vendor id -- ffmpeg writes straight into our pipe.
// ---------------------------------------------------------------------------

export function ffmpegV4l2Args(cfg: Config): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    // Input options -- all of these MUST precede -i to take effect.
    "-f", "v4l2",
    "-input_format", "mjpeg",
    "-video_size", cfg.cameraV4l2Size,
    "-framerate", String(cfg.cameraV4l2Framerate),
    "-i", cfg.cameraV4l2Device,
    // Output: pass the camera's JPEG frames through untouched.
    "-c:v", "copy",
    "-f", "mjpeg",
    "pipe:1",
  ];
}

export function ffmpegV4l2Spawner(cfg: Config): Spawner {
  return {
    start(onFrame, onExit) {
      let stopped = false;
      let done = false;
      const parser = new JpegFrameParser();

      // stderr is inherited so ffmpeg's diagnostics (device busy, unsupported
      // mode, missing device) land in the dashboard's journal; -loglevel error
      // keeps that quiet in the normal case.
      const proc = spawn(cfg.cameraFfmpegBin, ffmpegV4l2Args(cfg), {
        stdio: ["ignore", "pipe", "inherit"],
      });

      // Report death exactly once, and never after kill() -- CameraStreamer
      // treats a kill as an expected teardown, not a pipeline failure.
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        if (!stopped) onExit(code);
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (stopped || done) return;
        for (const frame of parser.push(chunk)) onFrame(frame);
      });
      // A broken pipe surfaces as the process 'exit' below; swallow it here so
      // it can't become an unhandled 'error' event.
      proc.stdout?.on("error", () => { /* handled via exit */ });
      proc.on("exit", (code) => finish(code));
      // Spawn failure: ffmpeg missing or not executable. Report nonzero so the
      // streamer's restart budget applies and it degrades to the placeholder.
      proc.on("error", () => finish(1));

      return {
        kill(): void {
          stopped = true;
          // SIGINT lets ffmpeg close the V4L2 device cleanly; SIGKILL backstop
          // so a wedged ffmpeg can't hold the device against the next start.
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
