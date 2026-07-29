// The Setup drawer's Calibration entry: renders step-gate.js's ordered
// procedure as a guided checklist and drives the drawer's open<->strip
// handoff for the two steps that need the operator's eyes on the video.
//
// This module is presentation only. Every prerequisite/ordering decision --
// what's done, what's blocked, and WHY -- belongs to step-gate.js
// (calibrationSteps), imported and never re-derived here. This is the fix
// for the old flat pile of calibration buttons: an operator could not tell
// what to press when, or why a button did nothing. A blocked row therefore
// always shows step-gate.js's `reason` as plain visible text (`.blocked-
// reason`), never a `title` tooltip -- a reason nobody can see is exactly
// the bug this whole redesign exists to fix.
//
// Steps 1-3 (rig location, IMU sweep, north zero) and the final solve act
// entirely in the open drawer -- none of them need the video. Sighting 1/2
// alone hand off to the drawer's strip (collapseToStrip), because a plane
// crosses a zoomed field of view in about two seconds by hand; once the rig
// is tracking (after north-zero seeds a provisional orientation) it slews
// with the plane and the operator gets the whole pass to trim it to centre
// -- see drawer.js's own module doc for why the strip exists at all. Each
// available sighting row also carries a secondary "use a landmark instead"
// link (sight_landmark, no strip needed -- it records the CURRENT pointing
// against a known lat/lon/height, not a moving target) per the design doc's
// "the landmark path remains available as an alternative to steps 4-5".
import { calibrationSteps } from "./step-gate.js";
import { calibrationBadge } from "./ui-mode.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// One <li> per step-gate.js step. The action cell (`.step-actions`) holds
// exactly one PRIMARY control -- a done step's [redo]/[reset], a blocked
// step's visible reason, or a ready step's [run]/[start] -- plus, for a
// ready sighting step only, a secondary [use a landmark instead] link (see
// renderCalibration's own comment) offering sight_landmark as an
// alternative to sighting the tracked aircraft, matching the design doc's
// "the landmark path remains available as an alternative to steps 4-5".
//
// `redoLabel` (defaults to "redo") is the done-state verb, both as the
// visible text and the `data-act` prefix -- renderCalibration overrides it
// to "reset" for rig-location once there's an IMU sweep to lose, so the
// row's own markup never claims to be an in-place edit it isn't.
function renderStepRow(s, i, redoLabel) {
  const mark = s.done ? "✓" : s.blocked ? "" : "→";
  const verb = redoLabel || "redo";
  const isSighting = s.id === "sight-1" || s.id === "sight-2";
  const landmarkLink = (isSighting && s.available)
    ? `<button type="button" data-act="landmark:${s.id}" class="link landmark-alt">use a landmark instead</button>`
    : "";
  const primary = s.done
    ? `<button type="button" data-act="${verb}:${s.id}" class="link">${verb}</button>`
    : s.blocked
      ? `<span class="blocked-reason">${escapeHtml(s.reason)}</span>`
      : `<button type="button" data-act="run:${s.id}" class="primary">${s.id.startsWith("sight") ? "start" : "run"}</button>`;
  return `<li class="step ${s.done ? "done" : s.blocked ? "blocked" : "next"}" data-step="${s.id}">
      <span class="num">${i + 1}</span>
      <span class="label">${escapeHtml(s.label)}</span>
      <span class="detail">${escapeHtml(s.detail)}</span>
      <span class="mark">${mark}</span>
      <span class="step-actions">${primary}${landmarkLink}</span>
    </li>`;
}

// 0-based index of the last step-gate.js step that's still config (rig
// location, IMU sweep, north zero) -- the divider goes right after it. North
// zero is the gate: it seeds the provisional orientation that makes tracking
// (and therefore trimming a plane to centre) possible at all, so the
// operator needs to see that steps 4/5 only open up from here, not merely
// that they happen to be later rows in the same flat list.
const LAST_CONFIG_STEP_INDEX = 2;

// PROVISIONAL (a set_north_zero seed) must never read the same as CALIBRATED
// (a full solve) anywhere in this UI -- it's a seed good enough to start
// tracking from, not a finished procedure, and conflating the two would let
// an operator trust an uncalibrated rig. Reuses calibrationBadge (ui-mode.js)
// -- the exact same derivation the topbar badge already uses -- rather than
// re-deriving a second copy of that distinction here.
export function renderCalibration(state, actions) {
  const steps = calibrationSteps(state);
  const badge = calibrationBadge(state);

  // set_rig_location REPLACES THE WHOLE CALIBRATION PROFILE
  // (src/calibration.ts) -- once characterize_imu has solved a mounting,
  // re-running it throws that sweep away too, not just the coordinate. Step
  // 1's already-done link reads [reset] rather than [redo] once that's
  // true, so it doesn't look like the other four rows' genuinely in-place
  // redo (see app.js's editRigLocation for the write side of this).
  const hasImu = !!((state && state.calibration && state.calibration.imuMounting));

  const rows = steps.map((s, i) => {
    const redoLabel = (s.id === "rig-location" && hasImu) ? "reset" : "redo";
    const row = renderStepRow(s, i, redoLabel);
    return i === LAST_CONFIG_STEP_INDEX
      ? row + `<li class="steps-divider" aria-hidden="true"><span>tracking now possible ↓ trim &amp; sight below</span></li>`
      : row;
  }).join("");

  return `
    <div class="cal-status-line"><span class="badge ${badge.cls}">${escapeHtml(badge.text)}</span></div>
    <ol class="steps">${rows}</ol>
  `;
}

// Dispatches a clicked step's id to the one action that runs it. `state` is
// accepted (matching step-gate's own step shape) even though every branch
// below only needs `actions` today -- kept so a future step needing to read
// state before dispatching doesn't change this function's signature.
export function stepHandler(id, drawer, state, actions) {
  if (id === "rig-location") return actions.editRigLocation();
  if (id === "imu") return actions.runImu();
  if (id === "north-zero") return actions.setNorthZero();
  if (id === "solve") return actions.solve();
  if (id === "sight-1" || id === "sight-2") return actions.startSighting(id, drawer);
  return undefined;
}

// The strip's initial markup for an in-progress sighting step (Step 2 of
// this task). id="strip-sight"/"strip-cancel" are matched by
// collapseToStrip's `handlers` map; data-region="aircraft"/"offset" are
// updated live via drawer.updateStrip() on every SSE tick while the strip is
// showing (see app.js) -- never by re-calling collapseToStrip, which would
// tear down and rebuild these same two buttons (and their listeners) at
// tick-rate instead of trim-rate.
export function sightingStripHtml(stepId, state) {
  const label = stepId === "sight-2" ? "Sighting 2" : "Sighting 1";
  return `
    <div class="strip-row">
      <strong>${escapeHtml(label)}</strong>
      <span data-region="aircraft">${escapeHtml(formatTrackedAircraft(state))}</span>
      <span data-region="offset">${escapeHtml(formatTrimOffset(state))}</span>
    </div>
    <div class="strip-actions">
      <button type="button" id="strip-sight" class="primary">Sight it</button>
      <button type="button" id="strip-cancel" class="link">cancel</button>
    </div>
  `;
}

// state.tracking.hex/callsign -- the aircraft the strip's [Sight it] will
// actually sight (sight_aircraft always records whatever is CURRENTLY
// tracked; there is no separate picker in the guided flow, unlike the old
// standalone panel's dropdown -- see this task's report for why that
// dropdown was retired rather than carried over).
export function formatTrackedAircraft(state) {
  const t = (state && state.tracking) || {};
  return t.hex ? `${t.callsign || t.hex} (${t.hex})` : "no aircraft tracked yet";
}

// state.tracking.offsetPanDeg/offsetTiltDeg -- the live drift-calibration
// trim the operator is nudging toward centred, same fields cockpit.js's
// trkOffset readout already shows (track/offset.ts). Always numbers
// (mergeState defaults both to 0), so this always reads as a real,
// converging value rather than a dash.
export function formatTrimOffset(state) {
  const t = (state && state.tracking) || {};
  const pan = typeof t.offsetPanDeg === "number" ? t.offsetPanDeg : 0;
  const tilt = typeof t.offsetTiltDeg === "number" ? t.offsetTiltDeg : 0;
  return `trim ${pan.toFixed(2)}° / ${tilt.toFixed(2)}°`;
}

// -----------------------------------------------------------------------
// The Setup drawer's Travel limits entry: teach_limit/get_taught_limits/
// clear_taught_limits (src/limits-tools.ts) capture the rig's CURRENT
// pan/tilt telemetry as one of four independent edges (pan_min, pan_max,
// tilt_min, tilt_max) -- unlike calibration these have no ordering
// requirement between them (any edge can be taught whenever the operator
// has jogged there) and no daemon-side sun-lock/E-STOP gate at all
// (limits-tools.ts's own module comment: "none of these three ever command
// the rig ... there is no sun-lock or tracking-active gate here"). The
// motion that gets the rig TO an edge is an ordinary jog, already gated by
// the cockpit's existing AIM block -- this procedure only ever records
// wherever the rig already is.
//
// Same open<->strip split as calibration's sighting steps: teaching an edge
// is an AIMING action (the operator must watch the rig -- not a screen --
// jog toward a mechanical stop), so each edge's [Teach] collapses the
// drawer to a strip and leaves the full cockpit (jog controls, video,
// E-STOP) live underneath -- see drawer.js's module doc.
// -----------------------------------------------------------------------

// Matches teach_limit's own EDGE_ARG enum (limits-tools.ts) and controls.ts's
// limits/teach route -- these exact four strings are what travels over the
// wire, not a display label.
const EDGES = ["pan_min", "pan_max", "tilt_min", "tilt_max"];

// "pan_min" -> "pan min" -- shared by the row list's label and the strip's
// heading/status/button text, so the two surfaces never describe the same
// edge two different ways.
export function formatEdgeLabel(edge) {
  return String(edge).replace("_", " ");
}

function formatDeg(v) {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)}°` : "—";
}

// One row per edge: its current EFFECTIVE value (state.limits -- the
// taught-or-config-ceiling range the SSE stream carries, see state.ts's
// EffectiveLimits) and a [Teach] link. state.ts deliberately does not
// surface a separate "was this edge actually taught, or is it still the
// config default" flag on the wire (see its own comment on EffectiveLimits)
// -- [clear taught limits] below always reverts all four at once regardless,
// so that distinction isn't needed to operate this UI.
function limitsRow(edge, valueDeg) {
  return `<div class="limits-row" data-edge="${edge}">
      <span class="limits-label">${escapeHtml(formatEdgeLabel(edge))}</span>
      <span class="limits-value">${escapeHtml(formatDeg(valueDeg))}</span>
      <button type="button" data-act="teach:${edge}" class="link">Teach</button>
    </div>`;
}

// `actions` is accepted (unused today) to match renderCalibration's own
// signature -- kept so a future addition here doesn't change the call site
// drawer.setEntryRenderer wires up.
export function renderTravelLimits(state, actions) {
  const lim = (state && state.limits) || null;
  const values = {
    pan_min: lim ? lim.panMinDeg : null,
    pan_max: lim ? lim.panMaxDeg : null,
    tilt_min: lim ? lim.tiltMinDeg : null,
    tilt_max: lim ? lim.tiltMaxDeg : null,
  };
  const rows = EDGES.map((edge) => limitsRow(edge, values[edge])).join("");

  return `
    <p class="muted limits-intro">Jog to each mechanical edge, then capture it -- once per edge, four
      independent edges. A taught limit can only ever be TIGHTER than the configured range, never wider.</p>
    <div class="limits-grid">${rows}</div>
    <div class="limits-actions">
      <button type="button" data-act="clear-limits" class="link destructive">clear taught limits</button>
    </div>
  `;
}

// The strip's markup for an in-progress edge capture -- same aiming-needs-
// the-video handoff as calibration's sightingStripHtml (see its own doc):
// the operator must jog to the real mechanical stop while watching the RIG,
// not a screen, so the drawer collapses and the full cockpit -- jog
// controls, video, E-STOP -- stays live underneath. id="strip-capture"/
// "strip-cancel" are matched by collapseToStrip's `handlers` map;
// data-region="pantilt" is updated live every tick via drawer.updateStrip()
// (see app.js) -- never by re-calling collapseToStrip, which would tear
// down these same two buttons (and their listeners) at tick-rate.
export function teachStripHtml(edge, state) {
  const label = formatEdgeLabel(edge);
  return `
    <div class="strip-row">
      <strong>Teach ${escapeHtml(label)}</strong>
      <span>jog to the ${escapeHtml(label)} edge, then capture</span>
      <span data-region="pantilt">${escapeHtml(formatCurrentPanTilt(state))}</span>
    </div>
    <div class="strip-actions">
      <button type="button" id="strip-capture" class="primary">Set ${escapeHtml(label)} here</button>
      <button type="button" id="strip-cancel" class="link">cancel</button>
    </div>
  `;
}

// state.rig.panDeg/tiltDeg -- the CURRENT telemetry, so the operator watching
// this strip can see it move as they jog without looking away. Both are
// nullable (pre-connect/degraded, see state.ts's DashboardState.rig) and
// collapse to an em dash independently per axis, same fmt() convention
// app.js already uses for the always-visible telemetry panel.
export function formatCurrentPanTilt(state) {
  const rig = (state && state.rig) || {};
  return `pan ${formatDeg(rig.panDeg)} / tilt ${formatDeg(rig.tiltDeg)}`;
}

// -----------------------------------------------------------------------
// The Setup drawer's Set home entry: the design doc's own example of a
// control that silently invalidates two other procedures' work and, before
// this task, was visually indistinguishable from any other button (see
// destructiveConfirm below, which is what actually gates the write). The
// warning here is always-visible text -- never a title tooltip, same rule
// renderStepRow's blocked-reason follows -- and the button itself carries
// `.destructive` so it reads as dangerous at a glance, not only behind a
// dialog the operator might reflexively dismiss.
// -----------------------------------------------------------------------

// `actions` is accepted (unused today) for the same forward-compatibility
// reason as renderTravelLimits/renderCalibration above.
export function renderSetHome(state, actions) {
  return `
    <p class="muted">Zeroes the rig's current physical position as the new software home.</p>
    <p class="sethome-warning">This clears the current calibration AND every taught travel limit -- both
      are measured relative to the OLD zero and become invalid the instant it moves. Recalibrating costs a
      fresh IMU sweep plus two aircraft sightings (minutes of watching the sky); every taught edge (pan
      min/max, tilt min/max) will need re-teaching too.</p>
    <div class="sethome-actions">
      <button type="button" data-act="home:set" class="primary destructive">Set home</button>
    </div>
  `;
}

// PURE: whether an action needs an explicit confirmation before app.js is
// allowed to fire it, and -- when it does -- the exact text naming what it
// destroys. `set_home` is the sharp case the design doc calls out by name:
// it silently invalidates BOTH the calibration (an IMU sweep plus two
// aircraft sightings, each taken over minutes of watching the sky) and
// every taught travel-limit edge -- "Are you sure?" would tell the operator
// nothing about what they are actually about to spend, so this names both
// things explicitly, every time, regardless of whether either currently
// holds real progress (there is still a real, if smaller, IMU-sweep/
// sighting/edge cost to REDO even from a PROVISIONAL or partially-taught
// state). `clear_taught_limits` is gated too -- reverting to the wider
// config ceiling is a real loss of field-taught edges, even though it is
// far cheaper to redo than a full calibration. `teach_limit` itself
// (capturing one edge) is deliberately NOT gated here, matching
// limits-tools.ts's own "read-only-of-motion, no gate" convention for that
// tool -- and every action name below is the raw MCP tool name
// (teach_limit/clear_taught_limits/set_home), not a controls.ts route
// string, so a caller can pass exactly what it's about to invoke.
export function destructiveConfirm(action, state) {
  if (action === "set_home") {
    const badge = calibrationBadge(state);
    return {
      needed: true,
      message:
        `Set home clears the current ${badge.text} calibration AND every taught travel-limit edge -- ` +
        "both are measured relative to the OLD zero and become invalid the instant it moves. " +
        "Recalibrating costs a fresh IMU sweep plus two aircraft sightings (minutes of watching the " +
        "sky); every taught edge (pan min/max, tilt min/max) will need re-teaching too. This cannot be " +
        "undone. Set home anyway?",
    };
  }
  if (action === "clear_taught_limits") {
    return {
      needed: true,
      message:
        "This clears every taught travel-limit edge, reverting to the wider configured ceiling. " +
        "Clear the taught limits?",
    };
  }
  return { needed: false, message: "" };
}
