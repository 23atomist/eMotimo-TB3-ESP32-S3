// MediaMTX recordPath is "%Y-%m-%d_%H-%M-%S-%f", rendered in HOST-LOCAL time.
const RECORDING_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{1,6})\.mp4$/;

// src/capture/snapshot.ts writes "<hex>[-<CALLSIGN>]-<iso>.jpg" where <iso> is
// a UTC ISO string with every ":" replaced by "-". The ISO segment contains
// its own dashes, so this is anchored on the ISO shape rather than split on
// "-": the date part would otherwise be indistinguishable from a separator.
const SNAPSHOT_RE =
  /^([0-9a-fA-F]+?)(?:-([A-Za-z0-9_]+))?-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z)\.jpg$/;

/**
 * Epoch ms for a MediaMTX recording filename, or null if it is not one.
 *
 * Constructed with the local-time Date constructor ON PURPOSE: MediaMTX
 * renders strftime in the host's timezone, and the deployed host runs MST.
 * Parsing these as UTC would shift every recording by the UTC offset and
 * silently mis-associate passes near the boundary.
 */
export function parseRecordingName(name: string): number | null {
  const m = RECORDING_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  // %f is microseconds, left-padded to 6; take the leading 3 as milliseconds.
  const ms = Number(frac.padEnd(6, "0").slice(0, 3));
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Identity and UTC instant from a snapshot filename, or null. */
export function parseSnapshotName(
  name: string,
): { icao: string; callsign: string | null; atMs: number } | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, icao, callsign, isoDashed] = m;
  // Undo snapshot.ts's ":" -> "-" substitution: only the TIME part's two
  // separators were colons; the date's dashes are original.
  const [datePart, timePart] = isoDashed.split("T");
  const iso = `${datePart}T${timePart.replace("-", ":").replace("-", ":")}`;
  const atMs = Date.parse(iso);
  if (!Number.isFinite(atMs)) return null;
  return { icao, callsign: callsign ?? null, atMs };
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Name for a kept recording: sortable, and identifiable outside the dashboard
 * entirely. Local time, matching the recording name it came from.
 */
export function keepFileName(startedAtMs: number, callsign: string | null, icao: string): string {
  const d = new Date(startedAtMs);
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const cs = callsign ? sanitizeSegment(callsign) : "";
  const hex = sanitizeSegment(icao) || "unknown";
  return cs === "" ? `${stamp}_${hex}.mp4` : `${stamp}_${cs}_${hex}.mp4`;
}

// keepFileName's own shape, read back. Segments are [A-Za-z0-9_]-sanitized, so
// the LAST underscore-separated field is the hex and anything between it and
// the timestamp is the callsign.
const KEEP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})_(?:([A-Za-z0-9]+)_)?([A-Za-z0-9]+)\.mp4$/;

/**
 * Recover a kept file's ORIGINAL pass start time and identity.
 *
 * Without this, a kept file would fall back to its mtime for a start time --
 * and mtime is when the LINK was made, not when the pass happened, so every
 * kept recording would drift out of its pass's window and show up
 * unattributed. The keep name is the only surviving record of the original
 * instant once MediaMTX has purged the source.
 */
export function parseKeepName(
  name: string,
): { atMs: number; callsign: string | null; icao: string } | null {
  const m = KEEP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, callsign, icao] = m;
  const atMs = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  if (!Number.isFinite(atMs)) return null;
  return { atMs, callsign: callsign ?? null, icao };
}
