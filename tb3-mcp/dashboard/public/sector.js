// Tracking-sector compass widget: a compass ring (N up, E right) showing the
// open arc (true-north bearings, clockwise start->end) tracking is
// restricted to. Two draggable handles set start_deg/end_deg; the wedge is
// the currently-armed arc. Not part of the SSE DashboardState snapshot (see
// server.ts's /api/sector) -- fetched once on load, then only ever pushed
// (never pulled) via POST /api/control/sector/set on drag-end / checkbox
// change, so this widget's local state (sectorLocal) is the source of truth
// between edits.
//
// RELOCATED into the Setup drawer (2026-07-28 dashboard redesign, task 10)
// -- moved as-is per the design doc ("relocated, not redesigned or
// reimplemented"). All the geometry/interaction logic below is byte-for-byte
// the same math that used to live inline in app.js when this widget's
// markup was always present in the DOM; only the MOUNTING mechanism changed,
// because it no longer is.
//
// That mounting change matters for one reason: drawer.js's _renderBody()
// only writes #drawer-body's innerHTML when the registered renderer's
// output actually changed (see its own doc), and a full innerHTML replace
// while a <circle> handle is under active pointer capture would drop that
// capture mid-drag (removing a captured element from the DOM implicitly
// releases capture) -- a real, reproducible regression this module must not
// reintroduce. So the split here is deliberate:
//
//   renderSectorEntry() -- returns a CONSTANT html string (no interpolation
//     at all), registered via drawer.setEntryRenderer("track-sector", ...).
//     Because it never varies, drawer.js's render-skip means the DOM subtree
//     is only ever (re)written when the operator actually NAVIGATES to this
//     entry (a discrete event that can't happen mid-drag) -- never on an
//     ordinary ~1Hz SSE-driven refresh() tick while the entry stays open.
//   paintSector(root, sector, estopLatched) -- the live visual update (wedge
//     shape, handle position, readouts, checkbox, disabled styling), applied
//     by DIRECTLY mutating the already-inserted DOM nodes found under
//     `root` -- never by regenerating the entry's html string. This is what
//     makes a live pointer-drag safe: dragging never goes through drawer.js's
//     diff-and-rewrite pipeline at all.
//   wireSectorDelegates(root, deps) -- attached ONCE, on the STABLE
//     #drawer-body container (never recreated by drawer.js, only its
//     children are), so the checkbox/handle listeners survive every
//     navigation-triggered rewrite without needing to be re-attached.

const SECTOR_CX = 100;
const SECTOR_CY = 100;
const SECTOR_R = 80; // ring radius == handle orbit radius, in the 0..200 viewBox

// The daemon's disabled default is {enabled:false, startDeg:0, endDeg:360} --
// see track/sector.ts's DISABLED_SECTOR. Both handles land on the exact same
// point (north) for that value (bearingToPoint(0) === bearingToPoint(360)),
// so a fresh "enable" of that default is a zero-width no-op the operator
// can't even see, rather than a real arc to drag. Whenever we'd otherwise
// land on that exact disabled default, seed a sensible non-degenerate arc
// instead, so enabling yields a real, visible ~270deg wedge to drag from.
// `enabled` always follows the daemon/checkbox as-is; only the handle
// bearings are ever substituted here.
export function seedNonDegenerate(sector) {
  if (!sector.enabled && sector.startDeg === 0 && sector.endDeg === 360) {
    return { ...sector, startDeg: 45, endDeg: 315 };
  }
  return sector;
}

// The widget's local state -- an exported `let`, not a getter function: ES
// module bindings are live, so `import { sectorLocal } from "./sector.js"`
// (radar.js's minimap wedge, this module's own paint/wire functions) always
// sees the CURRENT value, even after this module reassigns it internally.
export let sectorLocal = seedNonDegenerate({ startDeg: 0, endDeg: 360, enabled: false });

export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Compass bearing (0=N, 90=E, clockwise) -> {x,y} on the ring, in SVG
// user-space (y grows downward, so "up" is -y).
export function bearingToPoint(cx, cy, r, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

// Pointer-slice wedge path (center -> start -> arc -> end -> center) for a
// sub-arc that does NOT itself wrap past 360 (0 <= endDeg - startDeg <= 360).
export function wedgeSlicePath(cx, cy, r, startDeg, endDeg) {
  const span = endDeg - startDeg;
  const largeArc = span > 180 ? 1 : 0;
  const p1 = bearingToPoint(cx, cy, r, startDeg);
  const p2 = bearingToPoint(cx, cy, r, endDeg);
  return `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`;
}

// The open arc sweeps clockwise from startDeg to endDeg and may wrap through
// north (see track/sector.ts's inArc). Splits into 1 or 2 [startDeg, endDeg]
// sub-spans, each with 0 <= end-start <= 360 (no sub-span itself wraps past
// 360), matching inArc's own start<=end vs. start>end branch. Shared by the
// SVG sector wedge (sectorWedgePaths, below) and the canvas minimap's sector
// wedge (radar.js) so both widgets draw the exact same arc.
export function sectorArcSpans(startDeg, endDeg) {
  const s = norm360(startDeg);
  const e = norm360(endDeg);
  if (s <= e) return [[s, e]];
  return [[s, 360], [0, e]];
}

// A single SVG arc command can express a wrapping arc directly, but walking
// the same north-wrap-split sub-spans as sectorArcSpans keeps each sub-path's
// large-arc-flag computation simple (each sub-span is guaranteed <= 360deg).
export function sectorWedgePaths(startDeg, endDeg, cx, cy, r) {
  return sectorArcSpans(startDeg, endDeg).map(([s, e]) => wedgeSlicePath(cx, cy, r, s, e));
}

// Screen (client) coords -> the SVG's own user-space coords, via the
// element's screen CTM -- robust to however big the <svg> is actually
// rendered on screen, unlike a manual bounding-box/viewBox ratio calc.
export function svgPointFromEvent(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: SECTOR_CX, y: SECTOR_CY };
  const loc = pt.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}

export function bearingFromPoint(x, y, cx, cy) {
  return norm360((Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI);
}

// norm360(360) collapses to 0, which would otherwise make the End readout
// show "0°" for a literal 360 value, looking like a broken zero-width arc
// pinned at north instead of "full circle / no restriction". seedNonDegenerate
// intercepts the one normal source of a raw 360 (the daemon's disabled
// default) before it ever reaches sectorLocal, so this is now a defensive
// fallback for any other enabled full-circle sector value; display it
// literally instead of normalizing it away. Dragging can never itself
// produce a raw 360 (bearingFromPoint always normalizes into [0,360) via
// norm360). Display-only: sectorLocal itself is never touched here, so the
// POST body is unaffected.
export function formatBearingReadout(rawDeg) {
  if (rawDeg === 360) return "360°";
  return `${Math.round(norm360(rawDeg))}°`;
}

// Runs a query rooted at `root` (typically #drawer-body, but any object
// exposing querySelector -- including a hand-rolled test fake) without
// throwing when the requested node isn't currently mounted (the operator
// isn't on the Track Sector entry right now, or hasn't opened the drawer at
// all yet) -- that's a normal, harmless "nothing to paint" case, not an error.
function q(root, selector) {
  return root && typeof root.querySelector === "function" ? root.querySelector(selector) : null;
}

// The Track Sector drawer entry's body -- literally the markup that used to
// live in index.html's standalone #sector section, minus the outer
// .panel.deck-panel/<h2> chrome the drawer's own head+nav already provides.
// A template literal with NO interpolation at all: this function returns the
// exact same string on every call, by construction -- see this module's own
// doc for why that constancy is load-bearing (drawer.js's render-skip must
// never see this entry's content "change" from an ordinary tick, or a
// mid-drag rewrite could drop the handle's pointer capture).
export function renderSectorEntry() {
  return `
    <div class="deck-body sector-body">
      <div id="sector-compass-wrap">
        <svg id="sector-compass" viewBox="0 0 200 200" width="180" height="180" aria-label="tracking azimuth sector">
          <circle id="sector-ring" cx="100" cy="100" r="80"></circle>
          <path id="sector-wedge-a" class="sector-wedge"></path>
          <path id="sector-wedge-b" class="sector-wedge"></path>
          <line x1="100" y1="20" x2="100" y2="180" class="compass-crosshair"></line>
          <line x1="20" y1="100" x2="180" y2="100" class="compass-crosshair"></line>
          <text x="100" y="13" class="compass-label" text-anchor="middle">N</text>
          <text x="192" y="104" class="compass-label" text-anchor="middle">E</text>
          <text x="100" y="199" class="compass-label" text-anchor="middle">S</text>
          <text x="8" y="104" class="compass-label" text-anchor="middle">W</text>
          <circle id="sector-handle-start" class="sector-handle" r="9"></circle>
          <circle id="sector-handle-end" class="sector-handle sector-handle-end" r="9"></circle>
        </svg>
      </div>
      <div class="sector-side">
        <dl>
          <dt>Start</dt><dd id="sector-start-readout">&mdash;</dd>
          <dt>End</dt><dd id="sector-end-readout">&mdash;</dd>
        </dl>
        <label id="sector-enable-label"><input id="sector-enable" type="checkbox"> Restrict to arc</label>
      </div>
    </div>
  `;
}

// Paints the CURRENT `sector`/`estopLatched` onto whatever sector-* nodes
// exist under `root` right now -- direct attribute/property mutation, never
// a re-render of the entry's html (see this module's own doc). A no-op if
// the Track Sector entry isn't currently mounted (root has no matching
// nodes) -- callers are free to call this unconditionally on every SSE tick
// (matching the original app.js's applyMotionGate(), which did exactly
// that), or right after the entry is navigated into (for an immediate
// paint, not a stale placeholder until the next tick -- see
// wireSectorDelegates's own module doc on why that timing matters).
export function paintSector(root, sector, estopLatched) {
  const s = sector ?? sectorLocal;
  const wedgeA = q(root, "#sector-wedge-a");
  if (!wedgeA) return; // not currently mounted -- nothing to paint

  const paths = sectorWedgePaths(s.startDeg, s.endDeg, SECTOR_CX, SECTOR_CY, SECTOR_R);
  wedgeA.setAttribute("d", paths[0] ?? "");
  const wedgeB = q(root, "#sector-wedge-b");
  if (wedgeB) {
    wedgeB.setAttribute("d", paths[1] ?? "");
    wedgeB.style.display = paths[1] ? "" : "none";
  }

  const startPt = bearingToPoint(SECTOR_CX, SECTOR_CY, SECTOR_R, s.startDeg);
  const endPt = bearingToPoint(SECTOR_CX, SECTOR_CY, SECTOR_R, s.endDeg);
  const handleStart = q(root, "#sector-handle-start");
  if (handleStart) {
    handleStart.setAttribute("cx", String(startPt.x));
    handleStart.setAttribute("cy", String(startPt.y));
    handleStart.classList.toggle("sector-handle-disabled", !!estopLatched);
  }
  const handleEnd = q(root, "#sector-handle-end");
  if (handleEnd) {
    handleEnd.setAttribute("cx", String(endPt.x));
    handleEnd.setAttribute("cy", String(endPt.y));
    handleEnd.classList.toggle("sector-handle-disabled", !!estopLatched);
  }

  const startReadout = q(root, "#sector-start-readout");
  if (startReadout) startReadout.textContent = formatBearingReadout(s.startDeg);
  const endReadout = q(root, "#sector-end-readout");
  if (endReadout) endReadout.textContent = formatBearingReadout(s.endDeg);

  const enableBox = q(root, "#sector-enable");
  if (enableBox) {
    enableBox.checked = !!s.enabled;
    enableBox.disabled = !!estopLatched;
  }

  const svg = q(root, "#sector-compass");
  if (svg) svg.classList.toggle("sector-disabled", !s.enabled);
}

// Debounced so a checkbox change right after a drag (or a fast double-drag)
// doesn't fire two overlapping set_track_sector calls.
const SECTOR_POST_DEBOUNCE_MS = 200;
let sectorPostTimer = null;
function postSectorDebounced(postControl, isEstopLatched) {
  // Mirrors the calibration buttons' `disabled = estopLatched`: sector
  // writes command no motion, but must still be blocked by E-STOP to match
  // the brief's reference pattern. Checked here (not just at drag-start) so
  // a latch that lands mid-drag still suppresses the trailing POST.
  if (isEstopLatched()) return;
  if (sectorPostTimer !== null) clearTimeout(sectorPostTimer);
  sectorPostTimer = setTimeout(() => {
    sectorPostTimer = null;
    postControl("sector/set", {
      start_deg: sectorLocal.startDeg,
      end_deg: sectorLocal.endDeg,
      enabled: sectorLocal.enabled,
    });
  }, SECTOR_POST_DEBOUNCE_MS);
}

// Attaches the checkbox + drag-handle listeners ONCE, delegated on `root`
// (app.js passes #drawer-body -- a node drawer.js never recreates, only
// rewrites the CHILDREN of). Delegation means these listeners need no
// re-attachment when the operator navigates away and back to Track Sector,
// unlike a direct addEventListener on the sector-* nodes themselves (which
// get destroyed and recreated on every such navigation).
export function wireSectorDelegates(root, { postControl, isEstopLatched }) {
  if (!root || typeof root.addEventListener !== "function") return;

  root.addEventListener("change", (evt) => {
    const target = evt.target;
    if (!target || target.id !== "sector-enable") return;
    sectorLocal = { ...sectorLocal, enabled: !!target.checked };
    paintSector(root, sectorLocal, isEstopLatched());
    postSectorDebounced(postControl, isEstopLatched);
  });

  root.addEventListener("pointerdown", (evt) => {
    const handle = evt.target && evt.target.closest ? evt.target.closest(".sector-handle") : null;
    if (!handle) return;
    // Handles are inert while E-STOPped -- matching the calibration buttons'
    // `disabled = estopLatched` (SVG <circle> has no native disabled state,
    // so this early-return is the functional half of that gate; the visual
    // half is the "sector-handle-disabled" class toggled by paintSector).
    if (isEstopLatched()) return;
    const which = handle.id === "sector-handle-start" ? "start" : "end";
    const svg = handle.ownerSVGElement || q(root, "#sector-compass");
    if (!svg) return;
    evt.preventDefault();
    if (handle.setPointerCapture) handle.setPointerCapture(evt.pointerId);

    const onMove = (mv) => {
      const p = svgPointFromEvent(svg, mv);
      const bearing = bearingFromPoint(p.x, p.y, SECTOR_CX, SECTOR_CY);
      sectorLocal = which === "start" ? { ...sectorLocal, startDeg: bearing } : { ...sectorLocal, endDeg: bearing };
      paintSector(root, sectorLocal, isEstopLatched());
    };
    const onUp = (up) => {
      if (handle.releasePointerCapture) handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      postSectorDebounced(postControl, isEstopLatched);
    };
    // pointercancel fires instead of pointerup when the gesture is interrupted
    // (e.g. the browser hands the pointer to scrolling/a system gesture, or a
    // touch is lost) -- without this, onMove/onUp stay registered forever and
    // the handle keeps "dragging" on stale listeners. Same cleanup as onUp,
    // including the trailing POST so any drag-in-progress is still persisted.
    const onCancel = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      postSectorDebounced(postControl, isEstopLatched);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  });
}

// One-shot fetch of the daemon's current sector at page load (see this
// module's own doc -- not part of the SSE snapshot). Updates `sectorLocal`
// only; painting happens separately, whenever the entry is actually mounted
// (see paintSector's own doc), since the drawer is virtually always closed
// at the point this resolves.
export async function initSector() {
  try {
    const res = await fetch("/api/sector");
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") {
        sectorLocal = seedNonDegenerate({
          startDeg: Number(data.startDeg) || 0,
          endDeg: Number(data.endDeg) || 0,
          enabled: !!data.enabled,
        });
      }
    }
  } catch {
    // Daemon unreachable at load time: keep the (already seeded,
    // non-degenerate) default and let the operator set it up manually; the
    // widget still works.
  }
}
