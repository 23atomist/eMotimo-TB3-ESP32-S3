import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

// Daemon-side counterpart to dashboard/camera/encoder-check.ts's
// assertFfmpegUsable, for the OTHER ffmpeg binary this project spawns:
// captureFfmpegBin, used only by src/capture/snapshot.ts's takeSnapshot()
// to pull a confirmation frame from MediaMTX's RTSP output. Before this
// check existed, a bad captureFfmpegBin (schema default is the bare string
// "ffmpeg", which does not resolve on a systemd unit's minimal PATH) had no
// preflight at all and appeared nowhere in deploy/HOST-SETUP.md -- every
// snapshot just failed, surfaced only via the sticky CaptureController
// lastError (see controller.ts's item-5 fix for why that used to stick
// forever).
//
// Same rationale as assertFfmpegUsable for HOW it checks: execute the
// binary the way execFileAsync (takeSnapshot) will, rather than fs.access
// (which resolves relative to cwd instead of PATH, and wrongly accepts
// directories).
export async function assertCaptureFfmpegUsable(cfg: Config): Promise<void> {
  try {
    await execFileAsync(cfg.captureFfmpegBin, ["-version"], { timeout: 10_000 });
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code || "unknown";
    throw new Error(
      `captureFfmpegBin="${cfg.captureFfmpegBin}" cannot be executed (${errno}), ` +
      `but the daemon's snapshot grabber (src/capture/snapshot.ts) needs it to pull ` +
      `evidence photos from MediaMTX. Set captureFfmpegBin to an absolute path or a ` +
      `name resolvable on the daemon's PATH to a working ffmpeg -- see ` +
      `deploy/HOST-SETUP.md's "Daemon-side capture config" section.`,
    );
  }
}
