"use strict";

// ---------------------------------------------------------------------------
// TB3 Ops Dashboard — vanilla cockpit SPA. No framework, no build step: this
// file is loaded via <script type="module" src>. It bootstraps auth,
// subscribes to the SSE stream, constructs every other module with the DOM
// elements/adapters it needs, and dispatches each tick's DashboardState
// snapshot to them.
//
// The always-visible cockpit render path lives in cockpit.js; the Setup
// drawer shell in drawer.js; the guided calibration/travel-limits/set-home
// procedures' daemon/browser glue in procedure-actions.js (pure rendering
// stays in procedures.js); the Track Sector compass and joystick diagnostic
// panel -- both relocated into the Setup drawer by this redesign's final
// task -- in sector.js/joystick-panel.js; the PPI radar canvas in radar.js.
// This file is left as bootstrap + wiring only, plus the handful of controls
// (E-STOP, stick/keyboard wiring, camera/auto/sun-guard/capture toggles,
// the bottom-bar height sync) that don't belong to any one of those. Module scope is
// safe here: addEventListener-based, no inline HTML handlers, no other
// script reaches into these globals.
// ---------------------------------------------------------------------------

import { WhepSession } from "./whep.js";
import { CameraPanel } from "./camera-panel.js";
import { Cockpit } from "./cockpit.js";
import { Drawer } from "./drawer.js";
import { aimMode } from "./ui-mode.js";
import { renderCaptureLabel } from "./capture-label.js";
import { StickHold, DEFAULT_TRIM_SENSITIVITY } from "./stick-hold.js";
import { createVirtualStick } from "./virtual-stick.js";
import { initProcedureActions } from "./procedure-actions.js";
import { createEstop } from "./estop.js";
import * as sector from "./sector.js";
import { renderJoystickEntry, mountJoystickEntry, initJoystickPanel } from "./joystick-panel.js";
import { renderMiniMap, wireRadarEvents } from "./radar.js";
import { humanizeToolMessage } from "./tool-message.js";

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
  jogMode: document.getElementById("jog-mode"),
  stickMount: document.getElementById("stick-mount"),
  bottomDrawer: document.getElementById("bottom-drawer"),
  bdNav: document.getElementById("bd-nav"),
  bdClose: document.getElementById("bd-close"),
  bottomBar: document.getElementById("bottom-bar"),
  autoToggle: document.getElementById("auto-toggle"),
  stopTracking: document.getElementById("stop-tracking"),
  captureStatus: document.getElementById("capture-status"),
  captureSnap: document.getElementById("capture-snap"),
  captureRecord: document.getElementById("capture-record"),
  captureAuto: document.getElementById("capture-auto"),
  // Cockpit-level chip (see design doc's "[joystick ●]" sketch): stays
  // always-present in #camera-controls, but now OPENS the Setup drawer's
  // Joystick entry instead of toggling a floating overlay -- see this
  // file's wiring below.
  joystickToggle: document.getElementById("joystick-toggle"),

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
  visionStatus: document.getElementById("vision-status"),

  adsbList: document.getElementById("adsb-list"),
  trackRange: document.getElementById("track-range"),
  trackRangeLabel: document.getElementById("track-range-label"),
  nudgeSens: document.getElementById("nudge-sens"),
  trimPan: document.getElementById("trim-pan"),
  trimTilt: document.getElementById("trim-tilt"),
  trimAdopt: document.getElementById("trim-adopt"),
  trimClear: document.getElementById("trim-clear"),
  trimBlock: document.getElementById("trim-block"),

  minimap: document.getElementById("minimap"),
  minimapTooltip: document.getElementById("minimap-tooltip"),


  errors: document.getElementById("errors"),
  toastContainer: document.getElementById("toast-container"),
};

// Live 3D rig view. Never throws -- catches WebGL failures, shows a text fallback.

// The camera tile's dual-pipeline (WebRTC/MJPEG) state machine -- see
// camera-panel.js. DOM elements + the WHEP session factory are injected here;
// the panel itself never touches globals, which is what makes it testable.
const cameraPanel = new CameraPanel({
  video: el.cameraVideo,
  img: el.cameraImg,
  frame: el.cameraFrame,
  statsEl: el.videoStats,
  makeWhepSession: () => new WhepSession(),
});

// The Setup drawer: off-canvas panel for multi-step procedures, plus the
// strip fallback a procedure collapses to when it needs the operator's eyes
// back on the video. See drawer.js's module doc.
const drawer = el.drawer && el.drawerBody && el.procStrip
  ? new Drawer({ drawer: el.drawer, body: el.drawerBody, strip: el.procStrip })
  : null;

if (drawer) {
  // Track Sector and Joystick are relocated, not redesigned -- both
  // renderers return a CONSTANT html string (see sector.js's/joystick-
  // panel.js's own docs), with live values painted by direct DOM mutation.
  drawer.setEntryRenderer("track-sector", sector.renderSectorEntry);
  drawer.setEntryRenderer("joystick", renderJoystickEntry);
}

// Tools toggles the bottom drawer's Setup tab; if a procedure is mid-aim
// (strip mode) it expands back to the full drawer instead of closing
// outright, since a strip on screen means a guided procedure is still in
// progress and the operator most likely wants to see it again, not lose
// their place in it. A second click on an already-open Setup tab closes the
// drawer outright.
if (drawer && el.drawerOpen) {
  el.drawerOpen.addEventListener("click", () => {
    const mode = drawer.mode();
    if (mode === "strip") { drawer.expand(); return; }
    if (!bdOpen) {
      if (mode === "closed") drawer.open("calibration");
      openBottomDrawer("setup");
    } else {
      drawer.close();
      closeBottomDrawer();
    }
  });
}

// Track Sector/Joystick need one thing no other drawer entry does: an
// IMMEDIATE paint with live values the moment the operator navigates in
// (their renderers are deliberately constant, so live values are never
// baked into the html string -- painting them is this listener's job).
// Delegated on the STABLE #drawer-body node (drawer.js only ever rewrites
// its children), so this needs no re-wiring across navigate-away-and-back.
if (el.drawerBody) {
  el.drawerBody.addEventListener("click", (evt) => {
    const entryBtn = evt.target.closest("[data-entry]");
    if (!entryBtn) return;
    if (entryBtn.dataset.entry === "track-sector") {
      sector.paintSector(el.drawerBody, sector.sectorLocal, estop.isLatched());
    } else if (entryBtn.dataset.entry === "joystick") {
      mountJoystickEntry(el.drawerBody, joystickHold);
    }
  });
}

// Motion-capable controls gated by E-STOP/sun-lock that are NOT already
// covered by cockpit.js's own AIM gating (the stick is Cockpit's
// responsibility now -- see its stickMove/_renderAim) or the widget disable
// inside applyMotionGate below. Auto (autonomous mode) is the one remaining
// control here.
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

let sunLocked = false;
let sunReason = "";
let agentOnFromState = false;
let cameraEnabledFromState = false;
let sunGuardEnabledFromState = false;
let captureRecordingFromState = false;
let captureAutoEnabledFromState = false;
// The Cockpit instance -- constructed further down (needs stickHold
// first), but referenced by estop.js's latch()/clear() (via
// refreshCockpitLock) before that point in the file via this forward
// declaration. Safe: those closures are only ever CALLED after a user
// click, by which time module evaluation (and this assignment) has long
// since completed.
let cockpit;
// Most recent SSE tick, retained ONLY so a client-side latch change that
// happens BETWEEN ticks (an E-STOP click) can force an immediate cockpit
// re-render instead of waiting up to ~1s for the next tick -- E-STOP
// feedback on the AIM block must be instant, not eventually-consistent. Not
// a second copy of tracking/mode state: the render() path below always
// re-derives everything from a fresh SSE tick; this is only ever fed BACK
// into cockpit.render() unchanged, immediately after a local latch flips.
let lastState = null;

// -- formatting helpers ---------------------------------------------------

function fmt(v, digits) {
  if (v === null || v === undefined) return "—"; // em dash for unavailable
  if (typeof v === "number") {
    return Number.isFinite(v) ? v.toFixed(digits === undefined ? 1 : digits) : "—";
  }
  return String(v);
}

// Same trim/jog decision the AIM block itself makes (aimMode, ui-mode.js) --
// not a second, locally-tracked flag. Used by procedure-actions.js and
// joystick-panel.js. A hoisted `function` declaration so it's safe to
// reference below regardless of textual order.
function isTrimActive() {
  return aimMode({ tracking: lastState && lastState.tracking }) === "trim";
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
      toast(humanizeToolMessage(data.message) ?? (data.ok ? "ok" : "failed"), data.ok);
    }
    return data;
  } catch (e) {
    toast(`${path}: ${e instanceof Error ? e.message : String(e)}`, false);
    return null;
  }
}

// -- motion-control gating ---------------------------------------------------

// Re-applies the combined disabled state (E-STOP latch OR sun-guard lock) to
// every motion-capable control not already owned by cockpit.js. The virtual
// stick and the aircraft list's per-row [Track]/[Sight] buttons are owned by
// cockpit.js's own richer, reasoned gating -- deliberately NOT re-touched
// there; this file only dims the widget itself.
function applyMotionGate() {
  const disabled = estop.isLatched() || sunLocked;
  for (const btn of motionControls) {
    if (!btn) continue;
    btn.disabled = disabled;
  }
  el.stopTracking.disabled = estop.isLatched(); // stopping is always safe unless E-STOPped mid-latch

  // The stick dims and force-releases a live drag under the same combined
  // gate (virtual-stick.js). Cockpit._renderAim independently halts the hold
  // and relabels -- two halves of one invariant, either sufficient alone.
  if (typeof virtualStick !== "undefined" && virtualStick) virtualStick.setDisabled(disabled);

  // Sector writes command no motion, so they're gated by E-STOP only, not
  // the sun lock. paintSector no-ops if Track Sector isn't currently
  // mounted; calling it unconditionally every tick keeps its disabled-
  // under-E-STOP visuals in sync the instant the latch changes.
  sector.paintSector(el.drawerBody, sector.sectorLocal, estop.isLatched());

  if (sunLocked) {
    el.sunBanner.hidden = false;
    el.sunBanner.textContent = `Sun-avoidance guard locked — motion disabled${sunReason ? ": " + sunReason : ""}`;
  } else {
    el.sunBanner.hidden = true;
  }
}

// Forces an immediate cockpit re-render using the most recent tick's data
// plus the just-changed local latch. E-STOP must relabel the stick LOCKED
// (and halt any live push) the instant it's clicked, not on the next (~1s
// away) SSE tick. A no-op before the first tick lands, which
// in practice never happens by the time a user can click anything (the
// very first render() call, bottom of this file, seeds lastState immediately).
function refreshCockpitLock() {
  if (lastState) cockpit.render({ ...lastState, estopLatched: estop.isLatched(), sunLocked });
}

// -- E-STOP -------------------------------------------------------------------
//
// The latch/clear/trigger logic itself lives in estop.js now -- split out
// (fix round 1, task 10 review) as the single most safety-critical unit in
// this file, so it has its own unit-testable home (test/estop.test.ts) and
// its own module boundary for scripts/dashboard-smoke.mjs to exercise.
const estop = createEstop({ el, toast, applyMotionGate, refreshCockpitLock });
el.estop.addEventListener("click", () => estop.trigger());
el.estopClear.addEventListener("click", () => estop.clear());

// -- render -------------------------------------------------------------------

function render(state) {
  if (!state || typeof state !== "object") return;
  lastState = state;

  // renderSunGuard must run before cockpit.render(): it's what sets
  // sunLocked/sunReason, which the AIM block's locked-reason text needs
  // folded into the state object handed to aimMode/cockpit.
  renderSunGuard(state.sunGuard);

  // The cockpit's always-visible render path -- see cockpit.js.
  // estopLatched/sunLocked are folded into the object passed here (not part
  // of the raw SSE payload) because aimMode(state) -- the single source of
  // truth for the AIM block's mode -- expects them on its `state` argument.
  cockpit.render({ ...state, estopLatched: estop.isLatched(), sunLocked });

  renderMiniMap(el, state);
  renderCamera(state.camera);
  renderCapture(state.capture);
  renderErrors(state.errors);
  applyJogConfig(state.jog);
  procedureActions.refreshSetupDrawer(state);

  applyMotionGate();
}

// capture is null both pre-first-poll and when the daemon leg is down
// (mergeState collapses both to null) -- renderCaptureLabel treats that the
// same as "no report yet" and shows a dash, never a false "ready".
// captureRecordingFromState drives the [Record] toggle's on/off label the
// same state-driven way cameraToggle/sunguardToggle already work: POST the
// intent, let the next tick flip the button.
//
// The chip needs no caveat text here: renderCaptureLabel now checks
// `recording` ahead of `autoEnabled` (capture-label.js), so a manual
// start_recording on a host with captureAutoEnabled:false reads
// "Capture: REC" rather than the "Capture: OFF" that used to sit beside an
// ON button. lastError/lastSkipReason still outrank REC there, so a failed
// or disarmed pass is never dressed up as healthy.
function renderCapture(capture) {
  const cap = renderCaptureLabel(capture ?? null);
  el.captureStatus.textContent = cap.text;
  el.captureStatus.className = "stat " + cap.cls;

  captureRecordingFromState = !!(capture && capture.recording);
  if (el.captureRecord) {
    el.captureRecord.textContent = "Record: " + (captureRecordingFromState ? "ON" : "OFF");
    el.captureRecord.classList.toggle("toggle-on", captureRecordingFromState);
  }

  // Auto capture (set_capture_mode, review fix I-3) -- state-driven like
  // Camera/Sun guard/Record above. `capture` null (pre-poll/degraded) reads
  // as a dash, never a false "OFF".
  if (el.captureAuto) {
    if (!capture) {
      el.captureAuto.textContent = "Auto capture: —";
      el.captureAuto.classList.remove("toggle-on");
    } else {
      captureAutoEnabledFromState = capture.autoEnabled === true;
      el.captureAuto.textContent = "Auto capture: " + (captureAutoEnabledFromState ? "ON" : "OFF");
      el.captureAuto.classList.toggle("toggle-on", captureAutoEnabledFromState);
    }
  }
}

// Drives the camera Start/Stop button off the server's authoritative camera
// status (so a second browser, or a reload, reflects the real on/off), and
// hands the camera field to cameraPanel, which picks (and fully switches
// between) the two camera surfaces. This dual-path is the rig's WebRTC
// escape hatch: cameraSource keeps two values on purpose, so if MediaMTX
// misbehaves on the roof, flipping cameraSource to v4l2 in config.json and
// restarting must produce a working picture, not a dead panel --
// CameraPanel (via pickCameraMode) defaults to "mjpeg" (the
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

  // Degraded/not-yet-polled → show "—", never misreport the guard as OFF.
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

// -- guided drawer procedures (calibration / travel limits / set home) ------
//
// The daemon/browser glue (postControl calls, window.prompt/confirm, the
// drawer's entry renderers and delegated data-act dispatch) lives in
// procedure-actions.js -- split out to keep this file under the project's
// 800-line ceiling. procedures.js's pure renderers are never imported here
// directly; procedure-actions.js is the only caller.
const procedureActions = initProcedureActions({
  drawer,
  drawerBody: el.drawerBody,
  postControl,
  toast,
  getLastState: () => lastState,
  isEstopLatched: () => estop.isLatched(),
  isSunLocked: () => sunLocked,
  isTrimActive,
});

// -- the virtual stick's motion loop -----------------------------------------
//
// stick-hold.js owns the posting cadence/gate/failure handling for BOTH
// modes (jog rates while idle, proportional trim nudges while tracking);
// cockpit.js owns which mode is live (aimMode()) and routes
// stickMove/stickRelease by it. What's left here is plumbing: shared config,
// the postControl adapters, and keyboard/blur/visibility delegation.
//
// jogVectorTtlMs is a hand-synced dead-man margin, not a feel parameter.
// maxJogDps IS a feel parameter tuned against real hardware -- the daemon
// pushes its current value on every SSE tick (DashboardState.jog), applied
// to the running StickHold below; MAX_JOG_DPS here is only the pre-first-
// tick/malformed-payload fallback, kept equal to config.ts's own default.
const JOG_VECTOR_TTL_MS = 500;
const MAX_JOG_DPS = 19;

// Adapts postControl's "try/toast/return data-or-null" contract to the
// boolean success signal stick-hold.js needs to keep posting. postControl
// already toasts on every failure path, so no separate toast is needed here.
async function postJogVector(panDps, tiltDps, durationMs) {
  const data = await postControl("jog", { pan_dps: panDps, tilt_dps: tiltDps, duration_ms: durationMs });
  return !!(data && data.ok === true);
}

// Same adapter shape, for the TRIM path (shifts the tracking setpoint's
// aim-offset while tracking instead of commanding a raw rate).
// Throttled so a held full-deflection push doesn't emit a toast per 200ms tick.
let lastTrimClampToastMs = 0;
async function postTrimVector(deltaPanDeg, deltaTiltDeg) {
  const data = await postControl("nudge-aim-offset", { delta_pan_deg: deltaPanDeg, delta_tilt_deg: deltaTiltDeg });
  const ok = !!(data && data.ok === true);
  // Say so when the trim runs out. Without this the offset silently stops
  // moving while the operator keeps pushing and the plane stays off-centre --
  // indistinguishable from a broken control, and the exact complaint from the
  // field on 2026-07-29. Hitting this means the pointing seed is off by more
  // than the trim can absorb, so the actionable advice is to re-run north
  // zero, not to keep pushing.
  if (ok && data.message && /"clamped":\s*true/.test(data.message)) {
    const now = Date.now();
    if (now - lastTrimClampToastMs > 4000) {
      lastTrimClampToastMs = now;
      toast("trim is at its limit — the pointing seed is off by more than the trim can absorb; re-run Set north zero", false);
    }
  }
  return ok;
}

const stickHold = new StickHold({
  postJog: postJogVector,
  postTrim: postTrimVector,
  jogVectorTtlMs: JOG_VECTOR_TTL_MS,
  maxJogDps: MAX_JOG_DPS,
  // Same combined gate as applyMotionGate's `disabled = estop.isLatched() ||
  // sunLocked`, but checked on every keep-alive tick (not just at push) --
  // dimming the widget only blocks a NEW gesture; it does nothing for a push
  // already in progress when an E-STOP lands mid-drag, which is exactly the
  // regression this must not allow.
  isGated: () => estop.isLatched() || sunLocked,
  // The loop already halted itself (no further posts); release the visual so
  // the UI doesn't look held after the loop died. No further postControl call
  // here -- there is no reason a bare stop vector would land when the post
  // that just failed didn't.
  onFailure: () => {},
});

// A finite, positive number, or `fallback` -- guards against a missing/
// malformed state.jog field turning into NaN and a dead jog control.
function positiveFiniteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Applies the daemon's live jog-feel config (state.jog.maxJogDps, sourced
// from config.ts) to the running StickHold on every render() tick -- config
// change + daemon restart takes effect on the next SSE tick, no reload.
function applyJogConfig(jog) {
  const j = jog && typeof jog === "object" ? jog : {};
  stickHold.maxJogDps = positiveFiniteOr(j.maxJogDps, MAX_JOG_DPS);
}

// The virtual stick itself. Input shaping (deadzone + curve) lives in
// virtual-stick.js; motion routing lives in Cockpit.stickMove/stickRelease.
const virtualStick = createVirtualStick({
  mount: el.stickMount,
  onMove: (fx, fy) => cockpit.stickMove(fx, fy),
  onRelease: () => cockpit.stickRelease(),
});

// The cockpit owns the AIM mode switch (jog/trim/locked) and the rest of the
// always-visible render path -- see cockpit.js's own module doc. `el` is
// reused as-is: it already carries every element Cockpit needs.
cockpit = new Cockpit({ el, stickHold, post: postControl });

// ---------------------------------------------------------------------------
// Bottom drawer: tab switching + open/close. Panels are permanent DOM toggled
// with [hidden] (never innerHTML-rewritten), so canvas listeners (#minimap),
// element references, and any mid-procedure state survive open/close cycles.
// ---------------------------------------------------------------------------
let bdOpen = false;

function showBdPanel(name) {
  if (!el.bdNav) return;
  for (const tab of el.bdNav.querySelectorAll(".bd-tab")) {
    tab.classList.toggle("bd-active", tab.dataset.bdPanel === name);
  }
  for (const panel of el.bottomDrawer.querySelectorAll(".bd-panel")) {
    panel.hidden = panel.dataset.bdPanel !== name;
  }
}

function openBottomDrawer(panelName) {
  if (!el.bottomDrawer) return;
  el.bottomDrawer.hidden = false;
  bdOpen = true;
  if (panelName) showBdPanel(panelName);
}

function closeBottomDrawer() {
  if (!el.bottomDrawer) return;
  el.bottomDrawer.hidden = true;
  bdOpen = false;
}

if (el.bdNav) {
  el.bdNav.addEventListener("click", (evt) => {
    const tab = evt.target.closest("[data-bd-panel]");
    if (tab) showBdPanel(tab.dataset.bdPanel);
  });
}
if (el.bdClose) el.bdClose.addEventListener("click", closeBottomDrawer);

// Keep the drawer tucked under the bar even when the bar's height changes
// (wrap at narrow widths), via a live CSS variable measured off the bar.
function syncBottomBarHeight() {
  if (!el.bottomBar) return;
  const h = el.bottomBar.offsetHeight;
  if (h > 0) document.documentElement.style.setProperty("--bottombar-h", `${h}px`);
}
syncBottomBarHeight();
if (el.bottomBar && typeof ResizeObserver === "function") {
  new ResizeObserver(syncBottomBarHeight).observe(el.bottomBar, { box: "border-box" });
}

// ---------------------------------------------------------------------------
// Settings surfaces: trackability range, standing aim trim, nudge sensitivity.
// All three are read ONCE from /api/settings on load (they change rarely, so
// polling them on every state tick would add MCP round-trips for nothing) and
// re-read after any write, so the readout always reflects what the daemon
// actually stored rather than what the browser asked for.
// ---------------------------------------------------------------------------
const TRIM_STEP_DEG = 0.05;   // matches the FINE nudge step: a trim is a fine adjustment by nature
let trim = { panDeg: 0, tiltDeg: 0 };

function renderTrim() {
  if (el.trimPan) el.trimPan.textContent = `${trim.panDeg.toFixed(2)}\u00b0`;
  if (el.trimTilt) el.trimTilt.textContent = `${trim.tiltDeg.toFixed(2)}\u00b0`;
  // A non-zero trim is a standing correction the operator should be able to
  // SEE is in effect, not discover by wondering why the rig is off-centre.
  if (el.trimBlock) el.trimBlock.classList.toggle("trim-armed", trim.panDeg !== 0 || trim.tiltDeg !== 0);
}

function renderRange(km) {
  if (el.trackRange) el.trackRange.value = String(km);
  if (el.trackRangeLabel) el.trackRangeLabel.textContent = `${km} km`;
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const s = await res.json();
    if (typeof s.maxRangeKm === "number") renderRange(s.maxRangeKm);
    if (typeof s.trimPanDeg === "number" && typeof s.trimTiltDeg === "number") {
      trim = { panDeg: s.trimPanDeg, tiltDeg: s.trimTiltDeg };
      renderTrim();
    }
  } catch {
    // Non-fatal: the cockpit still flies without these readouts, and the
    // state poll surfaces daemon trouble on its own.
  }
}

// Range slider. `input` only repaints the label; the POST waits for `change`
// (pointer release) so dragging across the track does not fire a write per
// pixel at the daemon.
if (el.trackRange) {
  el.trackRange.addEventListener("input", () => {
    if (el.trackRangeLabel) el.trackRangeLabel.textContent = `${el.trackRange.value} km`;
  });
  el.trackRange.addEventListener("change", async () => {
    const km = Number(el.trackRange.value);
    const data = await postControl("range/set", { max_range_km: km });
    if (data && data.ok === true) toast(`track range ${km} km`, true);
    await loadSettings();
  });
}

// Nudge sensitivity selector.
if (el.nudgeSens) {
  el.nudgeSens.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-sens]");
    if (!btn) return;
    const level = stickHold.setSensitivity(btn.dataset.sens);
    for (const b of el.nudgeSens.querySelectorAll("[data-sens]")) {
      b.classList.toggle("seg-active", b.dataset.sens === level);
    }
  });
}

// RC-style trim: each press writes an ABSOLUTE new trim rather than a delta,
// so a dropped request can never leave the daemon and the readout disagreeing
// about how many steps landed.
async function writeTrim(panDeg, tiltDeg) {
  const data = await postControl("trim/set", { pan_deg: panDeg, tilt_deg: tiltDeg });
  if (!(data && data.ok === true)) toast("trim write failed", false);
  await loadSettings();
}

if (el.trimBlock) {
  el.trimBlock.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-trim]");
    if (!btn) return;
    const dir = Number(btn.dataset.dir);
    const step = TRIM_STEP_DEG * dir;
    await writeTrim(
      btn.dataset.trim === "pan" ? trim.panDeg + step : trim.panDeg,
      btn.dataset.trim === "tilt" ? trim.tiltDeg + step : trim.tiltDeg,
    );
  });
}

// "Save from aim": adopt whatever offset is dialled in on the CURRENT pass.
// Sends no axes at all -- see set_aim_trim, where omitting them means "adopt
// the live offset" and sending zeros would mean "trim to zero".
if (el.trimAdopt) {
  el.trimAdopt.addEventListener("click", async () => {
    const data = await postControl("trim/set", {});
    if (data && data.ok === true) toast("standing trim saved from the current aim", true);
    await loadSettings();
  });
}

if (el.trimClear) {
  el.trimClear.addEventListener("click", async () => {
    const data = await postControl("trim/clear", {});
    if (data && data.ok === true) toast("standing trim cleared", true);
    await loadSettings();
  });
}

loadSettings();

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
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true);
}

// Arrow keys drive the SAME stick vector the widget does -- one control path,
// not a second one to keep in sync. Held keys accumulate into a vector
// (diagonals now work, which the old per-button model couldn't express);
// releasing every held key releases the stick.
const KEY_TO_AXIS = {
  ArrowUp: { axis: "fy", value: -1 },
  ArrowDown: { axis: "fy", value: 1 },
  ArrowLeft: { axis: "fx", value: -1 },
  ArrowRight: { axis: "fx", value: 1 },
};
const heldKeys = new Set();

function keyVector() {
  const v = { fx: 0, fy: 0 };
  for (const key of heldKeys) {
    const m = KEY_TO_AXIS[key];
    if (m) v[m.axis] += m.value;
  }
  // Clamp the composed diagonal to unit length so two held keys don't
  // command sqrt(2)x a single key's rate -- the same total-deflection bound
  // the physical stick rim enforces.
  const mag = Math.hypot(v.fx, v.fy);
  if (mag > 1) { v.fx /= mag; v.fy /= mag; }
  return v;
}

document.addEventListener("keydown", (evt) => {
  if (evt.repeat) return;
  if (!KEY_TO_AXIS[evt.key]) return;
  if (isTextEntryFocused()) return; // don't hijack arrow keys while typing (e.g. cal lat/lon/height)
  evt.preventDefault();
  heldKeys.add(evt.key);
  const v = keyVector();
  cockpit.stickMove(v.fx, v.fy);
});

document.addEventListener("keyup", (evt) => {
  if (!KEY_TO_AXIS[evt.key]) return;
  heldKeys.delete(evt.key);
  if (heldKeys.size === 0) cockpit.stickRelease();
  else { const v = keyVector(); cockpit.stickMove(v.fx, v.fy); }
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

// -- capture controls (cockpit CAM block) ------------------------------------
//
// capture_snapshot/start_recording/stop_recording (Task 3's plumbing) had no
// dashboard control before this task -- see the design doc's placement
// table. Neither tool is gated by E-STOP or the sun guard anywhere in the
// daemon (capture is a camera-side concern, independent of rig motion), so
// neither button here is gated either.
if (el.captureSnap) {
  el.captureSnap.addEventListener("click", () => postControl("capture/snapshot", {}));
}
// Record is state-driven like Camera/Sun guard: POST the intent, let the
// next SSE tick flip the label via renderCapture().
if (el.captureRecord) {
  el.captureRecord.addEventListener("click", () => {
    postControl(captureRecordingFromState ? "capture/stop-recording" : "capture/start-recording", {});
  });
}
// Auto capture (set_capture_mode, review fix I-3) -- the only control that
// flips captureAutoEnabled. State-driven like the others; not gated by
// E-STOP/sun-lock (capture is camera-side, independent of rig motion).
if (el.captureAuto) {
  el.captureAuto.addEventListener("click", () => {
    postControl("capture/set-mode", { enabled: !captureAutoEnabledFromState });
  });
}

// -- USB joystick / gamepad control -------------------------------------------
//
// The control loop (polling navigator.getGamepads(), posting jog/nudge/
// sight/E-STOP) is constructed unconditionally -- physical joystick control
// must work whether or not the drawer's Joystick entry is open. See
// joystick-panel.js's own module doc.
const joystickHold = initJoystickPanel({
  root: el.drawerBody,
  joystickToggleEl: el.joystickToggle,
  postJogVector,
  postTrimVector,
  sightTrackedAircraft: procedureActions.sightTrackedAircraft,
  doEstop: estop.trigger,
  isTrimActive,
  // Same combined gate as JogHold/NudgeHold's isGated -- checked every poll
  // tick, not just once, so an E-STOP/sun-lock landing mid-drive stops the
  // very next tick from posting again.
  isGated: () => estop.isLatched() || sunLocked,
  // Matches sightGateOk's union (procedure-actions.js): sight_aircraft
  // commands no motion, but E-STOP still refuses it (a slew halted mid-
  // track is no longer centred on the target). Kept as its own accessor
  // (not folded into isGated above) -- conceptually distinct gates that
  // happen to agree today.
  isSightGated: () => estop.isLatched() || sunLocked,
  getMaxJogDps: () => stickHold.maxJogDps,
  jogVectorTtlMs: JOG_VECTOR_TTL_MS,
});

// The cockpit chip now opens the drawer instead of toggling a floating
// overlay. Painted immediately on open (not left to the next ~10Hz poll
// tick) so the deadzone slider shows the CURRENT value, not the entry's
// baked-in default, the instant it's visible.
if (el.joystickToggle) {
  el.joystickToggle.addEventListener("click", () => {
    if (!drawer) return;
    openBottomDrawer("setup");
    drawer.open("joystick");
    mountJoystickEntry(el.drawerBody, joystickHold);
  });
}

// -- tracking-sector compass widget (Setup drawer entry) ---------------------
//
// Compass math/drag interaction lives in sector.js (moved as-is -- see its
// own module doc). Wires the delegated listeners once (on the stable
// #drawer-body) and kicks off the one-shot initial fetch.
sector.wireSectorDelegates(el.drawerBody, { postControl, isEstopLatched: () => estop.isLatched() });
void sector.initSector();

// -- mini-map (PPI radar) -----------------------------------------------------
//
// Canvas rendering + mouse wiring live in radar.js; this just wires the
// mouse events once with the gates/postControl it needs.
wireRadarEvents(el, {
  isEstopLatched: () => estop.isLatched(),
  isSunLocked: () => sunLocked,
  postControl,
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
    coasting: false,
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

connectStream();
