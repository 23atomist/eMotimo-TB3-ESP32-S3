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
// -- see drawer.js's own module doc for why the strip exists at all.
import { calibrationSteps } from "./step-gate.js";
import { calibrationBadge } from "./ui-mode.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// One <li> per step-gate.js step. `right` is exactly one of: a done step's
// [redo], a blocked step's visible reason, or a ready step's [run]/[start]
// -- never more than one, so the row never has to say the same thing twice.
function renderStepRow(s, i) {
  const mark = s.done ? "✓" : s.blocked ? "" : "→";
  const right = s.done
    ? `<button type="button" data-act="redo:${s.id}" class="link">redo</button>`
    : s.blocked
      ? `<span class="blocked-reason">${escapeHtml(s.reason)}</span>`
      : `<button type="button" data-act="run:${s.id}" class="primary">${s.id.startsWith("sight") ? "start" : "run"}</button>`;
  return `<li class="step ${s.done ? "done" : s.blocked ? "blocked" : "next"}" data-step="${s.id}">
      <span class="num">${i + 1}</span>
      <span class="label">${escapeHtml(s.label)}</span>
      <span class="detail">${escapeHtml(s.detail)}</span>
      <span class="mark">${mark}</span>
      ${right}
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

  const rows = steps.map((s, i) => {
    const row = renderStepRow(s, i);
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
