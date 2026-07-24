"use strict";

// ---------------------------------------------------------------------------
// TB3 Ops Dashboard — vanilla cockpit SPA.
// No framework, no build step: this file is loaded directly via <script src>.
// It renders each SSE tick (a DashboardState snapshot) into the DOM and wires
// every control button to the matching POST /api/control/* endpoint.
// ---------------------------------------------------------------------------

// -- element refs -------------------------------------------------------

const el = {
  mode: document.getElementById("mode"),
  svc: {
    readsb: document.getElementById("svc-readsb"),
    tb3mcp: document.getElementById("svc-tb3mcp"),
    tb3agent: document.getElementById("svc-tb3agent"),
    llama: document.getElementById("svc-llama"),
  },
  estop: document.getElementById("estop"),
  reconnectBanner: document.getElementById("reconnect-banner"),
  sunBanner: document.getElementById("sun-banner"),
  estopBanner: document.getElementById("estop-banner"),
  estopBannerDetail: document.getElementById("estop-banner-detail"),
  estopClear: document.getElementById("estop-clear"),

  camera: document.getElementById("camera"),
  cameraFrame: document.getElementById("camera-frame"),
  cameraToggle: document.getElementById("camera-toggle"),
  jogUp: document.getElementById("jog-up"),
  jogDown: document.getElementById("jog-down"),
  jogLeft: document.getElementById("jog-left"),
  jogRight: document.getElementById("jog-right"),
  autoToggle: document.getElementById("auto-toggle"),
  stopTracking: document.getElementById("stop-tracking"),

  rigConnected: document.getElementById("rig-connected"),
  rigPanTilt: document.getElementById("rig-pantilt"),
  rigMoving: document.getElementById("rig-moving"),
  rigBattery: document.getElementById("rig-battery"),
  rigTelemetryAge: document.getElementById("rig-telemetry-age"),
  rigImuPitchRoll: document.getElementById("rig-imu-pitchroll"),
  rigImuTP: document.getElementById("rig-imu-tp"),

  trkState: document.getElementById("trk-state"),
  trkTarget: document.getElementById("trk-target"),
  trkAzEl: document.getElementById("trk-azel"),
  trkRange: document.getElementById("trk-range"),
  trkError: document.getElementById("trk-error"),
  trkLimits: document.getElementById("trk-limits"),

  adsbCount: document.getElementById("adsb-count"),
  adsbList: document.getElementById("adsb-list"),

  sectorSvg: document.getElementById("sector-compass"),
  sectorWedgeA: document.getElementById("sector-wedge-a"),
  sectorWedgeB: document.getElementById("sector-wedge-b"),
  sectorHandleStart: document.getElementById("sector-handle-start"),
  sectorHandleEnd: document.getElementById("sector-handle-end"),
  sectorStartReadout: document.getElementById("sector-start-readout"),
  sectorEndReadout: document.getElementById("sector-end-readout"),
  sectorEnable: document.getElementById("sector-enable"),

  calStatus: document.getElementById("cal-status"),
  calLat: document.getElementById("cal-lat"),
  calLon: document.getElementById("cal-lon"),
  calHeight: document.getElementById("cal-height"),
  calSetLocation: document.getElementById("cal-set-location"),
  calSightA: document.getElementById("cal-sight-a"),
  calSightB: document.getElementById("cal-sight-b"),
  calSolve: document.getElementById("cal-solve"),
  calClear: document.getElementById("cal-clear"),

  errors: document.getElementById("errors"),
  toastContainer: document.getElementById("toast-container"),
};

// Motion-capable controls: latched off by E-STOP and (visually) by the sun
// guard lock. Listed once so both gates can share the same enable/disable pass.
const motionControls = [
  el.jogUp, el.jogDown, el.jogLeft, el.jogRight, el.autoToggle,
];

// -- auth bootstrap -----------------------------------------------------

// When the server has `dashboardAuth: true`, /api and /camera require the
// mcpToken — but EventSource("/api/stream") and <img src="/camera/stream">
// cannot send a custom Authorization header. Work around this with a
// same-origin cookie instead: visiting the dashboard once with `?token=` in
// the URL stores it as a `tb3_token` cookie, which EventSource/<img>/fetch
// all carry automatically from then on. Runs first, before anything below
// opens the EventSource or sets the camera <img> src.
function bootstrapAuthToken() {
  const token = new URLSearchParams(location.search).get("token");
  if (token) {
    document.cookie = "tb3_token=" + encodeURIComponent(token) + "; path=/; SameSite=Strict";
  }
}
bootstrapAuthToken();

// -- local (client-only) UI state ---------------------------------------

let estopLatched = false;
let sunLocked = false;
let sunReason = "";
let agentOnFromState = false;
let cameraEnabledFromState = false;
let cameraRetryTimer = null;

const CAMERA_RETRY_MS = 4000;

// -- formatting helpers ---------------------------------------------------

function fmt(v, digits) {
  if (v === null || v === undefined) return "—"; // em dash for unavailable
  if (typeof v === "number") {
    return Number.isFinite(v) ? v.toFixed(digits === undefined ? 1 : digits) : "—";
  }
  return String(v);
}

function fmtBool(v) {
  if (v === null || v === undefined) return "—";
  return v ? "yes" : "no";
}

// Pairs two possibly-null numeric fields into "a° / b°", collapsing to a
// single "—" (rather than "—° / —°") when both are unavailable.
function fmtPair(a, b, unit, digits) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return "—";
  return `${fmt(a, digits)}${unit} / ${fmt(b, digits)}${unit}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// -- toast ------------------------------------------------------------------

function toast(message, ok) {
  const div = document.createElement("div");
  div.className = "toast " + (ok ? "toast-ok" : "toast-err");
  div.textContent = message;
  el.toastContainer.appendChild(div);
  setTimeout(() => { div.classList.add("toast-out"); }, 2600);
  setTimeout(() => { div.remove(); }, 3000);
}

// -- control POST helper -----------------------------------------------------

async function postControl(path, body) {
  try {
    const res = await fetch("/api/control/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      toast(`${path}: HTTP ${res.status}`, false);
      return data;
    }
    if (data && typeof data.ok === "boolean") {
      toast(data.message ?? (data.ok ? "ok" : "failed"), data.ok);
    }
    return data;
  } catch (e) {
    toast(`${path}: ${e instanceof Error ? e.message : String(e)}`, false);
    return null;
  }
}

// -- motion-control gating ---------------------------------------------------

// Re-applies the combined disabled state (E-STOP latch OR sun-guard lock) to
// every motion-capable control, plus any currently-rendered ADS-B "Track"
// buttons (rebuilt each tick, so they need the same treatment on every render).
function applyMotionGate() {
  const disabled = estopLatched || sunLocked;
  for (const btn of motionControls) {
    if (!btn) continue;
    btn.disabled = disabled;
  }
  el.stopTracking.disabled = estopLatched; // stopping is always safe unless E-STOPped mid-latch
  for (const btn of el.adsbList.querySelectorAll("button.track-btn")) {
    btn.disabled = disabled;
  }
  for (const btn of [el.calSetLocation, el.calSightA, el.calSightB, el.calSolve, el.calClear]) {
    btn.disabled = estopLatched; // calibration writes are harmless under a sun lock, blocked only by E-STOP
  }

  // Sector writes command no motion, so — like calibration above — they're
  // blocked only by E-STOP, not the sun lock. The checkbox is a real form
  // control (.disabled works natively); the drag handles are plain SVG
  // <circle>s, which have no native disabled state, so they're greyed via a
  // CSS class and made functionally inert via an estopLatched check in the
  // pointerdown handler itself (see makeHandleDraggable below).
  el.sectorEnable.disabled = estopLatched;
  for (const h of [el.sectorHandleStart, el.sectorHandleEnd]) {
    h.classList.toggle("sector-handle-disabled", estopLatched);
  }

  if (sunLocked) {
    el.sunBanner.hidden = false;
    el.sunBanner.textContent = `Sun-avoidance guard locked — motion disabled${sunReason ? ": " + sunReason : ""}`;
  } else {
    el.sunBanner.hidden = true;
  }
}

// -- E-STOP -------------------------------------------------------------------

function latchEstop() {
  estopLatched = true;
  // Visibility is driven by the "show" class, not the [hidden] attribute:
  // an author-stylesheet `display` rule always beats the UA [hidden]{display:none}
  // rule, so relying on `hidden` here would leave the banner stuck.
  el.estopBanner.classList.add("show");
  applyMotionGate();
}

function clearEstopLatch() {
  estopLatched = false;
  el.estopBanner.classList.remove("show");
  el.estopBannerDetail.textContent = "";
  applyMotionGate();
}

async function doEstop() {
  // Latch immediately on click — this is a client-side safety latch, not a
  // reflection of confirmed server state, so it must not wait on the network.
  latchEstop();
  try {
    const res = await fetch("/api/control/estop", { method: "POST" });
    const data = await res.json();
    renderEstopResult(data);
  } catch (e) {
    el.estopBannerDetail.textContent =
      `request failed: ${e instanceof Error ? e.message : String(e)}`;
    toast("E-STOP request failed — remaining latched", false);
  }
}

function renderEstopResult(result) {
  if (!result || typeof result !== "object") {
    el.estopBannerDetail.textContent = "no response from server";
    return;
  }
  const legs = ["firmware", "tracking", "agent"];
  const parts = legs.map((leg) => {
    const r = result[leg];
    if (!r) return `${leg}: —`;
    return `${leg}: ${r.ok ? "ok" : "FAIL"} (${r.message})`;
  });
  el.estopBannerDetail.textContent = parts.join(" · ");
  toast(result.allOk ? "E-STOP: all legs stopped" : "E-STOP: one or more legs failed", !!result.allOk);
}

// -- render -------------------------------------------------------------------

function render(state) {
  if (!state || typeof state !== "object") return;

  renderMode(state.mode);
  renderServices(state.services);
  renderRig(state.rig);
  renderTracking(state.tracking);
  renderAdsb(state.adsb);
  renderCalibration(state.calibration);
  renderSunGuard(state.sunGuard);
  renderCamera(state.camera);
  renderErrors(state.errors);

  applyMotionGate();
}

// Drives the camera Start/Stop button off the server's authoritative camera
// status (so a second browser, or a reload, reflects the real on/off). The
// <img> stays attached to /camera/stream at all times: when the camera is
// disabled the server pushes only the placeholder frame (mtplvcap isn't
// running, nothing touches the camera's USB), so there's no <img> src juggling.
function renderCamera(camera) {
  const c = camera ?? { enabled: false, streaming: false, viewers: 0 };
  cameraEnabledFromState = !!c.enabled;
  el.cameraToggle.textContent = "Camera: " + (c.enabled ? (c.streaming ? "ON" : "STARTING…") : "OFF");
  el.cameraToggle.classList.toggle("toggle-on", c.enabled);
  if (el.cameraFrame) el.cameraFrame.classList.toggle("camera-off", !c.enabled);
}

function renderMode(mode) {
  const m = mode ?? "idle";
  el.mode.textContent = "MODE: " + m.toUpperCase();
  el.mode.dataset.mode = m;
}

function renderServices(services) {
  const s = services ?? {};
  for (const key of Object.keys(el.svc)) {
    const state = s[key] ?? "unknown";
    const dot = el.svc[key];
    dot.className = "led led-" + state;
    dot.title = `${key}: ${state}`;
  }
}

function renderRig(rig) {
  const r = rig ?? {};
  el.rigConnected.textContent = fmtBool(r.connected);
  el.rigConnected.className = r.connected ? "ok" : "bad";
  el.rigPanTilt.textContent = fmtPair(r.panDeg, r.tiltDeg, "°");
  el.rigMoving.textContent = fmtBool(r.moving);
  el.rigBattery.textContent = r.batteryV === null || r.batteryV === undefined
    ? "—" : `${fmt(r.batteryV, 2)} V`;
  el.rigTelemetryAge.textContent = r.telemetryAgeMs === null || r.telemetryAgeMs === undefined
    ? "—" : `${r.telemetryAgeMs} ms`;

  const imu = r.imu;
  if (imu && imu.ok) {
    el.rigImuPitchRoll.textContent = fmtPair(imu.pitchDeg, imu.rollDeg, "°");
    const temp = imu.tempC === null || imu.tempC === undefined ? "—" : `${fmt(imu.tempC)}°C`;
    const press = imu.pressHpa === null || imu.pressHpa === undefined ? "—" : `${fmt(imu.pressHpa, 0)} hPa`;
    el.rigImuTP.textContent = `${temp} / ${press}`;
  } else {
    el.rigImuPitchRoll.textContent = "—";
    el.rigImuTP.textContent = "—";
  }
}

function renderTracking(tracking) {
  const t = tracking ?? {};
  el.trkState.textContent = t.state ?? "—";
  el.trkTarget.textContent = t.hex
    ? `${t.callsign ?? t.hex} (${t.hex})`
    : "—";
  el.trkAzEl.textContent = fmtPair(t.targetAzDeg, t.targetElDeg, "°");
  el.trkRange.textContent = (t.targetRangeM === null || t.targetRangeM === undefined)
    ? "—" : `${fmt(t.targetRangeM, 0)} m`;
  el.trkError.textContent = (t.pointingErrorDeg === null || t.pointingErrorDeg === undefined)
    ? "—" : `${fmt(t.pointingErrorDeg)}°`;

  const badges = [];
  if (t.panLimited) badges.push("PAN LIMITED");
  if (t.tiltLimited) badges.push("TILT LIMITED");
  el.trkLimits.textContent = badges.length ? badges.join(", ") : "none";
  el.trkLimits.className = badges.length ? "bad" : "ok";
}

function renderAdsb(adsb) {
  const a = adsb ?? { rawCount: null, trackable: [] };
  const trackable = Array.isArray(a.trackable) ? a.trackable : [];
  el.adsbCount.textContent = a.rawCount === null || a.rawCount === undefined
    ? `(${trackable.length} trackable)`
    : `(${trackable.length} trackable / ${a.rawCount} seen)`;

  if (trackable.length === 0) {
    el.adsbList.innerHTML = '<div class="list-empty">no trackable aircraft</div>';
    return;
  }

  el.adsbList.innerHTML = trackable.map((row) => {
    const label = escapeHtml(row.callsign || row.hex);
    const alt = row.altitude_m === null || row.altitude_m === undefined ? "—" : `${Math.round(row.altitude_m)} m`;
    const gs = row.ground_speed_kt === null || row.ground_speed_kt === undefined ? "—" : `${Math.round(row.ground_speed_kt)} kt`;
    return `
      <div class="adsb-row" data-hex="${escapeHtml(row.hex)}">
        <div class="adsb-main">
          <span class="adsb-label" title="alt ${alt}, gs ${gs}, cat ${escapeHtml(row.category ?? "—")}, sqk ${escapeHtml(row.squawk ?? "—")}">${label}</span>
          <button type="button" class="track-btn" data-hex="${escapeHtml(row.hex)}">Track</button>
        </div>
        <div class="adsb-meta">
          az ${fmt(row.azimuth_deg, 0)}° / el ${fmt(row.elevation_deg, 0)}°
          &middot; ${fmt(row.range_km, 1)} km
          &middot; ${Math.round(row.est_track_sec)}s
        </div>
      </div>`;
  }).join("");

  for (const btn of el.adsbList.querySelectorAll("button.track-btn")) {
    btn.addEventListener("click", () => {
      postControl("track", { hex: btn.dataset.hex });
    });
  }
}

function renderCalibration(calibration) {
  const c = calibration ?? { calibrated: false, rig: null, sightings: [], solvedAt: null };
  const sightingCount = Array.isArray(c.sightings) ? c.sightings.length : 0;
  const rigLoc = c.rig ? `${fmt(c.rig.lat, 5)}, ${fmt(c.rig.lon, 5)} @ ${fmt(c.rig.height, 1)} m` : "no rig location";
  el.calStatus.innerHTML =
    `<span class="${c.calibrated ? "ok" : "muted"}">${c.calibrated ? "CALIBRATED" : "not calibrated"}</span>` +
    ` &middot; ${escapeHtml(rigLoc)} &middot; ${sightingCount} sighting(s)` +
    (c.solvedAt ? ` &middot; solved ${escapeHtml(c.solvedAt)}` : "");
}

function renderSunGuard(sunGuard) {
  const s = sunGuard ?? { state: "unknown", locked: false, separationDeg: null };
  sunLocked = !!s.locked;
  sunReason = s.separationDeg === null || s.separationDeg === undefined
    ? s.state
    : `${s.state}, separation ${fmt(s.separationDeg, 1)}°`;
}

function renderErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  el.errors.textContent = list.length === 0 ? "no errors" : list.join(" · ");
  el.errors.className = list.length === 0 ? "muted" : "bad";
}

// -- calibration input helper --------------------------------------------

function readCalInputs() {
  const lat = parseFloat(el.calLat.value);
  const lon = parseFloat(el.calLon.value);
  const height = parseFloat(el.calHeight.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(height)) {
    toast("lat/lon/height must all be numbers", false);
    return null;
  }
  return { lat, lon, height_m: height };
}

// -- control wiring -------------------------------------------------------

el.estop.addEventListener("click", doEstop);
el.estopClear.addEventListener("click", clearEstopLatch);

// Jog step presets: coarse to get roughly on target, fine to nail it. Distance
// grows with both dps and duration; fine is a slow short pulse for precision.
const JOG_STEPS = {
  fine:   { dps: 4,  ms: 150 },
  med:    { dps: 12, ms: 350 },
  coarse: { dps: 19, ms: 1200 },
};
let jogStep = "med";

function jog(panMul, tiltMul) {
  const s = JOG_STEPS[jogStep] ?? JOG_STEPS.med;
  postControl("jog", { pan_dps: panMul * s.dps, tilt_dps: tiltMul * s.dps, duration_ms: s.ms });
}

// Left/right were reversed vs. the camera view — pan sign swapped here.
el.jogUp.addEventListener("click", () => jog(0, 1));
el.jogDown.addEventListener("click", () => jog(0, -1));
el.jogLeft.addEventListener("click", () => jog(1, 0));
el.jogRight.addEventListener("click", () => jog(-1, 0));

for (const btn of document.querySelectorAll(".step-btn")) {
  btn.addEventListener("click", () => {
    jogStep = btn.dataset.step;
    for (const b of document.querySelectorAll(".step-btn")) b.classList.toggle("step-on", b === btn);
  });
}

el.autoToggle.addEventListener("click", () => {
  const next = !agentOnFromState;
  postControl("agent", { on: next });
});

el.stopTracking.addEventListener("click", () => postControl("stop", {}));

// Camera Start/Stop is state-driven: we POST the intent and let the next SSE
// tick flip the button via renderCamera().
el.cameraToggle.addEventListener("click", () => {
  if (cameraEnabledFromState) postControl("camera/stop", {});
  else postControl("camera/start", {});
});

el.calSetLocation.addEventListener("click", () => {
  const body = readCalInputs();
  if (body) postControl("calibrate/set-location", body);
});
el.calSightA.addEventListener("click", () => {
  const body = readCalInputs();
  if (body) postControl("calibrate/sight", { ...body, label: "A" });
});
el.calSightB.addEventListener("click", () => {
  const body = readCalInputs();
  if (body) postControl("calibrate/sight", { ...body, label: "B" });
});
el.calSolve.addEventListener("click", () => postControl("calibrate/solve", {}));
el.calClear.addEventListener("click", () => postControl("calibrate/clear", {}));

// -- tracking-sector compass widget ------------------------------------------
//
// A compass ring (N up, E right) showing the open arc (true-north bearings,
// clockwise start->end) tracking is restricted to. Two draggable handles set
// start_deg/end_deg; the wedge is the currently-armed arc. Not part of the
// SSE DashboardState snapshot (see server.ts's /api/sector) — fetched once on
// load, then only ever pushed (never pulled) via POST /api/control/sector/set
// on drag-end / checkbox change, so this widget's local state is the source
// of truth between edits.

const SECTOR_CX = 100;
const SECTOR_CY = 100;
const SECTOR_R = 80; // ring radius == handle orbit radius, in the 0..200 viewBox

// The daemon's disabled default is {enabled:false, startDeg:0, endDeg:360} —
// see track/sector.ts's DISABLED_SECTOR. Both handles land on the exact same
// point (north) for that value (bearingToPoint(0) === bearingToPoint(360)),
// so a fresh "enable" of that default is a zero-width no-op the operator
// can't even see, rather than a real arc to drag. Whenever we'd otherwise
// land on that exact disabled default, seed a sensible non-degenerate arc
// instead, so enabling yields a real, visible ~270deg wedge to drag from.
// `enabled` always follows the daemon/checkbox as-is; only the handle
// bearings are ever substituted here.
function seedNonDegenerate(sector) {
  if (!sector.enabled && sector.startDeg === 0 && sector.endDeg === 360) {
    return { ...sector, startDeg: 45, endDeg: 315 };
  }
  return sector;
}

let sectorLocal = seedNonDegenerate({ startDeg: 0, endDeg: 360, enabled: false });

function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Compass bearing (0=N, 90=E, clockwise) -> {x,y} on the ring, in SVG
// user-space (y grows downward, so "up" is -y).
function bearingToPoint(cx, cy, r, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

// Pointer-slice wedge path (center -> start -> arc -> end -> center) for a
// sub-arc that does NOT itself wrap past 360 (0 <= endDeg - startDeg <= 360).
function wedgeSlicePath(cx, cy, r, startDeg, endDeg) {
  const span = endDeg - startDeg;
  const largeArc = span > 180 ? 1 : 0;
  const p1 = bearingToPoint(cx, cy, r, startDeg);
  const p2 = bearingToPoint(cx, cy, r, endDeg);
  return `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`;
}

// The open arc sweeps clockwise from startDeg to endDeg and may wrap through
// north (see track/sector.ts's inArc). A single SVG arc command can express
// that directly, but splitting at 0deg/360deg when start>end keeps each
// sub-path's large-arc-flag computation simple and matches inArc's own
// start<=end vs. start>end branch.
function sectorWedgePaths(startDeg, endDeg, cx, cy, r) {
  const s = norm360(startDeg);
  const e = norm360(endDeg);
  if (s <= e) return [wedgeSlicePath(cx, cy, r, s, e)];
  return [wedgeSlicePath(cx, cy, r, s, 360), wedgeSlicePath(cx, cy, r, 0, e)];
}

// Screen (client) coords -> the SVG's own user-space coords, via the
// element's screen CTM — robust to however big the <svg> is actually
// rendered on screen, unlike a manual bounding-box/viewBox ratio calc.
function svgPointFromEvent(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: SECTOR_CX, y: SECTOR_CY };
  const loc = pt.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}

function bearingFromPoint(x, y, cx, cy) {
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
function formatBearingReadout(rawDeg) {
  if (rawDeg === 360) return "360°";
  return `${Math.round(norm360(rawDeg))}°`;
}

function renderSector(sector) {
  const s = sector ?? sectorLocal;
  const paths = sectorWedgePaths(s.startDeg, s.endDeg, SECTOR_CX, SECTOR_CY, SECTOR_R);
  el.sectorWedgeA.setAttribute("d", paths[0] ?? "");
  el.sectorWedgeB.setAttribute("d", paths[1] ?? "");
  el.sectorWedgeB.style.display = paths[1] ? "" : "none";

  const startPt = bearingToPoint(SECTOR_CX, SECTOR_CY, SECTOR_R, s.startDeg);
  const endPt = bearingToPoint(SECTOR_CX, SECTOR_CY, SECTOR_R, s.endDeg);
  el.sectorHandleStart.setAttribute("cx", String(startPt.x));
  el.sectorHandleStart.setAttribute("cy", String(startPt.y));
  el.sectorHandleEnd.setAttribute("cx", String(endPt.x));
  el.sectorHandleEnd.setAttribute("cy", String(endPt.y));

  el.sectorStartReadout.textContent = formatBearingReadout(s.startDeg);
  el.sectorEndReadout.textContent = formatBearingReadout(s.endDeg);
  el.sectorEnable.checked = !!s.enabled;
  el.sectorSvg.classList.toggle("sector-disabled", !s.enabled);
}

// Debounced so a checkbox change right after a drag (or a fast double-drag)
// doesn't fire two overlapping set_track_sector calls.
const SECTOR_POST_DEBOUNCE_MS = 200;
let sectorPostTimer = null;
function postSectorDebounced() {
  // Mirrors the calibration buttons' `disabled = estopLatched`: sector
  // writes command no motion, but must still be blocked by E-STOP to match
  // the brief's reference pattern. Checked here (not just at drag-start) so
  // a latch that lands mid-drag still suppresses the trailing POST.
  if (estopLatched) return;
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

function makeHandleDraggable(handleEl, which) {
  handleEl.addEventListener("pointerdown", (evt) => {
    // Handles are inert while E-STOPped — matching the calibration buttons'
    // `disabled = estopLatched` (SVG <circle> has no native disabled state,
    // so this early-return is the functional half of that gate; the visual
    // half is the "sector-handle-disabled" class toggled in applyMotionGate).
    if (estopLatched) return;
    evt.preventDefault();
    handleEl.setPointerCapture(evt.pointerId);

    const onMove = (mv) => {
      const p = svgPointFromEvent(el.sectorSvg, mv);
      const bearing = bearingFromPoint(p.x, p.y, SECTOR_CX, SECTOR_CY);
      if (which === "start") sectorLocal = { ...sectorLocal, startDeg: bearing };
      else sectorLocal = { ...sectorLocal, endDeg: bearing };
      renderSector(sectorLocal);
    };
    const onUp = (up) => {
      handleEl.releasePointerCapture(up.pointerId);
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onCancel);
      postSectorDebounced();
    };
    // pointercancel fires instead of pointerup when the gesture is interrupted
    // (e.g. the browser hands the pointer to scrolling/a system gesture, or a
    // touch is lost) — without this, onMove/onUp stay registered forever and
    // the handle keeps "dragging" on stale listeners. Same cleanup as onUp,
    // including the trailing POST so any drag-in-progress is still persisted.
    const onCancel = (cancel) => {
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", onUp);
      handleEl.removeEventListener("pointercancel", onCancel);
      postSectorDebounced();
    };
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", onUp);
    handleEl.addEventListener("pointercancel", onCancel);
  });
}

makeHandleDraggable(el.sectorHandleStart, "start");
makeHandleDraggable(el.sectorHandleEnd, "end");

el.sectorEnable.addEventListener("change", () => {
  sectorLocal = { ...sectorLocal, enabled: el.sectorEnable.checked };
  postSectorDebounced();
});

async function initSector() {
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
  renderSector(sectorLocal);
}

// -- camera stream fallback --------------------------------------------------

// The <img> camera stream shows the browser's broken-image icon with no
// recovery when the stream is down. Instead: on load failure, show an
// in-cockpit placeholder and periodically retry (cache-busted) until the
// stream comes back.

function markCameraDown() {
  if (el.cameraFrame) el.cameraFrame.classList.add("camera-down");
  scheduleCameraRetry();
}

function markCameraUp() {
  if (el.cameraFrame) el.cameraFrame.classList.remove("camera-down");
  if (cameraRetryTimer !== null) {
    clearTimeout(cameraRetryTimer);
    cameraRetryTimer = null;
  }
}

function scheduleCameraRetry() {
  if (cameraRetryTimer !== null) return; // a retry is already pending
  cameraRetryTimer = setTimeout(() => {
    cameraRetryTimer = null;
    el.camera.src = "/camera/stream?retry=" + Date.now();
  }, CAMERA_RETRY_MS);
}

el.camera.addEventListener("error", markCameraDown);
el.camera.addEventListener("load", markCameraUp);

// -- SSE stream -------------------------------------------------------------

function connectStream() {
  const source = new EventSource("/api/stream");

  source.onopen = () => {
    el.reconnectBanner.hidden = true;
  };

  source.onmessage = (e) => {
    el.reconnectBanner.hidden = true;
    try {
      const state = JSON.parse(e.data);
      agentOnFromState = state?.services?.tb3agent === "active";
      el.autoToggle.textContent = "Auto: " + (agentOnFromState ? "ON" : "OFF");
      el.autoToggle.classList.toggle("toggle-on", agentOnFromState);
      render(state);
    } catch (err) {
      // Malformed tick: ignore this frame, keep the last good render on screen.
    }
  };

  source.onerror = () => {
    el.reconnectBanner.hidden = false;
    // EventSource retries automatically; nothing else to do here.
  };
}

// Render an all-null/unavailable snapshot immediately so panels never show
// raw "undefined"/blank text before the first SSE tick arrives.
render({
  ts: 0,
  services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
  rig: { connected: false, panDeg: null, tiltDeg: null, moving: false, batteryV: null, telemetryAgeMs: null, imu: null },
  mode: "idle",
  tracking: {
    state: "unknown", hex: null, callsign: null, targetAzDeg: null, targetElDeg: null,
    targetRangeM: null, pointingErrorDeg: null, panLimited: false, tiltLimited: false,
  },
  calibration: { calibrated: false, rig: null, sightings: [], solvedAt: null },
  adsb: { rawCount: null, trackable: [] },
  sunGuard: { state: "unknown", locked: false, separationDeg: null },
  camera: { enabled: false, streaming: false, viewers: 0 },
  errors: [],
});

// Render the default (disabled, non-degenerate) sector immediately, then
// replace it with the daemon's actual sector once the one-shot fetch lands —
// mirrors the pattern above: synchronous placeholder render first, real data
// as soon as it's available.
renderSector(sectorLocal);
void initSector();

// Set here (rather than a static `src` in index.html) so it always fires
// after bootstrapAuthToken() has stored the tb3_token cookie above.
el.camera.src = "/camera/stream";

connectStream();
