"use strict";

// ---------------------------------------------------------------------------
// TB3 Ops Dashboard — vanilla cockpit SPA.
// No framework, no build step: this file is loaded directly via
// <script type="module" src>. It bootstraps auth, subscribes to the SSE
// stream, instantiates the cockpit + camera + hold-loop classes, and
// dispatches each tick's DashboardState snapshot to them. The always-visible
// cockpit render path (telemetry, tracking status, services, the
// calibration badge, the aircraft list, and the AIM block) lives in
// cockpit.js, not here — see its own module doc. Module scope is safe here
// because this file is self-contained (addEventListener-based, no inline
// HTML handlers, and no other script on the page reaches into its globals).
// ---------------------------------------------------------------------------

import { azRangeToXY, nearestDot } from "./minimap.js";
import { RigView } from "./rigview.js";
import { WhepSession } from "./whep.js";
import { CameraPanel } from "./camera-panel.js";
import { Cockpit } from "./cockpit.js";
import { Drawer } from "./drawer.js";
import { aimMode } from "./ui-mode.js";
import { renderCaptureLabel } from "./capture-label.js";
import { JogHold } from "./jog-hold.js";
import { NudgeHold } from "./nudge-hold.js";
import { JOG_MIN_DPS_DEFAULT, JOG_RAMP_SECONDS_DEFAULT } from "./jog-ramp.js";
import { renderCalibration, stepHandler, sightingStripHtml, formatTrackedAircraft, formatTrimOffset } from "./procedures.js";
import { JoystickHold, SIGHT_BUTTON_INDEX, FINE_BUTTON_INDEX, ESTOP_BUTTON_INDICES } from "./joystick-hold.js";
import { DEADZONE_DEFAULT } from "./joystick-math.js";

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
  drawerOpen: document.getElementById("drawer-open"),
  drawer: document.getElementById("drawer"),
  drawerBody: document.getElementById("drawer-body"),
  procStrip: document.getElementById("proc-strip"),
  reconnectBanner: document.getElementById("reconnect-banner"),
  sunBanner: document.getElementById("sun-banner"),
  estopBanner: document.getElementById("estop-banner"),
  estopBannerDetail: document.getElementById("estop-banner-detail"),
  estopClear: document.getElementById("estop-clear"),

  // Header at-a-glance strip: the calibration badge (UNCALIBRATED/
  // PROVISIONAL/CALIBRATED, see ui-mode.js's calibrationBadge) and a
  // rig/sun-guard/services health glance. Both rendered by cockpit.js.
  calBadge: document.getElementById("cal-badge"),
  health: document.getElementById("health"),

  cameraVideo: document.getElementById("camera-video"),
  cameraImg: document.getElementById("camera-img"),
  cameraFrame: document.getElementById("camera-frame"),
  videoStats: document.getElementById("video-stats"),
  cameraToggle: document.getElementById("camera-toggle"),
  sunguardToggle: document.getElementById("sunguard-toggle"),
  jog: document.getElementById("jog"),
  jogMode: document.getElementById("jog-mode"),
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
  trkOffset: document.getElementById("trk-offset"),

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

  errors: document.getElementById("errors"),
  toastContainer: document.getElementById("toast-container"),

  joystickToggle: document.getElementById("joystick-toggle"),
  joystickPanel: document.getElementById("joystick-panel"),
  joystickClose: document.getElementById("joystick-close"),
  joystickConn: document.getElementById("joystick-conn"),
  joystickMode: document.getElementById("joystick-mode"),
  joystickFine: document.getElementById("joystick-fine"),
  joystickDeadzone: document.getElementById("joystick-deadzone"),
  joystickDeadzoneValue: document.getElementById("joystick-deadzone-value"),
  joystickAxes: document.getElementById("joystick-axes"),
  joystickButtons: document.getElementById("joystick-buttons"),
  joystickMapSight: document.getElementById("joystick-map-sight"),
  joystickMapFine: document.getElementById("joystick-map-fine"),
  joystickMapEstop: document.getElementById("joystick-map-estop"),
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

// The Setup drawer: off-canvas panel for multi-step procedures (calibration,
// travel limits, home, track sector, joystick), plus the strip fallback a
// procedure collapses to when it needs the operator's eyes back on the
// video. See drawer.js's module doc for the closed/open/strip state machine
// and why #drawer's z-index must stay below #topbar's (cockpit.css).
const drawer = el.drawer && el.drawerBody && el.procStrip
  ? new Drawer({ drawer: el.drawer, body: el.drawerBody, strip: el.procStrip })
  : null;

// Setup toggles the drawer open/closed; if a procedure is mid-aim (strip
// mode) it expands back to the drawer instead of closing outright, since a
// strip on screen means a guided procedure is still in progress and the
// operator most likely wants to see it again, not lose their place in it.
if (drawer && el.drawerOpen) {
  el.drawerOpen.addEventListener("click", () => {
    const mode = drawer.mode();
    if (mode === "closed") drawer.open("calibration");
    else if (mode === "strip") drawer.expand();
    else drawer.close();
  });
}

// Motion-capable controls gated by E-STOP/sun-lock that are NOT already
// covered by cockpit.js's own AIM-block gating (the jog buttons are Cockpit's
// responsibility now — see cockpit.js's _renderAim). Auto (autonomous mode)
// is the one remaining control here.
const motionControls = [el.autoToggle];

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
// The Cockpit instance -- constructed further down (needs jogHold/nudgeHold
// first), but referenced by latchEstop()/clearEstopLatch() above that point
// in the file via this forward declaration. Safe: those closures are only
// ever CALLED after a user click, by which time module evaluation (and this
// assignment) has long since completed.
let cockpit;
// Most recent SSE tick, retained ONLY so a client-side latch change that
// happens BETWEEN ticks (an E-STOP click) can force an immediate cockpit
// re-render instead of waiting up to ~1s for the next tick -- E-STOP
// feedback on the AIM block must be instant, not eventually-consistent. Not
// a second copy of tracking/mode state: the render() path below always
// re-derives everything from a fresh SSE tick; this is only ever fed BACK
// into cockpit.render() unchanged, immediately after a local latch flips.
let lastState = null;

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
// every motion-capable control not already owned by cockpit.js. The AIM
// block's own direction buttons are gated by cockpit.js's _renderAim (driven
// by aimMode); the aircraft list's per-row [Track]/[Sight] buttons are ALSO
// now owned by cockpit.js's _renderAdsb (driven by aircraftRowActions, which
// folds in estopLatched AND sunLocked itself, plus calibration/orientation/
// trackable reasons this function has no visibility into) -- re-touching
// them here would blindly overwrite that richer, reasoned disabled state
// with just `estopLatched || sunLocked` on every tick, re-enabling a Track
// button that should stay disabled for "not calibrated yet" the moment
// neither latch happens to be set. So, unlike every other control below,
// the aircraft list is deliberately NOT touched here.
function applyMotionGate() {
  const disabled = estopLatched || sunLocked;
  for (const btn of motionControls) {
    if (!btn) continue;
    btn.disabled = disabled;
  }
  el.stopTracking.disabled = estopLatched; // stopping is always safe unless E-STOPped mid-latch

  // Sector writes command no motion, so they're blocked only by E-STOP, not
  // the sun lock (set_track_sector has no sun-guard check of its own,
  // unlike the calibration tools -- see calibrationGateOk's own comment
  // below for why THOSE gate on sunLocked instead). The checkbox is a real
  // form control (.disabled works natively); the drag handles are plain SVG
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

// Forces an immediate cockpit re-render using the most recent tick's data
// plus the just-changed local latch. E-STOP must disable the AIM block's
// direction buttons (and show the reason) the instant it's clicked, not on
// the next (~1s away) SSE tick — applyMotionGate() already gets this same
// "don't wait for the next tick" treatment for its own controls, called
// directly from latchEstop()/clearEstopLatch() below. A no-op before the
// first tick lands: the very first render() call (bottom of this file)
// seeds lastState immediately, so in practice this is never actually null
// by the time a user can click anything.
function refreshCockpitLock() {
  if (lastState) cockpit.render({ ...lastState, estopLatched, sunLocked });
}

// -- E-STOP -------------------------------------------------------------------

function latchEstop() {
  estopLatched = true;
  // Visibility is driven by the "show" class, not the [hidden] attribute:
  // an author-stylesheet `display` rule always beats the UA [hidden]{display:none}
  // rule, so relying on `hidden` here would leave the banner stuck.
  el.estopBanner.classList.add("show");
  applyMotionGate();
  refreshCockpitLock();
}

function clearEstopLatch() {
  estopLatched = false;
  el.estopBanner.classList.remove("show");
  el.estopBannerDetail.textContent = "";
  applyMotionGate();
  refreshCockpitLock();
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
  lastState = state;

  // renderSunGuard must run before cockpit.render(): it's what sets
  // sunLocked/sunReason, which the AIM block's locked-reason text needs
  // folded into the state object handed to aimMode/cockpit.
  renderSunGuard(state.sunGuard);

  // The cockpit's always-visible render path (telemetry, tracking status,
  // services, the calibration badge, the health glance, the aircraft list,
  // and the AIM block) — see cockpit.js. estopLatched/sunLocked are folded
  // into the object passed here (not part of the raw SSE payload) because
  // aimMode(state) — the single source of truth for the AIM block's mode —
  // expects them on its `state` argument; see ui-mode.js.
  cockpit.render({ ...state, estopLatched, sunLocked });

  renderMiniMap(state);
  if (rigView) rigView.update(state.rig, state.limits);
  renderCamera(state.camera);
  renderCapture(state.capture);
  renderErrors(state.errors);
  applyJogConfig(state.jog);
  refreshCalibrationDrawer(state);

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

// -- guided calibration procedure (Setup drawer) -------------------------
//
// procedures.js renders step-gate.js's ordered steps and hands a clicked
// step's id back to stepHandler, which dispatches into calibrationActions
// below -- this section is the only place that actually talks to the
// daemon (postControl) or the browser (window.prompt) on the procedure's
// behalf, so procedures.js itself stays presentation-only and DOM-free (see
// its own module doc). See procedures.js for the steps-1-3-vs-4-5
// open-drawer/strip split this is built around.

// Every calibration write below except sighting (set-location/
// characterize-imu/set-north-zero/solve) checks the sun guard server-side
// (geo-tools.ts/imu-tools.ts) and refuses under a lock -- checked here too
// so the operator gets an immediate reason instead of waiting on a round
// trip that was always going to fail. `commandsMotion` is true only for
// characterize_imu's sweep ("Motion tool — respects limits, sun guard,
// deadman", imu-tools.ts) -- every other write covered by this function is a
// stored coordinate or a stationary reading, harmless under E-STOP on the
// ACTUATION axis, and gated on the sun lock alone. sight_aircraft is
// deliberately NOT covered here -- see sightGateOk below for why it needs a
// stricter, separate gate (review fix, UI-8 fix round, finding I-3).
function calibrationGateOk(commandsMotion) {
  if (commandsMotion && estopLatched) {
    toast("E-STOP latched — cannot run the IMU sweep", false);
    return false;
  }
  if (sunLocked) {
    toast("sun guard locked — calibration writes are refused while parked", false);
    return false;
  }
  return true;
}

// sight_aircraft/sight_landmark command no motion either (same actuation-
// axis argument as calibrationGateOk's non-motion writes), but sighting has
// a DATA-VALIDITY axis calibrationGateOk's other writes don't: it records
// an aircraft's (or landmark's) position against whatever pan/tilt the rig
// happens to be holding RIGHT NOW. E-STOP halts a tracking slew wherever it
// lands, so the instant it latches the rig is -- by definition -- no longer
// centred on the target; sighting at that moment would pair the target's
// position with a pan/tilt the rig isn't actually holding on it, writing a
// wrong pair into the calibration profile. So, unlike calibrationGateOk's
// other writes, this refuses under E-STOP too, unioned with the same
// sun-lock check every other calibration write already has (matches the
// corrected convention cockpit.js's aircraftRowActions.canSight settled on
// for the per-row Sight button, and the joystick's isSightGated below).
function sightGateOk() {
  if (estopLatched) {
    toast("E-STOP latched — sighting refused (the rig may no longer be centred on the target)", false);
    return false;
  }
  if (sunLocked) {
    toast("sun guard locked — calibration writes are refused while parked", false);
    return false;
  }
  return true;
}

// Rig location has no persistent input form in the guided procedure (the
// old #cal-lat/#cal-lon/#cal-height inputs belonged to the standalone
// #calibration section this task removes) -- a single combined prompt.
// IMPORTANT: set_rig_location REPLACES THE WHOLE CALIBRATION PROFILE
// (src/calibration.ts's setRigLocation: `{ version: 1, rig, sightings: [] }`)
// -- it is not an in-place coordinate edit. Re-running it after
// characterize_imu has already solved a mounting throws away that IMU
// sweep (a physical rig sweep the operator would have to redo), the
// orientation, and every sighting, not just the coordinate. The prompt
// names this consequence once there's something real to lose, and
// procedures.js renders step 1's already-done link as [reset] rather than
// [redo] for the same reason, so it doesn't look like the other four,
// in-place, non-destructive redo links (review fix, UI-8 fix round,
// finding I-4).
function editRigLocation() {
  if (!calibrationGateOk(false)) return;
  const cal = (lastState && lastState.calibration) || {};
  const rig = cal.rig;
  const hasImu = !!cal.imuMounting;
  const current = rig ? `${rig.lat}, ${rig.lon}, ${rig.height}` : "";
  const warning = hasImu
    ? "WARNING: this RESETS the whole calibration profile -- the IMU sweep, " +
      "orientation, and every sighting are all discarded, not just the coordinate.\n\n"
    : "";
  const raw = window.prompt(`${warning}Rig location — lat, lon, height_m:`, current);
  if (raw === null) return; // cancelled
  const parts = raw.split(",").map((p) => parseFloat(p.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    toast("rig location needs lat, lon, height_m as three numbers", false);
    return;
  }
  const [lat, lon, height] = parts;
  postControl("calibrate/set-location", { lat, lon, height_m: height });
}

// Records a sighting for whatever aircraft is CURRENTLY tracked
// (state.tracking.hex) -- the guided procedure's whole flow is track a
// plane -> trim to centre -> sight, so there is no separate aircraft picker
// here, unlike the old standalone panel's dropdown (see this task's report
// for why that dropdown was retired rather than carried over). Shared by
// the sighting strip's [Sight it] button below AND the physical joystick's
// Sight button (see the JoystickHold wiring further down) -- one
// implementation, not two parallel ones for the same action.
async function sightTrackedAircraft() {
  const hex = lastState && lastState.tracking && lastState.tracking.hex;
  if (!hex) { toast("no aircraft currently tracked — track one first", false); return null; }
  if (!sightGateOk()) return null;
  return postControl("calibrate/sight-aircraft", { hex });
}

// The landmark path (sight_landmark) remains available as an alternative to
// sighting a tracked aircraft on sight-1/sight-2 (docs/superpowers/specs/
// 2026-07-28-dashboard-redesign-design.md) -- e.g. a site with a usable
// visual landmark, or simply no aircraft in range right now. It commands no
// motion (aim via jog, then record the CURRENT pointing against a known
// lat/lon/height), so it shares sightTrackedAircraft's stricter gate, not
// calibrationGateOk's. `stepId` picks the sighting slot's label (A for
// sight-1, B for sight-2), matching the old standalone panel's Sight A/
// Sight B convention (review fix, UI-8 fix round, finding I-5).
async function sightLandmarkForStep(stepId) {
  if (!sightGateOk()) return null;
  const raw = window.prompt(
    "Landmark sighting — lat, lon, height_m (aim the rig at the landmark first, then confirm):", "",
  );
  if (raw === null) return null; // cancelled
  const parts = raw.split(",").map((p) => parseFloat(p.trim()));
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    toast("landmark sighting needs lat, lon, height_m as three numbers", false);
    return null;
  }
  const [lat, lon, height] = parts;
  const label = stepId === "sight-2" ? "B" : "A";
  return postControl("calibrate/sight", { lat, lon, height_m: height, label });
}

// A sighting step (sight-1/sight-2) hands off to the drawer's strip -- a
// plane crosses a zoomed field of view in ~2s by hand, but once the rig is
// TRACKING it slews with the plane and goes nearly stationary in frame,
// giving the operator the whole pass to trim (see drawer.js's module doc).
// [Sight it] re-expands the drawer on success so the step reads done;
// [cancel] does the same without sighting anything.
let sightingInFlight = false;
function startSighting(stepId, drawerRef) {
  sightingInFlight = false;
  drawerRef.collapseToStrip(sightingStripHtml(stepId, lastState), {
    "strip-sight": async () => {
      if (sightingInFlight) return; // one in-flight sight at a time
      sightingInFlight = true;
      try {
        const data = await sightTrackedAircraft();
        if (data && data.ok) drawerRef.expand();
      } finally {
        sightingInFlight = false;
      }
    },
    "strip-cancel": () => drawerRef.expand(),
  });
}

const calibrationActions = {
  editRigLocation,
  runImu: () => { if (calibrationGateOk(true)) postControl("calibrate/characterize-imu", {}); },
  setNorthZero: () => { if (calibrationGateOk(false)) postControl("calibrate/set-north-zero", {}); },
  solve: () => { if (calibrationGateOk(false)) postControl("calibrate/solve", {}); },
  startSighting,
  sightLandmark: sightLandmarkForStep,
};

if (drawer) {
  // Registered once; called fresh on every render (drawer.js's own doc on
  // setEntryRenderer) so the step list always reflects the latest tick's
  // state, never whatever it was when the drawer was first opened.
  drawer.setEntryRenderer("calibration", () => renderCalibration(lastState, calibrationActions));
}

// Delegated (not per-button) click handling for the calibration body's
// [run]/[redo]/[reset]/[start]/[use a landmark instead] buttons: drawer.js
// only rewrites #drawer-body's innerHTML when its content actually changes,
// but a rewrite can still happen at any time (a nav click, a real state
// change on a tick) and would silently drop a listener attached directly to
// one of those buttons -- a single listener on the stable #drawer-body
// container survives every rewrite instead. The "landmark:" verb is
// special-cased here (not inside stepHandler, whose id-only dispatch
// contract is unchanged for run/redo/reset -- see procedures.js) because it
// needs a DIFFERENT action per step id than startSighting does.
if (el.drawerBody) {
  el.drawerBody.addEventListener("click", (evt) => {
    const btn = evt.target.closest("[data-act]");
    if (!btn || !drawer) return;
    const [verb, id] = btn.dataset.act.split(":");
    if (verb === "landmark") { calibrationActions.sightLandmark(id); return; }
    stepHandler(id, drawer, lastState, calibrationActions);
  });
}

// Refreshes the calibration drawer body (if open) or the sighting strip's
// live readouts (if collapsed), once per SSE tick -- see drawer.js's
// refresh()/updateStrip() doc comments for why a periodic push is needed at
// all (setEntryRenderer's renderer is otherwise only re-invoked by an
// explicit open()/expand()/nav click, none of which a tick landing
// mid-procedure triggers on its own).
function refreshCalibrationDrawer(state) {
  if (!drawer) return;
  const mode = drawer.mode();
  if (mode === "open") drawer.refresh();
  else if (mode === "strip") {
    drawer.updateStrip({ aircraft: formatTrackedAircraft(state), offset: formatTrimOffset(state) });
  }
}

// -- control wiring -------------------------------------------------------

el.estop.addEventListener("click", doEstop);
el.estopClear.addEventListener("click", clearEstopLatch);

// -- press-and-hold jog (ramped, dead-man via JogHold) -----------------------
//
// jog-hold.js/nudge-hold.js own the posting cadence/ramp/failure-handling;
// cockpit.js owns which one is live for the current mode, the per-button DOM
// wiring (pointerdown/up/leave/cancel), and the AIM block's label — see its
// own module doc, which is also where the old "micro micro-ish and race
// car" 3-speed-preset control this replaced is explained. What's left here
// is the remaining app.js-level plumbing: the shared config constants, the
// postControl adapters both hold classes post through, and the keyboard/
// blur/visibility delegation, which has nowhere more specific to live
// (arrow keys and window-level events aren't owned by any one DOM element
// the way the jog buttons themselves are).
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

// Same adapter shape as postJogVector, for the OTHER hold class (NudgeHold):
// while tracking, the direction buttons shift the tracking setpoint's
// aim-offset instead of commanding a raw rate. See nudge-hold.js's module doc.
async function postNudgeVector(deltaPanDeg, deltaTiltDeg) {
  const data = await postControl("nudge-aim-offset", { delta_pan_deg: deltaPanDeg, delta_tilt_deg: deltaTiltDeg });
  return !!(data && data.ok === true);
}

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
  // The loop already halted itself (no further posts); this just tells the
  // cockpit to release the "one hold at a time" slot and the pressed-visual,
  // so a failed POST or a mid-hold gate trip doesn't leave the UI looking
  // like it's still held down. No further postControl call here — the
  // cockpit's stop() calls would be no-ops anyway (the loop is already
  // inactive), and there is no reason a bare stop vector would land when the
  // post that just failed didn't.
  onFailure: () => { cockpit.stopHoldUnconditionally(); },
});

// The trim/nudge counterpart to jogHold, started instead of jogHold whenever
// the AIM block's mode is "trim" (see cockpit.js's _activeHold(), driven by
// aimMode). Shares the same E-STOP/sun-lock gate and hold-slot release on
// failure.
const nudgeHold = new NudgeHold({
  post: postNudgeVector,
  isGated: () => estopLatched || sunLocked,
  onFailure: () => { cockpit.stopHoldUnconditionally(); },
});

// The cockpit owns the AIM block's mode switch (jog/trim/locked), the four
// direction buttons' press-and-hold wiring, and the rest of the always-
// visible telemetry render path — see cockpit.js's own module doc. `el` is
// reused as-is: it already carries every element Cockpit needs (mode, svc,
// calBadge, health, rig*/trk*/adsb*, jog/jogMode/jogUp/.../jogRight), the
// same pattern CameraPanel above already uses (DOM elements + adapters
// injected, never reached for via globals).
cockpit = new Cockpit({ el, jogHold, nudgeHold, post: postControl });

// Loss-of-control triggers: a press can end without telling the control that
// started it (window blur, tab hidden) — a held-down jog/nudge that keeps
// running because the operator alt-tabbed away is a genuine hazard on a
// roof-mounted rig.
window.addEventListener("blur", () => cockpit.stopHoldUnconditionally());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cockpit.stopHoldUnconditionally();
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
  cockpit.startHold(sourceId);
});

document.addEventListener("keyup", (evt) => {
  const sourceId = JOG_KEY_TO_SOURCE[evt.key];
  if (!sourceId) return;
  cockpit.stopHold(sourceId);
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

// Same trim/jog decision the AIM block itself makes (aimMode, ui-mode.js) --
// not a second, locally-tracked "is tracking active" flag. Used only to pick
// which of the joystick's two post targets (jog vs nudge) applies, and for
// the joystick panel's own mode label below; the joystick's actual E-STOP/
// sun-lock gating is isGated, checked independently. lastState is seeded by
// the very first render() call (bottom of this file) before the joystick
// can possibly be polled.
function isTrimActive() {
  return aimMode({ tracking: lastState && lastState.tracking }) === "trim";
}

// -- USB joystick / gamepad control -------------------------------------------
//
// The operator calibrates by watching a plane in the video feed and
// trimming until it centres -- eyes on the plane, not this dashboard. A
// proportional stick lets them trim by thumb feel instead of reaching for
// the on-screen jog buttons. See joystick-hold.js's module doc for the full
// design/safety rationale; this section is only the DOM wiring, matching
// the split jog-hold.js/nudge-hold.js already use for the button cluster.
//
// Reuses the EXACT SAME post paths the buttons use (postJogVector /
// postNudgeVector) and the exact same gates (estopLatched||sunLocked for
// motion, calibrationGateOk's sun-lock-only check for the sighting write) --
// the joystick is another caller of existing, already-gated control paths,
// never a new one.
if (el.joystickPanel) {
  // Populated from joystick-hold.js's own exported index constants, not
  // hand-typed -- see index.html's comment on this exact spot for why.
  if (el.joystickMapSight) el.joystickMapSight.textContent = `button ${SIGHT_BUTTON_INDEX} ("A")`;
  if (el.joystickMapFine) el.joystickMapFine.textContent = `button ${FINE_BUTTON_INDEX} ("RT", hold to halve rate)`;
  if (el.joystickMapEstop) {
    el.joystickMapEstop.textContent = `buttons ${ESTOP_BUTTON_INDICES.join(" + ")} ("Back" + "Start") together`;
  }

  const joystickHold = new JoystickHold({
    getGamepads: () => (typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : []),
    postJog: postJogVector,
    postNudge: postNudgeVector,
    onSight: sightTrackedAircraft,
    onEstop: doEstop,
    isTrackingActive: () => isTrimActive(),
    // Same combined gate as JogHold/NudgeHold's isGated -- checked every
    // poll tick, not just once, so an E-STOP/sun-lock landing mid-drive
    // stops the very next tick from posting again.
    isGated: () => estopLatched || sunLocked,
    // Matches sightGateOk's union, not calibrationGateOk's non-motion gate:
    // sight_aircraft commands no motion, but E-STOP still refuses it here --
    // a slew halted mid-track by E-STOP is no longer centred on the target,
    // so a sighting taken right then would write a wrong pan/tilt pair into
    // the calibration profile (see sightGateOk's own comment for the full
    // reasoning). aircraftRowActions' canSight (cockpit.js) is a
    // pre-existing, separate gate on the per-row Sight button that still
    // only checks the sun lock -- out of scope here, not something this
    // joystick path inherited or should copy.
    isSightGated: () => estopLatched || sunLocked,
    // The LIVE config value, reusing the exact number applyJogConfig()
    // already keeps current from the daemon's SSE tick -- NOT a second,
    // hand-copied constant (see joystick-math.js's axisToRate doc for why
    // that specific mistake matters here).
    getMaxJogDps: () => jogHold.maxJogDps,
    // Same hand-synced dead-man constant jogHold above uses (see its own
    // comment on JOG_VECTOR_TTL_MS) -- both the poll cadence and the
    // commanded JOG duration derive from this (see joystick-hold.js's
    // pollIntervalMs/jogDurationMs), so a future change to the constant
    // moves both loops together instead of one silently drifting.
    jogVectorTtlMs: JOG_VECTOR_TTL_MS,
    onSnapshot: renderJoystickSnapshot,
    onFailure: () => {}, // postJogVector/postNudgeVector already toast on failure via postControl
  });

  // Live-display rendering: independent of whether anything was
  // gated/posted this tick -- this is purely "what does the controller
  // actually report", the thing that makes a wrong mapping guess
  // diagnosable instead of mysterious (controller mappings vary).
  function renderJoystickAxes(axes) {
    el.joystickAxes.innerHTML = axes.map((v, i) => {
      const val = typeof v === "number" && Number.isFinite(v) ? v : 0;
      const pct = Math.max(-1, Math.min(1, val)) * 50; // -50%..+50% from centre
      const left = pct >= 0 ? "50%" : `${50 + pct}%`;
      const width = `${Math.abs(pct)}%`;
      return `<div class="joystick-axis-row">
        <span class="joystick-axis-label">axis ${i}</span>
        <span class="joystick-axis-track"><span class="joystick-axis-fill" style="left:${left};width:${width}"></span></span>
        <span class="joystick-axis-value">${val.toFixed(2)}</span>
      </div>`;
    }).join("");
  }

  function renderJoystickButtons(buttons) {
    el.joystickButtons.innerHTML = buttons.map((b, i) => {
      const pressed = !!(b && b.pressed);
      return `<div class="joystick-button-chip${pressed ? " pressed" : ""}">${i}</div>`;
    }).join("");
  }

  function renderJoystickSnapshot(snapshot) {
    el.joystickToggle.classList.toggle("toggle-on", !!snapshot.connected);
    el.joystickConn.textContent = snapshot.connected
      ? `connected: ${snapshot.id || "unknown pad"}`
      : "not connected";
    renderJoystickAxes(snapshot.axes || []);
    renderJoystickButtons(snapshot.buttons || []);

    el.joystickMode.textContent = isTrimActive() ? "TRIM (aim offset)" : "JOG";
    const fineHeld = !!(snapshot.buttons && snapshot.buttons[FINE_BUTTON_INDEX] && snapshot.buttons[FINE_BUTTON_INDEX].pressed);
    el.joystickFine.hidden = !fineHeld;
  }

  // Panel is a toggled overlay (see style.css's .joystick-panel), not a
  // permanent cockpit box -- it's a setup/diagnostic aid, not something the
  // operator needs eyes on while actually flying a pass.
  el.joystickToggle.addEventListener("click", () => {
    el.joystickPanel.hidden = !el.joystickPanel.hidden;
  });
  if (el.joystickClose) {
    el.joystickClose.addEventListener("click", () => { el.joystickPanel.hidden = true; });
  }

  // Deadzone is a local feel setting (like the pad itself), not a server
  // config value -- no gating, always editable, mirrors joystickHold.
  // deadzone being a plain mutable property (see its constructor doc).
  if (el.joystickDeadzone) {
    el.joystickDeadzone.value = String(DEADZONE_DEFAULT);
    el.joystickDeadzoneValue.textContent = DEADZONE_DEFAULT.toFixed(2);
    el.joystickDeadzone.addEventListener("input", () => {
      const v = parseFloat(el.joystickDeadzone.value);
      if (Number.isFinite(v)) {
        joystickHold.deadzone = v;
        el.joystickDeadzoneValue.textContent = v.toFixed(2);
      }
    });
  }

  // gamepadconnected needs no special handling beyond letting the next poll
  // pick up the pad (see handleConnected's doc); gamepaddisconnected must
  // stop immediately rather than waiting up to one poll interval.
  window.addEventListener("gamepadconnected", (e) => joystickHold.handleConnected(e));
  window.addEventListener("gamepaddisconnected", (e) => joystickHold.handleDisconnected(e));

  // Loss-of-control triggers shared with the button-hold loops: a stick
  // that keeps a stale non-zero rate after the tab is hidden/backgrounded is
  // a runaway exactly like a held button would be -- see
  // cockpit.stopHoldUnconditionally above, extended here rather than duplicated.
  window.addEventListener("blur", () => joystickHold.haltDrive());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) joystickHold.haltDrive();
  });

  joystickHold.start();
}

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
  // Same combined gate the sidebar's .track-btn now applies via
  // cockpit.js's aircraftRowActions (which folds in estopLatched AND
  // sunLocked, not applyMotionGate -- that function no longer touches the
  // aircraft list at all, see its own comment): the sidebar's Track button
  // for the same plane is greyed inert under a sun lock too, so the radar
  // dot must not fire a track command the cockpit's other controls all
  // refuse.
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
