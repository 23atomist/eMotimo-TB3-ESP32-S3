# Recordings Index and Playback Section

Date: 2026-08-17
Status: approved for implementation

## Problem

Recorded video carries no metadata. MediaMTX writes the files and names them
purely by timestamp:

    /var/lib/tb3/recordings/tb3/2026-08-16_19-16-12-734710.mp4

The daemon knows exactly which aircraft each pass was — `CaptureController`
brackets every pass and holds `passIcao`/`passCallsign` — but that context is
never recorded anywhere, so a directory of mp4 files is unidentifiable. There is
also no way to browse, filter or play them back short of SSH.

Snapshots do carry identity, encoded in the filename:

    /var/lib/tb3/snapshots/a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg

### Verified current state (2026-08-16, rig host 192.168.4.71)

- 68 recordings, **4.1 GB, spanning two days**. Largest single file 388 MB.
- 272 snapshots.
- `/etc/mediamtx/mediamtx.yml`:
  - `recordPath: /var/lib/tb3/recordings/%path/%Y-%m-%d_%H-%M-%S-%f`
  - `recordFormat: fmp4`
  - `recordSegmentDuration: 1h`
  - **`recordDeleteAfter: 168h`** — everything is purged after 7 days.
- Recording filenames are host-**local** time (MST), confirmed against mtimes.
- `/var/lib/tb3`, `/var/lib/tb3/recordings` and `/var/lib/tb3/snapshots` are all
  on the same filesystem (device 66306). 412 GB volume, 87 GB free, 78% used.
- The dashboard process runs as **root**, so it can read the media directories
  and create links in them.
- The dashboard is a single fixed three-column layout with no tab or section
  switching. `dashboardAuth` defaults to `false`.

## Decisions

Confirmed with the operator before design:

- Purpose is **review and rescue keepers**, not a permanent archive. Index
  entries may outlive their video; a keep action must exist.
- Metadata to capture and filter on: **framing geometry, tracking quality,
  aircraft details, and a thumbnail** — all four.
- **Keep copies to a host-side keep directory** rather than downloading.
- Existing recordings are **backfilled** from snapshot filenames.

### Architecture approach

Chosen: **a daemon-written pass journal joined to files by time window.**

The join stays a *view* rather than a rename. MediaMTX keeps owning its
directory, so `recordDeleteAfter` keeps bounding disk use, and the journal
outlives the footage — a purged pass still appears in the listing, which is what
makes this a review surface rather than just a file browser.

Rejected: **renaming or moving files at pass end.** It removes files from
`recordDeleteAfter`'s reach, so recordings accumulate unbounded at ~2 GB/day on
the machine that also runs real-time rig control. It is also racy — MediaMTX
finalises fmp4 asynchronously after `record: false`, so "the newest mp4" names a
file that may still be open.

Rejected: **one MediaMTX path per aircraft.** The ffmpeg publisher is bound to
the `tb3` path, so this re-plumbs the whole video pipeline for a naming
convenience and adds per-pass path lifecycle management.

## Design

### 1. Pass journal

New module `src/capture/pass-journal.ts` and a `PassRecorder` subscribing to the
**existing `session.onStateChange` seam** that `CaptureController` already uses.
`CaptureController` is deliberately left untouched: it owns the record valve
under a strict never-await rule (it is called from the real-time tracking tick),
and metadata collection must not be able to destabilise it.

While a pass is open the recorder polls `TrackingSession.status()` at 2 Hz and
folds the aggregates.

```ts
export interface PassRecord {
  id: string;
  icao: string;
  callsign: string | null;
  startedAtMs: number;
  endedAtMs: number;
  snapshotFile: string | null;

  // aircraft details, sampled once at pass start
  category: string | null;
  squawk: string | null;
  gsKt: number | null;
  maxAltitudeM: number | null;

  // framing geometry
  minRangeM: number | null;
  maxElevationDeg: number | null;
  azStartDeg: number | null;
  azEndDeg: number | null;
  azArcDeg: number | null;

  // tracking quality
  meanPointingErrorDeg: number | null;
  maxPointingErrorDeg: number | null;
  waitingMs: number;
  limitHitMs: number;

  samples: number;
}
```

Persisted append-only as JSONL at `/var/lib/tb3/passes.jsonl` (path
configurable via `passJournalFile`). A few hundred bytes per pass, so a year of
flying is a couple of MB.

One record is written at pass **end**, never updated in place — that is what
keeps the file append-only. The in-progress pass is served live from
`CaptureStatus` instead of being written and mutated. A daemon crash mid-pass
loses that single record, which is the correct trade against maintaining mutable
on-disk state.

`meanPointingErrorDeg` is the single most useful filter for finding keepers: it
separates "the rig held it centred" from "it swept off and the footage is
unusable" (see the 2026-08-16 calibration failure).

### 2. Join

A pure function, shared by both processes:

```ts
export interface RecordingFile {
  path: string;          // absolute, server-resolved
  name: string;
  startedAtMs: number;   // parsed from the MediaMTX filename (host-local)
  endedAtMs: number;     // file mtime
  sizeBytes: number;
  kept: boolean;
}

export type PassSource = "journal" | "snapshot";

export interface PassListing {
  pass: PassRecord | null;      // null for an unattributed file
  source: PassSource | null;
  files: RecordingFile[];       // empty when the video is gone
  videoState: "present" | "expired" | "not-recorded";
}

export function joinRecordings(
  passes: PassRecord[], files: RecordingFile[], graceMs: number,
): PassListing[];
```

A file belongs to the pass whose `[startedAtMs, endedAtMs + graceMs]` window
contains the file's start. `graceMs` defaults to the capture debounce
(`captureDebounceMs`, 5000) plus 2000 ms of margin.

Three outcomes, all of which must stay visible rather than being silently
dropped:

- **Pass with file** — the normal case, `videoState: "present"`.
- **Pass with no file** — purged at 7 days, or the camera was disarmed.
  Distinguishing the two needs MediaMTX's retention window, which lives in
  `mediamtx.yml` and is not visible to this code, so it is mirrored as a config
  value `recordingRetentionHours` (default 168, matching the deployed
  `recordDeleteAfter: 168h`). A pass older than that with no file is
  `"expired"`; a newer one is `"not-recorded"` (camera disarmed, or recording
  failed). If the two ever drift apart the only cost is a mislabelled row, not a
  wrong file. This case is why the journal is worth keeping: it shows what was
  missed.
- **File with no pass** — a manual recording, or one predating the journal.
  `pass: null`.

Segment rollover (a pass crossing `recordSegmentDuration`) attaches multiple
files to one pass; `files` is an array for exactly this reason.

### 3. Backfill

The same join, with passes synthesised from snapshot filenames. `beginPass()`
dispatches the snapshot immediately on lock, so a snapshot whose timestamp falls
inside a file's window identifies that file.

```
a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg
  → icao "a082ac", callsign "AAL556", UTC instant
```

Note the asymmetry, which the parser must handle explicitly: **snapshot names are
UTC, recording names are host-local.**

Synthesised entries carry `source: "snapshot"` so the UI can show them as
inferred and thin — no geometry, no tracking quality, since none of that was
recorded at the time. A synthesised record is never written to the journal; it
exists only for the duration of a listing request.

### 4. Keep

Keep is a **hardlink**, not a copy. All the media directories are on one
filesystem, so `link()` into `/var/lib/tb3/keep/` is instantaneous and costs
**zero additional bytes** — the file gains a second name pointing at the same
data. When MediaMTX unlinks the original at 7 days, the data survives because
the keep link still references it.

A copy would take real time on a 388 MB file and double its footprint for the
week the original still lives. The hardlink never doubles anything.

Two guards:

- Verify same-device before linking, and fall back to a copy on `EXDEV`, so this
  still works if the keep directory is later moved to another volume.
- Kept files get a self-describing name — `2026-08-16T19-16-12_AAL556_a082ac.mp4`
  — sortable and identifiable outside the dashboard entirely.

Recordings stay bounded at roughly 14 GB by MediaMTX's own purge, so **the keep
directory is the only unbounded growth, by design**. Rather than auto-pruning
(which would defeat its purpose), the section reports kept total and disk free,
and offers an un-keep that drops the link.

### 5. HTTP surface

Served by the dashboard, which already runs as root on the host:

```
GET    /api/passes                  joined listing JSON
GET    /api/recordings/:id/video    mp4 stream
POST   /api/recordings/:id/keep     hardlink into keep/
DELETE /api/recordings/:id/keep     drop the keep link
GET    /api/snapshots/:id           thumbnail
```

Video is served with `res.sendFile`, which implements HTTP range requests
(`206 Partial Content`, `If-Range`, `ETag`). This is mandatory, not an
optimisation: without range support, every scrub of a 388 MB file re-downloads
from the beginning.

**`:id` identifies a FILE, not a pass** — a pass may own several files after a
segment rollover, so a pass-scoped video route would be ambiguous. The id is an
opaque token the server derives from the file's basename when it scans; the
listing hands the client the ids it may use, and `PassListing.files[]` carries
them.

**`:id` never reaches the filesystem.** It is looked up in the scanned index and
either resolves to a known absolute path or 404s; no client-supplied string is
ever concatenated into a path, which makes traversal unrepresentable rather than
merely filtered. `/api/snapshots/:id` resolves the same way, against the
snapshot scan. This matters because `dashboardAuth` defaults to `false` and this
is the first endpoint family serving arbitrary file content.

The daemon side exposes one MCP tool, `list_passes`, returning `PassRecord[]`
— it is the only process holding the tracking session. The dashboard fetches
that, scans the directories itself, and runs the shared join.

### 6. Playback UI

A separate page at `/playback`, not a tab inside the cockpit. The live view is a
real-time control surface for a physical rig; adding view-switching state to it
for a browsing feature is risk with no upside, and a separate route touches none
of it. A link in the cockpit nav points at it.

Filter bar: date range, text match on callsign/hex, minimum max-elevation,
maximum mean-pointing-error, has-video, kept-only.

One card per pass: thumbnail from the existing snapshot, callsign and type, time
and duration, geometry chips (closest range, max elevation, arc swept), a
tracking-quality chip, and Play / Keep / Download actions. An inline HTML5
player expands in place.

Sort is newest-first by default, with max-elevation and tracking-quality as
alternatives.

Passes whose video has been purged still appear, greyed and labelled "video
expired".

## Testing

- **Join, pure.** Window overlap; pass with no file; file with no pass; segment
  rollover attaching two files to one pass; grace-window boundary conditions.
- **Filename parsing, both directions.** MediaMTX host-local
  `%Y-%m-%d_%H-%M-%S-%f`; snapshot UTC ISO. A round-trip test pinning the
  local-vs-UTC asymmetry, since that is the easiest thing to get silently wrong.
- **Journal.** Append and read back; a truncated final line (crash mid-write) is
  skipped rather than throwing; unknown fields tolerated.
- **Aggregates.** A synthetic pass of known samples produces the expected min
  range, max elevation, arc and pointing-error statistics.
- **Keep.** Hardlink into a temp dir; the `EXDEV` fallback copies; un-keep drops
  the link without touching the original; keep is idempotent.
- **HTTP.** A hostile `:id` (`../../etc/passwd`, absolute paths, URL-encoded
  traversal) resolves to nothing and 404s. A range request returns 206 with the
  correct `Content-Range`.

## Success criteria

1. Every new pass produces a journal entry with identity, geometry and tracking
   quality.
2. The playback section lists passes newest-first with working thumbnails, and
   filters by callsign, elevation and tracking quality.
3. Video plays and **seeks** in the browser without re-downloading.
4. Keep survives the 7-day purge and consumes no extra disk at the moment it is
   taken.
5. The 68 existing recordings are identified by snapshot backfill.
6. A purged pass is still listed, marked "video expired".

## Out of scope

- Authentication. `dashboardAuth` stays as configured; this adds no new auth
  model, only the path-resolution rule above.
- Transcoding, clipping or trimming.
- Auto-pruning kept files.
- Any change to `CaptureController` or the record valve.
