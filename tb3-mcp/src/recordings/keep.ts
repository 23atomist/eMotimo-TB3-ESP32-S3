import {
  linkSync, copyFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync, statfsSync,
} from "node:fs";
import { join } from "node:path";
import { keepFileName } from "./names.js";
import { RecordingFile } from "./join.js";

/**
 * Rescue a recording from MediaMTX's retention purge.
 *
 * A HARDLINK, not a copy: every media directory is on one filesystem, so this
 * is instantaneous and costs zero additional bytes -- the file simply gains a
 * second name pointing at the same data. When MediaMTX unlinks the original
 * at recordDeleteAfter, the data survives because this link still references
 * it. Copying a 388MB file would instead take real time and double its
 * footprint for the week the original still lives.
 *
 * Falls back to a copy on EXDEV so this keeps working if the keep directory
 * is later moved to another volume.
 */
export function keepRecording(
  file: RecordingFile, keepDir: string, callsign: string | null, icao: string,
): { path: string; method: "link" | "copy" } {
  mkdirSync(keepDir, { recursive: true });
  const dest = join(keepDir, keepFileName(file.startedAtMs, callsign, icao));
  if (existsSync(dest)) return { path: dest, method: "link" };   // idempotent
  try {
    linkSync(file.path, dest);
    return { path: dest, method: "link" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw e;
    copyFileSync(file.path, dest);
    return { path: dest, method: "copy" };
  }
}

/** Drop a keep link. The original (if it still exists) is untouched. */
export function unkeepRecording(file: RecordingFile): void {
  if (!file.kept) throw new Error("refusing to delete: not a kept recording");
  if (existsSync(file.path)) unlinkSync(file.path);
}

export function keepDirUsage(keepDir: string): { files: number; bytes: number } {
  if (!existsSync(keepDir)) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const name of readdirSync(keepDir)) {
    try {
      const st = statSync(join(keepDir, name));
      if (!st.isFile()) continue;
      files++; bytes += st.size;
    } catch { /* vanished mid-scan */ }
  }
  return { files, bytes };
}

/**
 * Free bytes on the volume holding `path`, or null if it cannot be read.
 *
 * The keep directory is the ONE unbounded thing here -- recordings stay
 * capped by MediaMTX's own purge -- so this has to be visible in the UI
 * rather than discovered when the disk that also runs rig control fills up.
 */
export function diskFreeBytes(path: string): number | null {
  try {
    const st = statfsSync(path);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}
