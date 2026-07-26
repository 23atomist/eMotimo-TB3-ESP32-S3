import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../../config.js";
import { encoderName } from "./rtsp.js";

const execFileAsync = promisify(execFile);

// `ffmpeg -encoders` prints a header, a legend, a "------" rule, then one
// encoder per line as: " V....D name  description".
export function parseEncoderList(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = /^\s[A-Z.]{6}\s+([a-z0-9_]+)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

export async function probeEncoders(ffmpegBin: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(ffmpegBin, ["-hide_banner", "-encoders"], {
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  return parseEncoderList(stdout);
}

// Fail fast and legibly. Without this, a missing encoder surfaces as ffmpeg
// dying, five restarts, and a "video unavailable" tile -- which reads as a
// camera fault rather than a config error.
export function assertEncoderAvailable(cfg: Config, available: Set<string>): void {
  if (cfg.cameraSource !== "mediamtx") return;
  const needed = encoderName(cfg);
  if (needed === null) return; // "copy" requires no encoder
  if (available.has(needed)) return;

  const have = [...available].filter((e) => e.includes("264")).sort();
  throw new Error(
    `cameraEncoder="${cfg.cameraEncoder}" needs ffmpeg encoder "${needed}", ` +
    `which ${cfg.cameraFfmpegBin} does not provide. ` +
    `Available H.264 encoders: ${have.length ? have.join(", ") : "(none)"}. ` +
    `Set cameraEncoder to one of those, or install an ffmpeg build that has "${needed}".`,
  );
}
