import { PassRecord } from "../capture/pass-journal.js";

export interface RecordingFile {
  /** Opaque server-issued handle. NEVER a client-supplied path. */
  id: string;
  path: string;
  name: string;
  startedAtMs: number;   // parsed from the filename (host-local)
  endedAtMs: number;     // file mtime
  sizeBytes: number;
  kept: boolean;
}

export type PassSource = "journal" | "snapshot";
export type VideoState = "present" | "expired" | "not-recorded";

export interface PassListing {
  pass: PassRecord | null;    // null for a file that matched no pass
  source: PassSource | null;
  files: RecordingFile[];
  videoState: VideoState;
}

export interface JoinOptions {
  graceMs: number;
  retentionMs: number;
  nowMs: number;
  /** Where these passes came from; null entries are always "journal". */
  source?: PassSource;
}

/**
 * Map passes to the recording files that belong to them.
 *
 * The association is a VIEW, not a rename: MediaMTX keeps owning its
 * directory and its retention policy, and the journal outlives the footage,
 * so a purged pass still appears in the listing as one the operator missed.
 *
 * A file belongs to the pass whose [startedAtMs, endedAtMs + graceMs] window
 * contains the file's start. When windows overlap (a retarget inside the
 * grace period) the LATEST qualifying pass wins -- the file was opened after
 * that pass began, so it is that pass's footage.
 */
export function joinRecordings(
  passes: PassRecord[], files: RecordingFile[], opts: JoinOptions,
): PassListing[] {
  const source: PassSource = opts.source ?? "journal";
  const byPass = new Map<string, RecordingFile[]>();
  const unattributed: RecordingFile[] = [];

  // Latest-first so the first match is the latest qualifying pass.
  const ordered = [...passes].sort((a, b) => b.startedAtMs - a.startedAtMs);

  for (const f of files) {
    const owner = ordered.find(
      (p) => f.startedAtMs >= p.startedAtMs && f.startedAtMs <= p.endedAtMs + opts.graceMs,
    );
    if (!owner) { unattributed.push(f); continue; }
    const list = byPass.get(owner.id);
    if (list) list.push(f); else byPass.set(owner.id, [f]);
  }

  const listings: PassListing[] = passes.map((p) => {
    const owned = (byPass.get(p.id) ?? []).sort((a, b) => a.startedAtMs - b.startedAtMs);
    let videoState: VideoState = "present";
    if (owned.length === 0) {
      // Distinguishing "purged" from "never recorded" needs MediaMTX's
      // retention window, which lives in mediamtx.yml and is mirrored into
      // config. Drift only ever mislabels a row, never resolves a wrong file.
      videoState = opts.nowMs - p.startedAtMs > opts.retentionMs ? "expired" : "not-recorded";
    }
    return { pass: p, source, files: owned, videoState };
  });

  for (const f of unattributed) {
    listings.push({ pass: null, source: null, files: [f], videoState: "present" });
  }

  // Single global newest-first sort across passes AND unattributed files
  // alike. This is a review-and-rescue surface -- the operator scans it by
  // time -- so an unattributed file recorded today must not rank below a
  // pass from six days ago just because it lacks a matching pass record.
  listings.sort((a, b) => startOf(b) - startOf(a));

  return listings;
}

function startOf(l: PassListing): number {
  return l.pass ? l.pass.startedAtMs : (l.files[0]?.startedAtMs ?? 0);
}
