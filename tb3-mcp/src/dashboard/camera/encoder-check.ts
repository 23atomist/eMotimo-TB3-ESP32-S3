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

// Fail at startup, loudly, when the configured ffmpeg does not exist or is not
// executable — by actually trying to run it the way spawn() will.
//
// Without this, a dead path is invisible: spawn() fails with ENOENT, the
// restart budget burns 5 attempts in 60s, the pipeline degrades to a
// placeholder frame, and the dashboard shows "STARTING..." forever because
// `enabled` is true while `streaming` never becomes true. That exact failure
// cost real debugging time on 2026-07-26, when an ffmpeg toolchain change
// removed the binary the config still pointed at.
//
// We execute the binary (not fs.access) because execution semantics match spawn:
// it resolves PATH, rejects directories (spawn fails EACCES), and catches
// non-executable files. fs.access resolves relative to cwd, unlike spawn, and
// accepts directories — both would reproduce the silent-restart bug later.
export async function assertFfmpegUsable(cfg: Config): Promise<void> {
  // Every camera source spawns ffmpeg (v4l2 reads the device, mediamtx
  // encodes to MediaMTX), so there is no source to exempt anymore.
  try {
    await execFileAsync(cfg.cameraFfmpegBin, ["-version"], { timeout: 10_000 });
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code || "unknown";
    throw new Error(
      `cameraFfmpegBin="${cfg.cameraFfmpegBin}" cannot be executed (${errno}), ` +
      `but cameraSource="${cfg.cameraSource}" needs ffmpeg. ` +
      `Set cameraFfmpegBin to an absolute path or a name resolvable on PATH to a working ffmpeg. ` +
      `Note a toolchain change (e.g. installing a different ffmpeg package) ` +
      `can remove the old binary while leaving this config pointing at it.`,
    );
  }
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
