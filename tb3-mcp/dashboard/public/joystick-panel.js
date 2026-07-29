// USB joystick / gamepad diagnostic entry for the Setup drawer, plus the
// control-loop wiring that drives actual jog/nudge/sight/E-STOP commands
// from a physical controller. The operator calibrates by watching a plane in
// the video feed and trimming until it centres -- eyes on the plane, not
// this dashboard -- so a proportional stick lets them trim by thumb feel
// instead of reaching for the on-screen jog buttons. See joystick-hold.js's
// module doc for the full design/safety rationale; this file is the DOM
// wiring + live-readout rendering, matching the split jog-hold.js/
// nudge-hold.js already use for the button cluster.
//
// RELOCATED into the Setup drawer (2026-07-28 dashboard redesign, task 10)
// -- moved as-is per the design doc; the diagnostic content (connection
// status, button mapping, live axes/buttons, deadzone slider) is unchanged
// from when it lived in a permanently-mounted floating overlay. Its own
// standalone head (a <h2>Joystick</h2> + close button) is dropped -- the
// drawer's own head/nav/close already cover that now that this is a tab,
// not a floating panel toggled by its own button.
//
// The control LOOP itself (JoystickHold: polling navigator.getGamepads() at
// ~10Hz and posting jog/nudge/sight/E-STOP) does not depend on this entry
// being mounted at all -- physical joystick control must keep working
// whether or not the operator has the drawer open. Only the DIAGNOSTIC
// DISPLAY (renderJoystickSnapshot below) depends on the entry's DOM nodes
// existing, and simply no-ops (via the same query-and-null-check convention
// procedures.js/drawer.js already use) when they don't -- see this module's
// own render functions. Because the poll loop already runs at ~10Hz, the
// display self-heals within ~100ms of the operator navigating to this entry;
// no special "just mounted" repaint hook is needed for it (unlike Track
// Sector's live-drag case -- see sector.js's own doc for why THAT one does
// need one).
import { JoystickHold, SIGHT_BUTTON_INDEX, FINE_BUTTON_INDEX, ESTOP_BUTTON_INDICES } from "./joystick-hold.js";
import { DEADZONE_DEFAULT } from "./joystick-math.js";

function q(root, selector) {
  return root && typeof root.querySelector === "function" ? root.querySelector(selector) : null;
}

// The Joystick drawer entry's body. A template literal with NO interpolation
// depending on anything that varies at runtime -- SIGHT_BUTTON_INDEX/
// FINE_BUTTON_INDEX/ESTOP_BUTTON_INDICES are joystick-hold.js's own exported
// constants (never hand-typed, so this label can't quietly drift from the
// indices the control loop actually acts on), baked in at MODULE LOAD time,
// not per-call -- so, like sector.js's renderSectorEntry, this returns the
// exact same string on every call (see this module's own doc, and sector.js's,
// for why drawer.js's render-skip depends on that).
export function renderJoystickEntry() {
  return `
    <div id="joystick-conn" class="muted">not connected</div>
    <dl class="joystick-mapping">
      <dt>Left stick</dt><dd>pan / tilt (proportional)</dd>
      <dt>Sight button</dt><dd id="joystick-map-sight">button ${SIGHT_BUTTON_INDEX} ("A")</dd>
      <dt>Fine-mode button</dt><dd id="joystick-map-fine">button ${FINE_BUTTON_INDEX} ("RT", hold to halve rate)</dd>
      <dt>E-STOP combo</dt><dd id="joystick-map-estop">buttons ${ESTOP_BUTTON_INDICES.join(" + ")} ("Back" + "Start") together</dd>
    </dl>
    <div class="joystick-row">
      <span>Mode: <span id="joystick-mode">&mdash;</span></span>
      <span id="joystick-fine" class="joystick-fine" hidden>FINE</span>
    </div>
    <label class="joystick-deadzone">
      Deadzone <span id="joystick-deadzone-value">${DEADZONE_DEFAULT.toFixed(2)}</span>
      <input id="joystick-deadzone" type="range" min="0" max="0.5" step="0.01" value="${DEADZONE_DEFAULT}">
    </label>
    <div class="joystick-live">
      <div>
        <div class="joystick-live-label">Axes</div>
        <div id="joystick-axes" class="joystick-axes"></div>
      </div>
      <div>
        <div class="joystick-live-label">Buttons</div>
        <div id="joystick-buttons" class="joystick-buttons"></div>
      </div>
    </div>
  `;
}

// Called once, right after the operator navigates INTO the Joystick entry
// (see app.js's data-entry mount hook) -- syncs the deadzone slider's
// DISPLAYED value/text to whatever `joystickHold.deadzone` currently holds
// (which may differ from DEADZONE_DEFAULT if the operator already adjusted
// it earlier this session; the underlying value is a plain mutable property
// on the persistent JoystickHold instance, so it is never lost across a
// navigate-away-and-back -- only the DISPLAY would otherwise wrongly appear
// to reset to the baked-in default until this runs).
export function mountJoystickEntry(root, joystickHold) {
  const slider = q(root, "#joystick-deadzone");
  if (slider) slider.value = String(joystickHold.deadzone);
  const sliderValue = q(root, "#joystick-deadzone-value");
  if (sliderValue) sliderValue.textContent = joystickHold.deadzone.toFixed(2);
}

// Live-display rendering: independent of whether anything was
// gated/posted this tick -- this is purely "what does the controller
// actually report", the thing that makes a wrong mapping guess
// diagnosable instead of mysterious (controller mappings vary). Every
// lookup is null-guarded: the operator may not currently be on the Joystick
// entry, in which case this is a harmless no-op (except for the cockpit's
// always-present `joystickToggleEl`, which is never null in production).
function renderJoystickAxes(root, axes) {
  const container = q(root, "#joystick-axes");
  if (!container) return;
  container.innerHTML = axes.map((v, i) => {
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

function renderJoystickButtons(root, buttons) {
  const container = q(root, "#joystick-buttons");
  if (!container) return;
  container.innerHTML = buttons.map((b, i) => {
    const pressed = !!(b && b.pressed);
    return `<div class="joystick-button-chip${pressed ? " pressed" : ""}">${i}</div>`;
  }).join("");
}

export function renderJoystickSnapshot(root, joystickToggleEl, isTrimActive, snapshot) {
  if (joystickToggleEl) joystickToggleEl.classList.toggle("toggle-on", !!snapshot.connected);
  const conn = q(root, "#joystick-conn");
  if (conn) {
    conn.textContent = snapshot.connected
      ? `connected: ${snapshot.id || "unknown pad"}`
      : "not connected";
  }
  renderJoystickAxes(root, snapshot.axes || []);
  renderJoystickButtons(root, snapshot.buttons || []);

  const modeEl = q(root, "#joystick-mode");
  if (modeEl) modeEl.textContent = isTrimActive() ? "TRIM (aim offset)" : "JOG";
  const fineHeld = !!(snapshot.buttons && snapshot.buttons[FINE_BUTTON_INDEX] && snapshot.buttons[FINE_BUTTON_INDEX].pressed);
  const fineEl = q(root, "#joystick-fine");
  if (fineEl) fineEl.hidden = !fineHeld;
}

// Delegated on `root` (#drawer-body in production -- never recreated by
// drawer.js, only its children are), attached ONCE, so the deadzone slider
// keeps working across every navigate-away-and-back without needing to be
// re-wired. Deadzone is a local feel setting (like the pad itself), not a
// server config value -- no gating, always editable, mirrors joystickHold.
// deadzone being a plain mutable property (see joystick-hold.js's own doc).
export function wireJoystickDelegates(root, joystickHold) {
  if (!root || typeof root.addEventListener !== "function") return;
  root.addEventListener("input", (evt) => {
    const target = evt.target;
    if (!target || target.id !== "joystick-deadzone") return;
    const v = parseFloat(target.value);
    if (!Number.isFinite(v)) return;
    joystickHold.deadzone = v;
    const sliderValue = q(root, "#joystick-deadzone-value");
    if (sliderValue) sliderValue.textContent = v.toFixed(2);
  });
}

// Constructs, wires, and starts the JoystickHold control loop. Reuses the
// EXACT SAME post paths the on-screen jog/trim buttons use (postJogVector /
// postNudgeVector, passed in by app.js) and the exact same gates -- the
// joystick is another caller of existing, already-gated control paths,
// never a new one. Unconditional (no `el.joystickPanel` truthy-check the
// original app.js had): that check only ever tested "does this page have the
// joystick markup", which was always true; physical joystick control must
// work regardless of the drawer's mount state, so there is nothing left to
// gate the loop's construction on.
//
// deps:
//   root             -- #drawer-body, for the live-display queries above.
//   joystickToggleEl -- the cockpit's always-present #joystick-toggle chip.
//   postJogVector, postNudgeVector, sightTrackedAircraft, doEstop -- the
//     same adapters/actions app.js's own button/keyboard wiring uses.
//   isTrimActive     -- () => boolean (aimMode-derived; see app.js).
//   isGated, isSightGated -- () => boolean; kept as two separate accessors
//     (not folded into one) even though both currently compute
//     estopLatched||sunLocked -- see the original app.js wiring's own
//     comment on why they are conceptually distinct gates that happen to
//     agree today.
//   getMaxJogDps     -- () => number, the live jogHold.maxJogDps value.
//   jogVectorTtlMs   -- the shared dead-man TTL constant.
export function initJoystickPanel({
  root, joystickToggleEl, postJogVector, postNudgeVector, sightTrackedAircraft, doEstop,
  isTrimActive, isGated, isSightGated, getMaxJogDps, jogVectorTtlMs,
}) {
  const joystickHold = new JoystickHold({
    getGamepads: () => (typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : []),
    postJog: postJogVector,
    postNudge: postNudgeVector,
    onSight: sightTrackedAircraft,
    onEstop: doEstop,
    isTrackingActive: () => isTrimActive(),
    isGated,
    isSightGated,
    getMaxJogDps,
    jogVectorTtlMs,
    onSnapshot: (snapshot) => renderJoystickSnapshot(root, joystickToggleEl, isTrimActive, snapshot),
    onFailure: () => {}, // postJogVector/postNudgeVector already toast on failure via postControl
  });

  wireJoystickDelegates(root, joystickHold);

  // gamepadconnected needs no special handling beyond letting the next poll
  // pick up the pad (see handleConnected's doc); gamepaddisconnected must
  // stop immediately rather than waiting up to one poll interval.
  window.addEventListener("gamepadconnected", (e) => joystickHold.handleConnected(e));
  window.addEventListener("gamepaddisconnected", (e) => joystickHold.handleDisconnected(e));

  // Loss-of-control triggers shared with the button-hold loops: a stick
  // that keeps a stale non-zero rate after the tab is hidden/backgrounded is
  // a runaway exactly like a held button would be.
  window.addEventListener("blur", () => joystickHold.haltDrive());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) joystickHold.haltDrive();
  });

  joystickHold.start();
  return joystickHold;
}
