// Mini-map (PPI radar): a canvas radar with the rig at center, north up.
// Range rings out to MAX_RANGE_KM, the current track-sector wedge (reusing
// sector.js's sectorLocal + sectorArcSpans so the compass widget and this
// radar can never show two different arcs), every nearby aircraft as a dot
// (bright = trackable, grey = blocked, via azRangeToXY from minimap.js), and
// -- if a target is currently locked -- a highlight ring + laser line to it.
// Colors are read from style.css's CSS custom properties (not hardcoded) so
// the canvas can't drift from the rest of the dashboard's theme.
//
// Split out of app.js (2026-07-28 dashboard redesign, task 10) purely to
// keep that file under this project's 800-line ceiling -- no behaviour
// change from what app.js's own "mini-map (PPI radar)" section already did.
// This module's own DOM (#minimap/#minimap-tooltip) stays in the cockpit's
// status column, unaffected by the Track Sector widget's move into the
// drawer -- only the SECTOR WEDGE it draws is sourced from sector.js now.
import { azRangeToXY, nearestDot } from "./minimap.js";
import { sectorLocal, sectorArcSpans } from "./sector.js";

// Fixed radar range, in km. Matches the daemon's default `adsbMaxRangeKm`
// (src/config.ts) -- the client has no way to read the daemon's actual
// configured value, so this is a display-only constant that should be kept
// in sync with that default by hand if it ever changes.
const MAX_RANGE_KM = 100;

const mmRootStyle = getComputedStyle(document.documentElement);
const mmCssVar = (name) => mmRootStyle.getPropertyValue(name).trim();
const MM_COLOR = {
  ring: mmCssVar("--border"),
  ringLabel: mmCssVar("--muted"),
  // Matches .sector-wedge / #sector-compass.sector-disabled .sector-wedge in
  // drawer.css (same fill/stroke pair, enabled vs. disabled).
  sectorOpenFill: "rgba(77, 163, 255, 0.28)",
  sectorOpenStroke: mmCssVar("--accent"),
  sectorClosedFill: "rgba(139, 150, 165, 0.18)",
  sectorClosedStroke: mmCssVar("--muted"),
  dotTrackable: mmCssVar("--green"),
  dotBlocked: mmCssVar("--grey"),
  target: mmCssVar("--yellow"),
  rig: mmCssVar("--text"),
};

// Module-level so hover/click can hit-test the exact dots the last frame
// drew (canvas has no DOM nodes to query/attach listeners to per-dot).
let miniMapDots = []; // [{ x, y, row }]

// Compass bearing (0=N, 90=E, clockwise) -> canvas angle (radians, 0 along
// +x, increasing clockwise in canvas's y-down space). Matches azRangeToXY's
// own convention (x = cx + r*sin(a), y = cy - r*cos(a)) so a wedge drawn with
// this and a dot plotted with azRangeToXY always agree on where "north" is.
function bearingToCanvasAngle(bearingDeg) {
  return ((bearingDeg - 90) * Math.PI) / 180;
}

function drawSectorWedge(ctx, cx, cy, radius, sector) {
  ctx.fillStyle = sector.enabled ? MM_COLOR.sectorOpenFill : MM_COLOR.sectorClosedFill;
  ctx.strokeStyle = sector.enabled ? MM_COLOR.sectorOpenStroke : MM_COLOR.sectorClosedStroke;
  ctx.lineWidth = 1;
  for (const [s, e] of sectorArcSpans(sector.startDeg, sector.endDeg)) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, bearingToCanvasAngle(s), bearingToCanvasAngle(e), false);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

export function renderMiniMap(el, state) {
  const cv = el.minimap;
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 14;
  const maxKm = MAX_RANGE_KM;
  ctx.clearRect(0, 0, W, H);

  // Range rings, labeled at the top of each ring (north).
  ctx.strokeStyle = MM_COLOR.ring;
  ctx.fillStyle = MM_COLOR.ringLabel;
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillText(`${Math.round(maxKm * frac)}km`, cx, cy - radius * frac - 3);
  }

  // Compass letters at the rim (N up, clockwise).
  ctx.fillStyle = MM_COLOR.ringLabel;
  const compassPts = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
  for (const [label, bearing] of compassPts) {
    const p = azRangeToXY(bearing, maxKm, maxKm, cx, cy, radius + 10);
    ctx.textBaseline = "middle";
    ctx.fillText(label, p.x, p.y);
  }

  // Sector wedge -- UNDER the dots, reusing the compass widget's own
  // sectorLocal + north-wrap-aware sectorArcSpans (sector.js).
  drawSectorWedge(ctx, cx, cy, radius, sectorLocal);

  // Aircraft dots.
  miniMapDots = [];
  const aircraft = (state.adsb && state.adsb.aircraft) || [];
  for (const row of aircraft) {
    if (!Number.isFinite(row.azimuth_deg) || !Number.isFinite(row.range_km)) continue;
    const p = azRangeToXY(row.azimuth_deg, Math.min(row.range_km, maxKm), maxKm, cx, cy, radius);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    // row.trackable === null pre-calibration (rig location set, orientation
    // not yet solved) shares the grey "blocked" dot -- no new color invented,
    // it just isn't claimed bright/trackable. The tooltip above disambiguates
    // "not calibrated" from a real block (sun/slew/sector/pan-tilt).
    ctx.fillStyle = row.trackable === true ? MM_COLOR.dotTrackable : MM_COLOR.dotBlocked;
    ctx.fill();
    miniMapDots.push({ x: p.x, y: p.y, row });
  }

  // Tracked target: laser line from the rig + a highlight ring.
  const trk = state.tracking;
  if (trk && trk.hex && Number.isFinite(trk.targetAzDeg) && Number.isFinite(trk.targetRangeM)) {
    const p = azRangeToXY(trk.targetAzDeg, Math.min(trk.targetRangeM / 1000, maxKm), maxKm, cx, cy, radius);
    ctx.strokeStyle = MM_COLOR.target;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // "Not calibrated" placeholder text, centered, per the mini-map's design
  // spec ("rings + a 'not calibrated' placeholder" when uncalibrated).
  // Display-only -- doesn't touch the dot/laser/wedge logic above, which
  // already degrades gracefully (no dots, never throws) when uncalibrated.
  if (!state.calibration || !state.calibration.calibrated) {
    ctx.fillStyle = MM_COLOR.ringLabel;
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("not calibrated", cx, cy);
  }

  // Rig marker at center, drawn last so it's never hidden under a ring/wedge.
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
  ctx.fillStyle = MM_COLOR.rig;
  ctx.fill();
}

// Client (CSS pixel) coords -> canvas-buffer pixel coords, accounting for the
// canvas's intrinsic width/height (320x320) being scaled down to fit the
// rail via `max-width:100%` in cockpit.css.
function minimapEventToCanvasXY(el, e) {
  const rect = el.minimap.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.minimap.width / rect.width),
    y: (e.clientY - rect.top) * (el.minimap.height / rect.height),
    rect,
  };
}

const MINIMAP_HIT_PX = 8;

// deps: isEstopLatched, isSunLocked -- () => boolean; postControl -- the
// shared postControl adapter, used to fire `track` on a clicked, trackable
// dot (same gate/action the aircraft list's own [Track] button uses).
export function wireRadarEvents(el, { isEstopLatched, isSunLocked, postControl }) {
  el.minimap.addEventListener("mousemove", (e) => {
    const { x: px, y: py, rect } = minimapEventToCanvasXY(el, e);
    const hit = nearestDot(miniMapDots, px, py, MINIMAP_HIT_PX);
    if (!hit) {
      el.minimapTooltip.hidden = true;
      el.minimap.style.cursor = "default";
      return;
    }
    const r = hit.row;
    // r.trackable is null (not false) pre-calibration -- rig location set but
    // mount orientation not yet solved, see deriveTrackable in
    // src/dashboard/state.ts -- so say "not calibrated", not "blocked" (which
    // implies a known reason: sun, slew, sector, or pan/tilt limits).
    const status = r.trackable === true ? "" : r.trackable === null ? " · not calibrated" : " · blocked";
    el.minimapTooltip.textContent =
      `${r.callsign || r.hex} · ${r.altitude_m ?? "?"}m · ${r.range_km.toFixed(0)}km · el ${r.elevation_deg.toFixed(0)}°` +
      status;
    el.minimapTooltip.style.left = `${e.clientX - rect.left + 8}px`;
    el.minimapTooltip.style.top = `${e.clientY - rect.top + 8}px`;
    el.minimapTooltip.hidden = false;
    // Pointer only when the dot is actually clickable: bright (trackable === true)
    // AND the click won't be a no-op -- same combined gate as applyMotionGate's
    // `disabled = estopLatched || sunLocked` (E-STOP or sun-lock both make the
    // click handler below a no-op).
    el.minimap.style.cursor = (r.trackable === true && !isEstopLatched() && !isSunLocked()) ? "pointer" : "default";
  });

  el.minimap.addEventListener("mouseleave", () => {
    el.minimapTooltip.hidden = true;
    el.minimap.style.cursor = "default";
  });

  el.minimap.addEventListener("click", (e) => {
    // Same combined gate the sidebar's .track-btn now applies via
    // cockpit.js's aircraftRowActions (which folds in estopLatched AND
    // sunLocked): the sidebar's Track button for the same plane is greyed
    // inert under a sun lock too, so the radar dot must not fire a track
    // command the cockpit's other controls all refuse.
    if (isEstopLatched() || isSunLocked()) return;
    const { x: px, y: py } = minimapEventToCanvasXY(el, e);
    const hit = nearestDot(miniMapDots, px, py, MINIMAP_HIT_PX);
    if (hit && hit.row.trackable === true) postControl("track", { hex: hit.row.hex });
  });
}
