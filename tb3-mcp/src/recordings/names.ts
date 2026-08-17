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

// Deliberately excludes "_" even though it is otherwise a harmless filename
// character: "_" is keepFileName's OWN field separator, and KEEP_RE's
// identity groups are "_"-free ([A-Za-z0-9]+) so the LAST underscore
// unambiguously marks the hex boundary. Allowing "_" through here would let
// an identity containing "_" defeat that boundary -- greedy backtracking
// resolves it against the WRONG (last) underscore, e.g. callsign "AB_12"
// plus hex "a0_82" parses back as callsign "AB_12_a0" / hex "82" -- so a
// kept file's name could never be read back via parseKeepName, silently
// dropping it from the listing.
function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Name for a kept recording: sortable, and identifiable outside the dashboard
 * entirely. Local time, matching the recording name it came from.
 *
 * Carries milliseconds (not just whole seconds): a pass always begins BEFORE
 * its mp4 exists (CaptureController.beginPass awaits isArmed() -- a MediaMTX
 * HTTP round trip -- before setRecord(true)), so join.ts's
 * `f.startedAtMs >= p.startedAtMs` test has no slack to spare. Flooring this
 * timestamp to the second would push a kept file's reconstructed start below
 * its own pass's start whenever the file's sub-second part exceeds that
 * lock-to-record gap -- the common case -- detaching the kept file from the
 * very pass it was rescued from. The keep name is meant to be a LOSSLESS
 * record of the original instant; see parseKeepName below.
 */
export function keepFileName(startedAtMs: number, callsign: string | null, icao: string): string {
  const d = new Date(startedAtMs);
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
  const cs = callsign ? sanitizeSegment(callsign) : "";
  const hex = sanitizeSegment(icao) || "unknown";
  return cs === "" ? `${stamp}_${hex}.mp4` : `${stamp}_${cs}_${hex}.mp4`;
}

// keepFileName's own shape, read back. Segments are [A-Za-z0-9]-sanitized
// (sanitizeSegment strips "_" along with everything else non-alphanumeric),
// so the LAST underscore-separated field is unambiguously the hex and
// anything between it and the timestamp is the callsign.
//
// The ms group is OPTIONAL so a hypothetical older (pre-ms) name still
// parses -- no migration is actually needed since no kept files exist yet,
// but the fallback costs nothing and keeps parseKeepName total over both
// shapes of the timestamp prefix.
const KEEP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?_(?:([A-Za-z0-9]+)_)?([A-Za-z0-9]+)\.mp4$/;

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
  const [, y, mo, d, h, mi, s, ms, callsign, icao] = m;
  const atMs = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms ? Number(ms) : 0,
  ).getTime();
  if (!Number.isFinite(atMs)) return null;
  return { atMs, callsign: callsign ?? null, icao };
}
