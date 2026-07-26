import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

// Colons are illegal in filenames on some targets and awkward everywhere;
// the icao is sanitized because it ultimately derives from an external feed.
export function snapshotPath(dir: string, icao: string, iso: string): string {
  const safeIcao = icao.replace(/[^A-Za-z0-9_-]/g, "") || "unknown";
  return path.join(dir, `${safeIcao}-${iso.replace(/:/g, "-")}.jpg`);
}

// Grab a single frame from MediaMTX's RTSP output -- NOT from the V4L2 device.
// A second device consumer would contend with the publisher for the camera.
export function snapshotArgs(cfg: Config, outPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",     // must precede -i
    "-i", cfg.cameraMediamtxRtspUrl,
    "-frames:v", "1",
    "-q:v", "2",
    "-y",
    outPath,
  ];
}

// NOT unit-tested end-to-end (real subprocess). Bounded by captureTimeoutMs so
// a wedged ffmpeg can never delay the tracking tick that triggered it.
export async function takeSnapshot(cfg: Config, icao: string, nowIso: string): Promise<string> {
  const out = snapshotPath(cfg.captureSnapshotDir, icao, nowIso);
  await execFileAsync(cfg.captureFfmpegBin, snapshotArgs(cfg, out), {
    timeout: cfg.captureTimeoutMs,
    killSignal: "SIGKILL",
  });
  return out;
}
