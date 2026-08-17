import type { Express, Request, Response } from "express";
import { resolve } from "node:path";
import { PassJournal } from "../capture/pass-journal.js";
import { scanRecordings, scanSnapshots, passesFromSnapshots } from "../recordings/scan.js";
import { joinRecordings, PassListing, RecordingFile } from "../recordings/join.js";
import {
  keepRecording, unkeepRecording, keepDirUsage, diskFreeBytes, isInsideDir,
} from "../recordings/keep.js";

export interface RecordingsDeps {
  recordingsDir: string;
  keepDir: string;
  snapshotsDir: string;
  journalFile: string;
  graceMs: number;
  retentionMs: number;
  now(): number;
}

interface Built {
  listings: PassListing[];
}

/**
 * Scan, join, and index into the full pass listing -- for `/api/passes`
 * ONLY (plus the POST keep route's owner lookup; see below).
 *
 * Rebuilt per request rather than cached: the directories change underneath
 * us constantly (MediaMTX writing, the purge deleting), and a few hundred
 * readdir entries is far cheaper than reasoning about cache invalidation
 * against a process that does not tell us when it writes.
 *
 * Deliberately NOT used by the per-id routes below (`/video`,
 * `/snapshots/:id`, the keep routes' id lookup): this does three readdir
 * passes, a statSync per entry, and a readFileSync + zod parse per journal
 * line -- all of it discarded except one map entry. A browser scrubbing a
 * 388MB file issues many 206 range requests, each one paying that cost
 * synchronously on the same event loop that drives rig control and the SSE
 * broadcast, and the journal only grows. Those routes use
 * buildFileIndex()/buildSnapshotIndex() instead, which scan only what they
 * need.
 */
function build(deps: RecordingsDeps): Built {
  const files = scanRecordings({ recordings: deps.recordingsDir, keep: deps.keepDir });
  const journalPasses = new PassJournal(deps.journalFile).list();
  const opts = { graceMs: deps.graceMs, retentionMs: deps.retentionMs, nowMs: deps.now() };

  const listings = joinRecordings(journalPasses, files, opts);

  // Backfill: any file no journal pass claimed may still be identifiable from
  // the snapshot taken at lock.
  const claimed = new Set(listings.flatMap((l) => (l.pass ? l.files.map((f) => f.id) : [])));
  const orphans = files.filter((f) => !claimed.has(f.id));
  const snaps = scanSnapshots(deps.snapshotsDir);
  const synthesised = passesFromSnapshots(snaps, orphans, deps.graceMs);
  const backfilled = joinRecordings(synthesised, orphans, { ...opts, source: "snapshot" });

  // Still necessary, not a leftover: joinRecordings now sorts each of its
  // own results newest-first internally, but `listings` and `backfilled` are
  // TWO separately-sorted sequences here -- merging them into one globally
  // ordered list still needs this outer sort.
  const merged = [
    ...listings.filter((l) => l.pass !== null),
    ...backfilled,
  ].sort((a, b) => (b.pass?.startedAtMs ?? b.files[0]?.startedAtMs ?? 0) - (a.pass?.startedAtMs ?? a.files[0]?.startedAtMs ?? 0));

  return { listings: merged };
}

/**
 * id -> RecordingFile, scanning ONLY the recordings/keep directories (no
 * journal read, no join/backfill). The narrow lookup for every per-id route.
 */
function buildFileIndex(deps: RecordingsDeps): Map<string, RecordingFile> {
  const files = scanRecordings({ recordings: deps.recordingsDir, keep: deps.keepDir });
  return new Map(files.map((f) => [f.id, f]));
}

/**
 * Snapshot filename -> absolute path, scanning only the snapshots directory.
 * Keyed on the filename itself (a snapshot carries no server-issued id,
 * unlike RecordingFile) -- still safe because this is a membership test
 * against files scanSnapshots actually found on disk, never a concatenation
 * of the request param into a path.
 */
function buildSnapshotIndex(deps: RecordingsDeps): Map<string, string> {
  const snaps = scanSnapshots(deps.snapshotsDir);
  return new Map(snaps.map((s) => [s.name, s.path]));
}

/**
 * Guard against `captureKeepDir` and `captureRecordingsDir` being configured
 * to the same (or a nested) directory.
 *
 * If an operator set them equal, MediaMTX's own recordings would scan as
 * `kept: true` (scanRecordings tags every entry under `keep` that way) and
 * become DELETE-able -- and unkeepRecording's own containment check would
 * PASS, because the path genuinely does resolve inside the configured keep
 * dir. This is a delete path, so it fails loudly at startup instead of at
 * the first DELETE.
 */
function assertDirsDisjoint(recordingsDir: string, keepDir: string): void {
  const rec = resolve(recordingsDir);
  const keep = resolve(keepDir);
  if (rec === keep || isInsideDir(keep, rec) || isInsideDir(rec, keep)) {
    throw new Error(
      `captureRecordingsDir (${recordingsDir}) and captureKeepDir (${keepDir}) must be ` +
        `distinct, non-nested directories -- MediaMTX's own recordings would otherwise scan ` +
        `as kept and become deletable`,
    );
  }
}

export function registerRecordingsRoutes(app: Express, deps: RecordingsDeps): void {
  assertDirsDisjoint(deps.recordingsDir, deps.keepDir);

  app.get("/api/passes", (_req: Request, res: Response) => {
    try {
      const b = build(deps);
      res.json({
        listings: b.listings,
        keepUsage: keepDirUsage(deps.keepDir),
        diskFreeBytes: diskFreeBytes(deps.recordingsDir),
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // res.sendFile implements HTTP range requests (206 / Content-Range /
  // If-Range / ETag). Mandatory, not an optimisation: without it every scrub
  // of a 388MB file re-downloads from byte zero.
  app.get("/api/recordings/:id/video", (req: Request, res: Response) => {
    const f = buildFileIndex(deps).get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    res.sendFile(f.path, (err: Error | null) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such recording" });
    });
  });

  app.get("/api/snapshots/:id", (req: Request, res: Response) => {
    const p = buildSnapshotIndex(deps).get(req.params.id);
    if (!p) { res.status(404).json({ error: "no such snapshot" }); return; }
    res.sendFile(p, (err: Error | null) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such snapshot" });
    });
  });

  app.post("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const f = buildFileIndex(deps).get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    // Owner lookup (for callsign/icao in the kept filename) needs the full
    // pass listing, not just the file index -- this is a one-shot,
    // operator-initiated write (one click), not a per-scrub read, so it is
    // not the cost Finding 1 was about.
    const owner = build(deps).listings.find((l) => l.files.some((x) => x.id === f.id))?.pass ?? null;
    try {
      const out = keepRecording(f, deps.keepDir, owner?.callsign ?? null, owner?.icao ?? "unknown");
      res.json({ kept: true, ...out });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const f = buildFileIndex(deps).get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    try {
      // unkeepRecording deletes video files; it independently verifies
      // file.path resolves inside keepDir before unlinking, so it must be
      // given the REAL keep directory rather than trusting file.kept alone.
      unkeepRecording(f, deps.keepDir);
      res.json({ kept: false });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
