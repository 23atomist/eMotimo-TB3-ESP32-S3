// PLAYBACK: the recordings-review page. Fetches /api/passes ONCE on load and
// filters/sorts entirely client-side from then on -- the listing is a few
// hundred rows at most, so re-fetching per keystroke would be pure waste
// (and would defeat the point of a client-side "min max-elevation" slider,
// which has to re-render on every drag tick).
//
// This is a standalone page, not a cockpit tab: the cockpit is real-time
// control of a physical rig and gains nothing from view-switching state
// (see index.html's nav-link comment / the commit that added this file).
//
// MediaMTX deletes recordings after 7 days -- this page is how the operator
// finds good passes and rescues them (Keep) before that happens. A listing
// whose video is gone still renders, greyed and labelled, because showing
// what was MISSED is the point (see card()'s own doc below).

const state = { listings: [], keepUsage: null, diskFreeBytes: null };

function $(id) {
  return document.getElementById(id);
}

// Same escaping idiom cockpit.js already uses for interpolated ADS-B text
// (callsign/hex) -- callsign/icao/category here come off the same external
// feed, so they get the same treatment before landing in innerHTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function load() {
  const results = $("results");
  try {
    const r = await fetch("/api/passes");
    if (!r.ok) {
      results.textContent = `failed: HTTP ${r.status}`;
      return;
    }
    const body = await r.json();
    state.listings = body.listings;
    state.keepUsage = body.keepUsage;
    state.diskFreeBytes = body.diskFreeBytes;
    render();
  } catch (e) {
    // fetch() itself rejects on a network failure (server down, offline) --
    // the brief's sketch only checked r.ok, which leaves that case an
    // unhandled rejection with nothing shown to the operator.
    results.textContent = `failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function readFilters() {
  return {
    text: $("f-text").value.trim().toLowerCase(),
    days: Number($("f-range").value),
    minEl: Number($("f-el").value),
    maxErr: Number($("f-err").value),
    hasVideo: $("f-video").checked,
    keptOnly: $("f-kept").checked,
    sort: $("f-sort").value,
  };
}

// Mirrors join.ts's own (module-private) startOf: newest-first ordering
// needs a single timestamp per listing regardless of whether it carries a
// pass (startedAtMs) or is an unattributed file (its first file's
// startedAtMs).
function startOf(l) {
  return l.pass ? l.pass.startedAtMs : (l.files[0]?.startedAtMs ?? 0);
}

function passes(l, f) {
  const p = l.pass;
  if (f.text) {
    const hay = `${p?.callsign ?? ""} ${p?.icao ?? ""}`.toLowerCase();
    if (!hay.includes(f.text)) return false;
  }
  if (f.days > 0 && startOf(l) < Date.now() - f.days * 86400000) return false;
  if (f.minEl > 0 && !(p && p.maxElevationDeg !== null && p.maxElevationDeg >= f.minEl)) return false;
  if (f.maxErr < 20 && !(p && p.meanPointingErrorDeg !== null && p.meanPointingErrorDeg <= f.maxErr)) return false;
  if (f.hasVideo && l.files.length === 0) return false;
  if (f.keptOnly && !l.files.some((x) => x.kept)) return false;
  return true;
}

// Null-safe numeric comparator: nulls always sort last regardless of
// direction, so "highest elevation" and "best tracked" don't scatter the
// un-measured (snapshot-backfilled, or geometry-less) rows through the
// middle of the list.
function cmpNullsLast(a, b, desc) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return desc ? b - a : a - b;
}

function sortListings(list, sortKey) {
  const copy = [...list];
  if (sortKey === "el") {
    copy.sort((a, b) => cmpNullsLast(a.pass?.maxElevationDeg ?? null, b.pass?.maxElevationDeg ?? null, true));
  } else if (sortKey === "qual") {
    copy.sort((a, b) => cmpNullsLast(a.pass?.meanPointingErrorDeg ?? null, b.pass?.meanPointingErrorDeg ?? null, false));
  } else {
    copy.sort((a, b) => startOf(b) - startOf(a));
  }
  return copy;
}

// snapshotFile (PassRecord) is a full filesystem path (see scan.ts's
// scanSnapshots / passesFromSnapshots) -- GET /api/snapshots/:id wants only
// the basename. This is the one place that split ever happens; the full
// path itself must never reach the DOM or a URL.
function base(p) {
  return p ? p.split("/").pop() : null;
}

function km(m) {
  return m === null ? "–" : `${(m / 1000).toFixed(1)} km`;
}

function deg(d) {
  return d === null ? "–" : `${d.toFixed(0)}°`;
}

function gb(bytes) {
  return bytes === null ? "unknown" : `${(bytes / 1e9).toFixed(1)} GB`;
}

// Quality bands: the 2026-08-16 calibration fix landed the rig at ~1.3°, so
// "good" is anything holding under 2°, and >5° means the target left frame.
function qualityClass(e) {
  if (e === null) return "q-unknown";
  return e <= 2 ? "q-good" : e <= 5 ? "q-fair" : "q-poor";
}

// Renders one listing as a card.
//
// A listing whose videoState !== "present" still renders -- greyed, labelled
// "video expired" or "not recorded", no Play/Keep. Showing what was MISSED
// is deliberate: this is the surface an operator uses to notice a pass never
// got captured at all.
//
// A listing with source === "snapshot" was identified by backfill from a
// snapshot filename alone: it has identity (callsign/icao) but no geometry
// and no tracking quality, because none was measured at the time. It gets an
// "inferred" badge and OMITS the geometry/quality chips entirely -- showing
// them as "–" would read as "tracked badly", not "never measured".
function card(l) {
  const p = l.pass;
  // Prefer a kept file over l.files[0]. Keeping a recording does NOT mutate
  // the original RecordingFile in place -- keepRecording() hardlinks a
  // SECOND copy into the keep dir, so a just-kept pass has two files with
  // the SAME startedAtMs (the keep name preserves it). files is sorted only
  // by startedAtMs (join.ts), so a stable sort leaves the original,
  // still-unkept entry at index 0 -- picking files[0] unconditionally would
  // pin the Keep button to "Keep" forever and point Play/Download at the
  // copy MediaMTX is still going to purge, even after the operator
  // successfully protected it. Found by driving the real Keep endpoint
  // end-to-end, not by reading the join.ts code alone.
  const f = l.files.find((x) => x.kept) ?? l.files[0] ?? null;
  const inferred = l.source === "snapshot";
  const kept = f ? f.kept : false;

  const el = document.createElement("div");
  el.className = "card" + (l.videoState !== "present" ? " no-video" : "");

  const thumbName = base(p?.snapshotFile ?? null);
  // Prefer the pass's own window; fall back to the file's when there is no
  // pass at all (an unattributed recording) so it isn't the only card with
  // no duration shown even though RecordingFile carries the timestamps to
  // compute one.
  const dur = p
    ? Math.round((p.endedAtMs - p.startedAtMs) / 1000)
    : (f ? Math.round((f.endedAtMs - f.startedAtMs) / 1000) : null);
  const whenMs = p ? p.startedAtMs : (f ? f.startedAtMs : null);
  const whenText = whenMs === null ? "unknown time" : new Date(whenMs).toLocaleString();

  const titleChips = [];
  if (p?.category) titleChips.push(`<span class="chip">${escapeHtml(p.category)}</span>`);
  if (inferred) {
    titleChips.push(
      '<span class="chip inferred" title="identified from the snapshot; nothing else was measured">inferred</span>',
    );
  }
  if (kept) titleChips.push('<span class="chip kept">kept</span>');

  const geometryHtml = (p && !inferred) ? `
    <div class="chips">
      <span class="chip">closest ${km(p.minRangeM)}</span>
      <span class="chip">max el ${deg(p.maxElevationDeg)}</span>
      <span class="chip">arc ${deg(p.azArcDeg)}</span>
      <span class="chip ${qualityClass(p.meanPointingErrorDeg)}">err ${
        p.meanPointingErrorDeg === null ? "–" : p.meanPointingErrorDeg.toFixed(1) + "°"
      }</span>
    </div>` : "";

  el.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="title">${escapeHtml(p?.callsign ?? p?.icao ?? "unattributed")} ${titleChips.join(" ")}</div>
      <div class="when">${whenText}${dur !== null ? ` · ${dur}s` : ""}</div>
      ${geometryHtml}
      <div class="actions"></div>
    </div>`;

  // Thumbnail wired via property assignment, not an inline onerror="" HTML
  // attribute -- this codebase never uses inline event-handler attributes
  // (cockpit.js wires everything via addEventListener/.onclick), so this
  // stays consistent with that rather than being the one exception. Lazy so
  // a page full of ~388MB-adjacent passes doesn't fire off a network
  // request per thumbnail before it is ever scrolled into view.
  if (thumbName) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = `/api/snapshots/${encodeURIComponent(thumbName)}`;
    img.onerror = () => { img.style.display = "none"; };
    el.querySelector(".thumb").append(img);
  }

  const actions = el.querySelector(".actions");
  if (l.videoState !== "present") {
    actions.className = "actions-note";
    actions.textContent = l.videoState === "expired" ? "video expired" : "not recorded";
  } else if (f) {
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "Play";
    play.onclick = () => {
      const v = document.createElement("video");
      v.controls = true;
      // Files reach ~388MB -- "metadata" only, never "auto"/"", so opening
      // this page never pulls the whole file over wifi just to show a frame.
      v.preload = "metadata";
      v.src = `/api/recordings/${f.id}/video`;
      el.querySelector(".thumb").replaceChildren(v);
    };

    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = f.kept ? "Un-keep" : "Keep";
    keep.onclick = async () => {
      keep.disabled = true;
      try {
        await fetch(`/api/recordings/${f.id}/keep`, { method: f.kept ? "DELETE" : "POST" });
      } finally {
        // Reload rather than hand-patch local state: a hardlink/unlink can
        // fail server-side (permissions, an already-vanished file), and
        // re-fetching is the only way this row ends up showing what the
        // server actually did rather than what the click optimistically
        // assumed.
        await load();
      }
    };

    const dl = document.createElement("a");
    dl.textContent = "Download";
    // f.name is the file's own basename (e.g. "N12345_2026-08-16T10-00-00.
    // mp4") -- a display string, never used to build a URL or an id, so
    // suggesting it as the download's filename is safe and far more useful
    // than the brief's `download=""` (which would suggest the literal
    // filename "video", the URL's last path segment, since :id is opaque).
    dl.download = f.name;
    dl.href = `/api/recordings/${f.id}/video`;

    actions.append(play, keep, dl);
  }

  return el;
}

function renderUsage() {
  const usage = $("usage");
  const ku = state.keepUsage;
  const parts = [];
  if (ku) parts.push(`kept: ${ku.files} file${ku.files === 1 ? "" : "s"} · ${gb(ku.bytes)}`);
  parts.push(`disk free: ${gb(state.diskFreeBytes)}`);
  usage.textContent = parts.join(" · ");
}

function render() {
  const f = readFilters();
  $("f-el-v").textContent = f.minEl > 0 ? `${f.minEl}°` : "0°";
  $("f-err-v").textContent = f.maxErr >= 20 ? "any" : `${f.maxErr}°`;

  const filtered = state.listings.filter((l) => passes(l, f));
  const sorted = sortListings(filtered, f.sort);

  const results = $("results");
  results.replaceChildren();
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "no passes match these filters";
    results.append(empty);
  } else {
    for (const l of sorted) results.append(card(l));
  }

  renderUsage();
}

function wireFilters() {
  for (const id of ["f-text", "f-range", "f-el", "f-err", "f-video", "f-kept", "f-sort"]) {
    $(id).addEventListener("input", render);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wireFilters();
  load();
});
