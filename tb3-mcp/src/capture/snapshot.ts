import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Config } from "../config.js";
import type { TuningStore } from "../tuning-store.js";
import { resolveTuning } from "../tuning-resolve.js";

const execFileAsync = promisify(execFile);

// Colons are illegal in filenames on some targets and awkward everywhere;
// both identity segments are sanitized because they ultimately derive from
// an external ADS-B feed.
function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "");
}

// `hex` is the dedup identity (always present -- falls back to "unknown" if
// somehow blank after sanitizing) and always leads the filename. `callsign`
// is the human-readable label and is entirely optional: omitted when null,
// blank, or -- after sanitizing both -- identical to the hex (the common
// case where no callsign was ever broadcast and the caller fell back to the
// hex itself, e.g. AdsbFollower's `ac.callsign ?? ac.hex`). Comparing the
// SANITIZED forms means a callsign that only *looks* like the hex (case or
// punctuation aside) is still recognized and dropped rather than emitting a
// redundant `A1B2C3-A1B2C3-...` filename.
export function snapshotPath(dir: string, hex: string, callsign: string | null, iso: string): string {
  const safeHex = sanitizeSegment(hex) || "unknown";
  const safeIso = iso.replace(/:/g, "-");
  const safeCallsign = callsign ? sanitizeSegment(callsign) : "";
  const useCallsign = safeCallsign !== "" && safeCallsign.toLowerCase() !== safeHex.toLowerCase();
  const base = useCallsign ? `${safeHex}-${safeCallsign}-${safeIso}` : `${safeHex}-${safeIso}`;
  return path.join(dir, `${base}.jpg`);
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

// Split out (rather than inlined into takeSnapshot's execFileAsync call) so
// the tuned-vs-config timeout resolution is independently testable without a
// real subprocess -- takeSnapshot itself stays NOT unit-tested end-to-end.
// Resolved fresh on every call (tuningStore is read live, not captured), so
// a mid-session set_tuning of captureTimeoutMs applies to the very next
// snapshot with no daemon restart.
export function snapshotExecOptions(
  tuningStore: TuningStore | undefined, cfg: Config,
): { timeout: number; killSignal: "SIGKILL" } {
  return { timeout: resolveTuning(tuningStore, cfg).captureTimeoutMs, killSignal: "SIGKILL" };
}

// Not tested against a real subprocess (test/capture-snapshot.test.ts mocks
// node:child_process instead). Bounded by captureTimeoutMs (see
// snapshotExecOptions) so a wedged ffmpeg can never delay the tracking tick
// that triggered it.
export async function takeSnapshot(
  cfg: Config, hex: string, callsign: string | null, nowIso: string, tuningStore?: TuningStore,
): Promise<string> {
  const out = snapshotPath(cfg.captureSnapshotDir, hex, callsign, nowIso);
  await execFileAsync(cfg.captureFfmpegBin, snapshotArgs(cfg, out), snapshotExecOptions(tuningStore, cfg));
  return out;
}
