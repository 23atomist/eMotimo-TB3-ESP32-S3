"use strict";

// ---------------------------------------------------------------------------
// TB3 Ops Dashboard — vanilla cockpit SPA.
// No framework, no build step: this file is loaded directly via
// <script type="module" src>. It renders each SSE tick (a DashboardState
// snapshot) into the DOM and wires every control button to the matching
// POST /api/control/* endpoint. Module scope is safe here because this file
// is self-contained (addEventListener-based, no inline HTML handlers, and no
// other script on the page reaches into its globals).
// ---------------------------------------------------------------------------

import { azRangeToXY, nearestDot } from "./minimap.js";
import { RigView } from "./rigview.js";
import { WhepSession } from "./whep.js";
import { CameraPanel } from "./camera-panel.js";
import { renderCaptureLabel } from "./capture-label.js";
import { JogHold } from "./jog-hold.js";
import { JOG_MIN_DPS_DEFAULT, JOG_RAMP_SECONDS_DEFAULT } from "./jog-ramp.js";
import { buildAircraftOptions } from "./aircraft-select.js";

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

  cameraVideo: document.getElementById("camera-video"),
  cameraImg: document.getElementById("camera-img"),
  cameraFrame: document.getElementById("camera-frame"),
  videoStats: document.getElementById("video-stats"),
  cameraToggle: document.getElementById("camera-toggle"),
  sunguardToggle: document.getElementById("sunguard-toggle"),
  jogUp: document.getElementById("jog-up"),
  jogDown: document.getElementById("jog-down"),
  jogLeft: document.getElementById("jog-left"),
  jogRight: document.getElementById("jog-right"),
  autoToggle: document.getElementById("auto-toggle"),
  stopTracking: document.getElementById("stop-tracking"),
  captureStatus: document.getElementById("capture-status"),

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

  minimap: document.getElementById("minimap"),
  minimapTooltip: document.getElementById("minimap-tooltip"),

  rigview: document.getElementById("rigview"),

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
  calAircraftSelect: document.getElementById("cal-aircraft-select"),
  calSightAircraft: document.getElementById("cal-sight-aircraft"),
  calAircraftResult: document.getElementById("cal-aircraft-result"),

  errors: document.getElementById("errors"),
  toastContainer: document.getElementById("toast-container"),
};

// Live 3D rig view (scene shell in Task 1; the posed rig model lands in Task 3).
// Never throws — RigView catches WebGL failures and shows a text fallback.
const rigView = el.rigview ? new RigView(el.rigview) : null;

// The camera tile's dual-pipeline (WebRTC/MJPEG) state machine -- see
// camera-panel.js. DOM elements + the WHEP session factory are injected here
// (the only place this module reaches for document/window on its behalf);
// the panel itself never touches globals, which is what makes it testable.
const cameraPanel = new CameraPanel({
  video: el.cameraVideo,
  img: el.cameraImg,
  frame: el.cameraFrame,
  statsEl: el.videoStats,
  makeWhepSession: () => new WhepSession(),
});

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
let sunGuardEnabledFromState = false;

// Fixed radar range, in km. Matches the daemon's default `adsbMaxRangeKm`
// (src/config.ts) — the client has no way to read the daemon's actual
// configured value, so this is a display-only constant that should be kept
// in sync with that default by hand if it ever changes.
const MAX_RANGE_KM = 100;

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
  for (const btn of [el.calSetLocation, el.calSightA, el.calSightB, el.calSolve, el.calClear, el.calSightAircraft]) {
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
  renderMiniMap(state);
  if (rigView) rigView.update(state.rig);
  renderCalibration(state.calibration);
  renderCalAircraftOptions(state.adsb);
  renderSunGuard(state.sunGuard);
  renderCamera(state.camera);
  renderCapture(state.capture);
  renderErrors(state.errors);
  applyJogConfig(state.jog);

  applyMotionGate();
}

// capture is null both pre-first-poll and when the daemon leg is down
// (mergeState collapses both to null) -- renderCaptureLabel treats that the
// same as "no report yet" and shows a dash, never a false "ready".
function renderCapture(capture) {
  const cap = renderCaptureLabel(capture ?? null);
  el.captureStatus.textContent = cap.text;
  el.captureStatus.className = "stat " + cap.cls;
}

// Drives the camera Start/Stop button off the server's authoritative camera
// status (so a second browser, or a reload, reflects the real on/off), and
// hands the camera field to cameraPanel, which picks (and fully switches
// between) the two camera surfaces. This dual-path is the rig's WebRTC
// escape hatch: cameraSource keeps three values on purpose, so if MediaMTX
// misbehaves on the roof, flipping cameraSource back to mtplvcap/v4l2 in
// config.json and restarting must produce a working picture, not a dead
// panel -- CameraPanel (via pickCameraMode) defaults to "mjpeg" (the
// historically-working path) whenever source is missing/degraded too.
// `degraded` (MediaMtxPublisher only -- see camera/supervisor.ts's
// isDegraded()) means ingest exhausted its restart budget and gave up;
// nothing is actively retrying it moment-to-moment (a long-interval
// recovery nudge will eventually reset the budget on its own, but that can
// be up to 30s away). That must never be labeled the same as "STARTING...",
// which promises an active, imminent retry -- claiming "starting" over a
// pipeline that has actually given up is worse than showing nothing.
function renderCamera(camera) {
  const c = camera ?? { enabled: false, streaming: false, viewers: 0, source: null };
  cameraEnabledFromState = !!c.enabled;
  const label = !c.enabled ? "OFF" : c.degraded ? "DEGRADED" : (c.streaming ? "ON" : "STARTING…");
  el.cameraToggle.textContent = "Camera: " + label;
  el.cameraToggle.classList.toggle("toggle-on", c.enabled && !c.degraded);
  el.cameraToggle.classList.toggle("toggle-degraded", !!c.degraded);
  if (el.cameraFrame) el.cameraFrame.classList.toggle("camera-off", !c.enabled);
  cameraPanel.sync(c);
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

// Populates the aircraft-sighting <select> from the same range-sorted
// aircraft list the mini-map/ADS-B overlay use (state.adsb.aircraft) — see
// aircraft-select.js for the pure option-building/selection-preserving logic
// this just applies to the DOM.
function renderCalAircraftOptions(adsb) {
  const rows = Array.isArray(adsb && adsb.aircraft) ? adsb.aircraft : [];
  const { options, selectedHex } = buildAircraftOptions(rows, el.calAircraftSelect.value);
  if (options.length === 0) {
    el.calAircraftSelect.innerHTML = '<option value="">— none nearby —</option>';
    el.calAircraftSelect.disabled = true;
    return;
  }
  el.calAircraftSelect.disabled = false;
  el.calAircraftSelect.innerHTML = options
    .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");
  el.calAircraftSelect.value = selectedHex;
}

function renderSunGuard(sunGuard) {
  const s = sunGuard ?? { state: "unknown", locked: false, separationDeg: null };
  sunLocked = !!s.locked;
  sunReason = s.separationDeg === null || s.separationDeg === undefined
    ? s.state
    : `${s.state}, separation ${fmt(s.separationDeg, 1)}°`;

  // Degraded/not-yet-polled sun source → show "—", don't assert on/off (mirrors
  // the initial "Auto: —"), so a failed poll never misreports the guard as OFF.
  if (s.state === "unknown") {
    el.sunguardToggle.textContent = "Sun guard: —";
    el.sunguardToggle.classList.remove("toggle-on");
    return;
  }
  const enabled = !!s.enabled;
  sunGuardEnabledFromState = enabled;
  el.sunguardToggle.textContent = "Sun guard: " + (enabled ? "ON" : "OFF");
  el.sunguardToggle.classList.toggle("toggle-on", enabled);
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

// -- press-and-hold jog (ramped, dead-man via JogHold) -----------------------
//
// Replaces the old click-per-nudge + 3-speed-preset control ("micro
// micro-ish and race car", the operator's words): press and hold a
// direction, the rig ramps from a slow framing speed up to full rate over
// config.ts's jogRampSeconds (see jog-ramp.js), and release stops it
// immediately. jog-hold.js owns the posting cadence/ramp/failure-handling;
// everything here is just DOM wiring (pointer + keyboard) plus the
// E-STOP/sun-lock gate and the four directions' pan/tilt multipliers.
//
// jogVectorTtlMs stays a hand-synced constant deliberately, like
// MAX_RANGE_KM above -- it's the dead-man safety margin (see JogHold's doc
// comment), not a feel parameter, so it never needs iterating against
// hardware and there's no reason to wire it up live.
//
// maxJogDps/jogRampSeconds/jogMinDps ARE feel parameters, tuned against real
// hardware and a camera lens -- a code edit here per iteration would defeat
// the whole point of making them configurable (see config.ts). So unlike
// jogVectorTtlMs, the daemon pushes their current values on every SSE tick
// (DashboardState.jog -- see state.ts/server.ts), applied by
// applyJogConfig() below. The constants here are only the pre-first-tick /
// malformed-payload fallback, kept equal to config.ts's own defaults.
const JOG_VECTOR_TTL_MS = 500;
const MAX_JOG_DPS = 19;
const JOG_RAMP_SECONDS = JOG_RAMP_SECONDS_DEFAULT;
const JOG_MIN_DPS = JOG_MIN_DPS_DEFAULT;

// Left/right were reversed vs. the camera view — pan sign swapped here (same
// as the old click-based jog() did).
const JOG_SOURCES = {
  "jog-up":    { panMul: 0, tiltMul: 1, btn: el.jogUp },
  "jog-down":  { panMul: 0, tiltMul: -1, btn: el.jogDown },
  "jog-left":  { panMul: 1, tiltMul: 0, btn: el.jogLeft },
  "jog-right": { panMul: -1, tiltMul: 0, btn: el.jogRight },
};

const JOG_KEY_TO_SOURCE = {
  ArrowUp: "jog-up",
  ArrowDown: "jog-down",
  ArrowLeft: "jog-left",
  ArrowRight: "jog-right",
};

// Adapts postControl's "try/toast/return data-or-null" contract to the
// boolean success signal jog-hold.js needs to decide whether to keep
// posting. postControl already toasts on every failure path (HTTP error,
// thrown/network error, or an { ok:false } action result) — including the
// exact "network connection was lost" case the operator was already
// hitting — so no separate failure toast is needed here.
async function postJogVector(panDps, tiltDps, durationMs) {
  const data = await postControl("jog", { pan_dps: panDps, tilt_dps: tiltDps, duration_ms: durationMs });
  return !!(data && data.ok === true);
}

// Only one direction can be held at a time (mirrors the old one-button-at-
// a-time click model); this is which source (a JOG_SOURCES key) currently
// owns the active hold, so a stray release/keyup from a control that never
// started the hold is a no-op instead of cutting off someone else's press.
let activeHoldSource = null;

const jogHold = new JogHold({
  post: postJogVector,
  jogVectorTtlMs: JOG_VECTOR_TTL_MS,
  maxJogDps: MAX_JOG_DPS,
  jogRampSeconds: JOG_RAMP_SECONDS,
  jogMinDps: JOG_MIN_DPS,
  // Same combined gate as applyMotionGate's `disabled = estopLatched ||
  // sunLocked`, but checked on every keep-alive tick (not just at press) —
  // the jog buttons' `.disabled` only blocks a NEW press; it does nothing
  // for a hold already in progress when an E-STOP lands mid-hold, which is
  // exactly the regression this must not allow.
  isGated: () => estopLatched || sunLocked,
  // The loop already halted itself (no further posts); this just releases
  // the "one hold at a time" slot and the pressed-visual, so a failed POST
  // or a mid-hold gate trip doesn't leave the UI looking like it's still
  // held down. No further postControl call here — jogHold.stop() would be
  // a no-op anyway (the loop is already inactive), and there is no reason a
  // bare stop vector would land when the post that just failed didn't.
  onFailure: () => { releaseHoldSlot(); },
});

// A finite, positive number, or `fallback` -- guards applyJogConfig against
// a missing/malformed state.jog field (older daemon, dropped field, a stray
// string from a bad deploy) turning into NaN and a dead jog control. Every
// field is checked independently so one bad value doesn't drag the other
// two down with it.
function positiveFiniteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Applies the daemon's live jog-feel config (state.jog, sourced from
// config.ts's maxJogDps/jogRampSeconds/jogMinDps -- see state.ts) to the
// running JogHold, called on every render() tick. This is what makes the
// ramp tunable from config alone: no reload, no code edit, just a config
// change + daemon restart, picked up on the next SSE tick.
function applyJogConfig(jog) {
  const j = jog && typeof jog === "object" ? jog : {};
  jogHold.maxJogDps = positiveFiniteOr(j.maxJogDps, MAX_JOG_DPS);
  jogHold.jogRampSeconds = positiveFiniteOr(j.jogRampSeconds, JOG_RAMP_SECONDS);
  jogHold.jogMinDps = positiveFiniteOr(j.jogMinDps, JOG_MIN_DPS);
}

function releaseHoldSlot() {
  if (activeHoldSource === null) return;
  const source = JOG_SOURCES[activeHoldSource];
  if (source && source.btn) source.btn.classList.remove("jog-holding");
  activeHoldSource = null;
}

function startHold(sourceId) {
  if (activeHoldSource !== null) return; // another direction is already held
  const { panMul, tiltMul, btn } = JOG_SOURCES[sourceId];
  jogHold.start(panMul, tiltMul);
  if (!jogHold.active) return; // refused: gated (E-STOP / sun-lock)
  activeHoldSource = sourceId;
  if (btn) btn.classList.add("jog-holding");
}

// Only stops the hold if `sourceId` is the one that started it — the
// counterpart to startHold's single-slot guard, so e.g. a pointerleave on a
// button that never captured the pointer can't cut off an unrelated hold.
function stopHold(sourceId) {
  if (activeHoldSource !== sourceId) return;
  releaseHoldSlot();
  jogHold.stop();
}

// Stops whatever is currently held, regardless of which control started it —
// for the "a press can end without telling the control that started it"
// triggers (window blur, tab hidden): a button-hold-loop that keeps slewing
// because the operator alt-tabbed away, or switched tabs, is a genuine
// hazard on a roof-mounted rig.
function stopHoldUnconditionally() {
  if (activeHoldSource === null) return;
  releaseHoldSlot();
  jogHold.stop();
}

function wireJogHoldButton(sourceId) {
  const { btn } = JOG_SOURCES[sourceId];
  if (!btn) return;

  btn.addEventListener("pointerdown", (evt) => {
    if (btn.disabled) return; // defense in depth; a disabled button shouldn't fire this at all
    evt.preventDefault();
    btn.setPointerCapture(evt.pointerId); // a drag off the button still delivers pointerup here
    startHold(sourceId);
  });

  // pointerup: the normal release. pointerleave: the pointer physically left
  // the button (still fires under capture — capture only redirects
  // move/up/cancel, not enter/leave). pointercancel: the gesture was
  // interrupted (browser hands the pointer to a system gesture, a touch is
  // lost, etc.) — the same case makeHandleDraggable's sector-handle code
  // guards against. All three must stop the rig; none is optional.
  const endPress = (evt) => {
    if (btn.hasPointerCapture && btn.hasPointerCapture(evt.pointerId)) {
      btn.releasePointerCapture(evt.pointerId);
    }
    stopHold(sourceId);
  };
  btn.addEventListener("pointerup", endPress);
  btn.addEventListener("pointerleave", endPress);
  btn.addEventListener("pointercancel", endPress);
}

for (const sourceId of Object.keys(JOG_SOURCES)) wireJogHoldButton(sourceId);

window.addEventListener("blur", stopHoldUnconditionally);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopHoldUnconditionally();
});

function isTextEntryFocused() {
  const t = document.activeElement;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true;
}

document.addEventListener("keydown", (evt) => {
  if (evt.repeat) return; // auto-repeat must not restart the ramp
  const sourceId = JOG_KEY_TO_SOURCE[evt.key];
  if (!sourceId) return;
  if (isTextEntryFocused()) return; // don't hijack arrow keys while typing (e.g. cal lat/lon/height)
  evt.preventDefault();
  startHold(sourceId);
});

document.addEventListener("keyup", (evt) => {
  const sourceId = JOG_KEY_TO_SOURCE[evt.key];
  if (!sourceId) return;
  stopHold(sourceId);
});

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

// Sun-guard toggle is state-driven like Camera: POST the intent, let the next
// SSE tick flip the button via renderSunGuard(). It commands no rig motion, so
// it is deliberately NOT in motionControls and NOT gated by E-STOP / sun-lock —
// disabling the guard is the way to escape a standing sun-lock.
el.sunguardToggle.addEventListener("click", () => {
  postControl("sun-guard/set", { enabled: !sunGuardEnabledFromState });
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

el.calSightAircraft.addEventListener("click", async () => {
  const hex = el.calAircraftSelect.value;
  if (!hex) { toast("select an aircraft to sight", false); return; }
  const data = await postControl("calibrate/sight-aircraft", { hex });
  if (data && typeof data.message === "string") {
    el.calAircraftResult.textContent = data.message;
    el.calAircraftResult.className = data.ok ? "ok" : "bad";
  }
});

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
// north (see track/sector.ts's inArc). Splits into 1 or 2 [startDeg, endDeg]
// sub-spans, each with 0 <= end-start <= 360 (no sub-span itself wraps past
// 360), matching inArc's own start<=end vs. start>end branch. Shared by the
// SVG sector wedge (sectorWedgePaths, below) and the canvas minimap's sector
// wedge (renderMiniMap) so both widgets draw the exact same arc.
function sectorArcSpans(startDeg, endDeg) {
  const s = norm360(startDeg);
  const e = norm360(endDeg);
  if (s <= e) return [[s, e]];
  return [[s, 360], [0, e]];
}

// A single SVG arc command can express a wrapping arc directly, but walking
// the same north-wrap-split sub-spans as sectorArcSpans keeps each sub-path's
// large-arc-flag computation simple (each sub-span is guaranteed <= 360deg).
function sectorWedgePaths(startDeg, endDeg, cx, cy, r) {
  return sectorArcSpans(startDeg, endDeg).map(([s, e]) => wedgeSlicePath(cx, cy, r, s, e));
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

// -- mini-map (PPI radar) -----------------------------------------------------
//
// A canvas radar: rig at center, north up. Range rings out to MAX_RANGE_KM,
// the current track-sector wedge (reusing sectorLocal + sectorArcSpans from
// the compass widget above, so the two widgets can never show two different
// arcs), every nearby aircraft as a dot (bright = trackable, grey = blocked,
// via azRangeToXY from minimap.js), and — if a target is currently locked —
// a highlight ring + laser line to it. Colors are read from style.css's CSS
// custom properties (not hardcoded) so the canvas can't drift from the rest
// of the dashboard's theme.

const mmRootStyle = getComputedStyle(document.documentElement);
const mmCssVar = (name) => mmRootStyle.getPropertyValue(name).trim();
const MM_COLOR = {
  ring: mmCssVar("--border"),
  ringLabel: mmCssVar("--muted"),
  // Matches .sector-wedge / #sector-compass.sector-disabled .sector-wedge in
  // style.css (same fill/stroke pair, enabled vs. disabled).
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

function renderMiniMap(state) {
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

  // Sector wedge — UNDER the dots, reusing the compass widget's own
  // sectorLocal + north-wrap-aware sectorArcSpans.
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
  // Display-only — doesn't touch the dot/laser/wedge logic above, which
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
// rail via `max-width:100%` in style.css.
function minimapEventToCanvasXY(e) {
  const rect = el.minimap.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.minimap.width / rect.width),
    y: (e.clientY - rect.top) * (el.minimap.height / rect.height),
    rect,
  };
}

const MINIMAP_HIT_PX = 8;

el.minimap.addEventListener("mousemove", (e) => {
  const { x: px, y: py, rect } = minimapEventToCanvasXY(e);
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
  // AND the click won't be a no-op — same combined gate as applyMotionGate's
  // `disabled = estopLatched || sunLocked` (E-STOP or sun-lock both make the
  // click handler below a no-op).
  el.minimap.style.cursor = (r.trackable === true && !estopLatched && !sunLocked) ? "pointer" : "default";
});

el.minimap.addEventListener("mouseleave", () => {
  el.minimapTooltip.hidden = true;
  el.minimap.style.cursor = "default";
});

el.minimap.addEventListener("click", (e) => {
  // Same combined gate as applyMotionGate's `disabled = estopLatched ||
  // sunLocked`: the sidebar's .track-btn for the same plane is greyed inert
  // under a sun lock too, so the radar dot must not fire a track command the
  // cockpit's other controls all refuse.
  if (estopLatched || sunLocked) return;
  const { x: px, y: py } = minimapEventToCanvasXY(e);
  const hit = nearestDot(miniMapDots, px, py, MINIMAP_HIT_PX);
  if (hit && hit.row.trackable === true) postControl("track", { hex: hit.row.hex });
});

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
  adsb: { rawCount: null, aircraft: [], trackable: [] },
  sunGuard: { state: "unknown", locked: false, separationDeg: null },
  camera: { enabled: false, streaming: false, viewers: 0, source: null },
  capture: null,
  errors: [],
  // Missing here on purpose (no tick has landed yet) -- applyJogConfig
  // treats a missing/malformed jog the same as this and falls back to the
  // JOG_*_DEFAULT constants above.
  jog: null,
});

// Render the default (disabled, non-degenerate) sector immediately, then
// replace it with the daemon's actual sector once the one-shot fetch lands —
// mirrors the pattern above: synchronous placeholder render first, real data
// as soon as it's available.
renderSector(sectorLocal);
void initSector();

connectStream();
