import type { Express, Request, Response } from "express";
import { PassJournal } from "../capture/pass-journal.js";
import { scanRecordings, scanSnapshots, passesFromSnapshots } from "../recordings/scan.js";
import { joinRecordings, PassListing, RecordingFile } from "../recordings/join.js";
import { keepRecording, unkeepRecording, keepDirUsage, diskFreeBytes } from "../recordings/keep.js";

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
  files: Map<string, RecordingFile>;
  snapshots: Map<string, string>;   // id -> absolute path
}

/**
 * Scan, join, and index by id.
 *
 * Rebuilt per request rather than cached: the directories change underneath
 * us constantly (MediaMTX writing, the purge deleting), and a few hundred
 * readdir entries is far cheaper than reasoning about cache invalidation
 * against a process that does not tell us when it writes.
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

  const merged = [
    ...listings.filter((l) => l.pass !== null),
    ...backfilled,
  ].sort((a, b) => (b.pass?.startedAtMs ?? b.files[0]?.startedAtMs ?? 0) - (a.pass?.startedAtMs ?? a.files[0]?.startedAtMs ?? 0));

  return {
    listings: merged,
    files: new Map(files.map((f) => [f.id, f])),
    snapshots: new Map(snaps.map((s) => [s.name, s.path])),
  };
}

export function registerRecordingsRoutes(app: Express, deps: RecordingsDeps): void {
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
    const f = build(deps).files.get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    res.sendFile(f.path, (err: Error) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such recording" });
    });
  });

  app.get("/api/snapshots/:id", (req: Request, res: Response) => {
    const p = build(deps).snapshots.get(req.params.id);
    if (!p) { res.status(404).json({ error: "no such snapshot" }); return; }
    res.sendFile(p, (err: Error) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such snapshot" });
    });
  });

  app.post("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const b = build(deps);
    const f = b.files.get(req.params.id);
    if (!f) { res.status(404).json({ error: "no such recording" }); return; }
    const owner = b.listings.find((l) => l.files.some((x) => x.id === f.id))?.pass ?? null;
    try {
      const out = keepRecording(f, deps.keepDir, owner?.callsign ?? null, owner?.icao ?? "unknown");
      res.json({ kept: true, ...out });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete("/api/recordings/:id/keep", (req: Request, res: Response) => {
    const f = build(deps).files.get(req.params.id);
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
