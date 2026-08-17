import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseRecordingName, parseSnapshotName, parseKeepName } from "./names.js";
import { RecordingFile } from "./join.js";
import { PassRecord } from "../capture/pass-journal.js";

export interface SnapshotFile {
  name: string;
  path: string;
  icao: string;
  callsign: string | null;
  atMs: number;
}

/**
 * Opaque handle for a file. Derived from the ABSOLUTE path, so two files
 * sharing a basename across the recordings and keep directories never
 * collide. The client only ever sends this back, never a path.
 */
function fileId(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 16);
}

function scanDir(dir: string, kept: boolean): RecordingFile[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    // Present but unreadable (permissions, an unmounted mountpoint, ...).
    // A thrown readdirSync would take down the whole listing route with it;
    // report an empty directory instead and leave a trace of why.
    console.error(`scanDir: cannot read directory ${dir}:`, e);
    return [];
  }
  const out: RecordingFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;

    // Kept files carry keepFileName's shape, not MediaMTX's. Their mtime is
    // when the LINK was made, not when the pass happened, so parse the
    // original instant out of the name -- otherwise every kept recording
    // drifts out of its pass's window and shows up unattributed.
    const parsed = parseRecordingName(name) ?? parseKeepName(name)?.atMs ?? null;
    let startedAtMs: number;
    if (parsed !== null) {
      startedAtMs = parsed;
    } else if (kept) {
      // Still on disk, still kept by an operator's explicit action -- fall
      // back to mtime rather than silently dropping it from the listing.
      // This is the one directory where invisible-but-present is the worst
      // failure mode, so an unparseable name must never mean "does not
      // exist" here the way it legitimately does for the MediaMTX directory.
      startedAtMs = st.mtimeMs;
    } else {
      continue; // MediaMTX's own directory: an unrecognized name is not a recording.
    }

    out.push({
      id: fileId(path),
      path,
      name,
      startedAtMs,
      endedAtMs: Math.max(st.mtimeMs, startedAtMs),
      sizeBytes: st.size,
      kept,
    });
  }
  return out;
}

export function scanRecordings(dirs: { recordings: string; keep: string }): RecordingFile[] {
  return [...scanDir(dirs.recordings, false), ...scanDir(dirs.keep, true)];
}

export function scanSnapshots(dir: string): SnapshotFile[] {
  if (!existsSync(dir)) return [];
  const out: SnapshotFile[] = [];
  for (const name of readdirSync(dir)) {
    const p = parseSnapshotName(name);
    if (!p) continue;
    out.push({ name, path: join(dir, name), icao: p.icao, callsign: p.callsign, atMs: p.atMs });
  }
  return out;
}

/**
 * Synthesise passes for recordings that predate the journal.
 *
 * CaptureController.beginPass() dispatches the snapshot immediately on lock,
 * so a snapshot landing inside a recording's window identifies that
 * recording. These records exist only for the lifetime of one listing request
 * and are NEVER written to the journal -- they carry identity and nothing
 * else, because nothing else was measured at the time.
 */
export function passesFromSnapshots(
  snaps: SnapshotFile[], files: RecordingFile[], graceMs: number,
): PassRecord[] {
  const byFile = new Map<string, SnapshotFile>();
  for (const s of [...snaps].sort((a, b) => a.atMs - b.atMs)) {
    const f = files.find((x) => s.atMs >= x.startedAtMs - graceMs && s.atMs <= x.endedAtMs);
    if (!f) continue;
    if (!byFile.has(f.id)) byFile.set(f.id, s);   // first snapshot wins
  }
  const out: PassRecord[] = [];
  for (const [fid, s] of byFile) {
    const f = files.find((x) => x.id === fid)!;
    out.push({
      id: `snap-${fid}`,
      icao: s.icao,
      callsign: s.callsign,
      startedAtMs: f.startedAtMs,
      endedAtMs: f.endedAtMs,
      snapshotFile: s.path,
      category: null, squawk: null, gsKt: null, maxAltitudeM: null,
      minRangeM: null, maxElevationDeg: null,
      azStartDeg: null, azEndDeg: null, azArcDeg: null,
      meanPointingErrorDeg: null, maxPointingErrorDeg: null,
      waitingMs: 0, limitHitMs: 0, samples: 0,
    });
  }
  return out;
}
