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
import {
  DEADZONE_DEFAULT, SENSITIVITY_DEFAULT, SENSITIVITY_MIN, SENSITIVITY_MAX,
  maxRateForSensitivity,
} from "./joystick-math.js";

function q(root, selector) {
  return root && typeof root.querySelector === "function" ? root.querySelector(selector) : null;
}

// "max 6.7°/s", not a bare unitless fraction -- the operator ask this
// control exists for ("need to be... configurable... in the joystick menu")
// is about what a given setting DOES to the rig, not the 0..1 number itself.
// A non-finite maxDps (pre-first-SSE-tick, or a malformed payload) reads as
// an em dash rather than "max NaN°/s".
function formatMaxRateText(maxDps, sensitivity) {
  const rate = maxRateForSensitivity(maxDps, sensitivity);
  return Number.isFinite(rate) ? `max ${Math.abs(rate).toFixed(1)}°/s` : "max —";
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
    <!-- Field report: a barely-perceptible nudge on the Bluetooth pad
         overshot by ~20 degrees -- an overall gain on top of the deadzone
         above, not a smaller hardware ceiling (maxJogDps is a measured
         plateau, untouched here). Shows the resulting max rate (deg/s), not
         a bare 0..1 fraction, so the operator can act on it directly against
         a real lens -- see formatMaxRateText's own doc. -->
    <label class="joystick-sensitivity">
      Sensitivity <span id="joystick-sensitivity-value">${SENSITIVITY_DEFAULT.toFixed(2)}</span>
      <input id="joystick-sensitivity" type="range" min="${SENSITIVITY_MIN}" max="${SENSITIVITY_MAX}" step="0.01" value="${SENSITIVITY_DEFAULT}">
      <span id="joystick-sensitivity-rate" class="joystick-sensitivity-rate">max &mdash;</span>
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
// (see app.js's data-entry mount hook) -- syncs the deadzone AND sensitivity
// sliders' DISPLAYED value/text to whatever `joystickHold.deadzone`/
// `.sensitivity` currently hold (which may differ from DEADZONE_DEFAULT/
// SENSITIVITY_DEFAULT if the operator already adjusted them earlier this
// session; the underlying values are plain mutable properties on the
// persistent JoystickHold instance, so neither is ever lost across a
// navigate-away-and-back -- only the DISPLAY would otherwise wrongly appear
// to reset to the baked-in default until this runs). The sensitivity block
// is guarded the same null-safe way as the deadzone block above it (a fake/
// partial joystickHold in a test, or a not-yet-mounted entry, must not throw
// here -- see wireJoystickDelegates' identical guard for why).
export function mountJoystickEntry(root, joystickHold) {
  const slider = q(root, "#joystick-deadzone");
  if (slider) slider.value = String(joystickHold.deadzone);
  const sliderValue = q(root, "#joystick-deadzone-value");
  if (sliderValue) sliderValue.textContent = joystickHold.deadzone.toFixed(2);

  // typeof-guarded (not just DOM-node-guarded, unlike the deadzone block
  // above): a caller passing a partial joystickHold-like object with no
  // opinion on sensitivity (an older test, or a stub built before this
  // feature existed) must not throw here.
  if (typeof joystickHold.sensitivity === "number") {
    const sensSlider = q(root, "#joystick-sensitivity");
    if (sensSlider) sensSlider.value = String(joystickHold.sensitivity);
    const sensValue = q(root, "#joystick-sensitivity-value");
    if (sensValue) sensValue.textContent = joystickHold.sensitivity.toFixed(2);
    const sensRate = q(root, "#joystick-sensitivity-rate");
    if (sensRate) {
      const maxDps = typeof joystickHold.getMaxJogDps === "function" ? joystickHold.getMaxJogDps() : 0;
      sensRate.textContent = formatMaxRateText(maxDps, joystickHold.sensitivity);
    }
  }
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
// drawer.js, only its children are), attached ONCE, so the deadzone and
// sensitivity sliders keep working across every navigate-away-and-back
// without needing to be re-wired. Both are local feel settings (like the pad
// itself), not server config values -- no gating, always editable, mirroring
// joystickHold.deadzone/.sensitivity being plain mutable properties (see
// joystick-hold.js's own doc) that JoystickHold's poll loop reads fresh every
// tick -- a slider move here takes effect on the very next tick, no restart.
export function wireJoystickDelegates(root, joystickHold) {
  if (!root || typeof root.addEventListener !== "function") return;
  root.addEventListener("input", (evt) => {
    const target = evt.target;
    if (!target) return;
    if (target.id === "joystick-deadzone") {
      const v = parseFloat(target.value);
      if (!Number.isFinite(v)) return;
      joystickHold.deadzone = v;
      const sliderValue = q(root, "#joystick-deadzone-value");
      if (sliderValue) sliderValue.textContent = v.toFixed(2);
      return;
    }
    if (target.id === "joystick-sensitivity") {
      const v = parseFloat(target.value);
      if (!Number.isFinite(v)) return;
      joystickHold.sensitivity = v;
      const sensValue = q(root, "#joystick-sensitivity-value");
      if (sensValue) sensValue.textContent = v.toFixed(2);
      const sensRate = q(root, "#joystick-sensitivity-rate");
      if (sensRate) {
        const maxDps = typeof joystickHold.getMaxJogDps === "function" ? joystickHold.getMaxJogDps() : 0;
        sensRate.textContent = formatMaxRateText(maxDps, v);
      }
    }
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
    // SENSITIVITY_DEFAULT explicitly, NOT left to JoystickHold's own
    // constructor default (SENSITIVITY_MAX) -- see joystick-math.js's own
    // doc on why the two differ on purpose. This is the one production
    // instance that should start at the gentler, fine-framing-usable
    // default; a test constructing its own JoystickHold directly still gets
    // the neutral SENSITIVITY_MAX unless it opts in the same way.
    sensitivity: SENSITIVITY_DEFAULT,
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
