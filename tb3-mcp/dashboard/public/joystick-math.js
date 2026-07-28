// Pure joystick input math: deadzone, response curve, axis->rate mapping,
// button-press edge detection, and jog-vs-trim mode selection. No DOM, no
// Gamepad API, no timers -- testable without a browser or a physical
// controller, same rationale as jog-ramp.js/camera-mode.js/video-stats.js.
// joystick-hold.js is the stateful class that actually polls
// navigator.getGamepads() on a timer and calls these; keeping the math here
// means the safety-critical parts (deadzone, curve, "did this button just
// get pressed") can be pinned with plain inputs/outputs, no fake timers or
// fake gamepads required.

// Generous default: sticks drift at rest (mechanical play, worn
// potentiometers, cheap pads), and with no deadzone that drift reads as a
// continuous, silent creep of the rig -- see the module doc in
// joystick-hold.js for the full safety rationale. 0.15 (15% of full travel)
// is chosen with real margin over typical retail-pad rest drift (a few
// percent), not tuned to one specific pad's spec sheet. Configurable at
// runtime (JoystickHold#deadzone is a plain, mutable property) because how
// worn a given operator's controller is isn't something this file can know.
export const DEADZONE_DEFAULT = 0.15;

// Squared, sign-preserving: small deflections map to disproportionately
// small output (fine control for framing at zoom), while full deflection
// still reaches exactly the full commanded rate -- the same "coarse click
// moved too far, fine click barely moved" complaint jog-ramp.js's module doc
// describes, solved here for a continuous stick instead of a button ramp.
// A straight linear curve was explicitly ruled out by the brief as unusable
// for framing at zoom.
export const CURVE_EXPONENT = 2;

// A held shoulder/trigger halves the commanded rate -- fine framing without
// giving up reach across the stick's full range (unlike a fixed low-speed
// preset, this stacks with the response curve at any deflection).
export const FINE_MODE_FACTOR = 0.5;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Raw axis value (any real number a controller might report; NaN/Infinity
// from a flaky driver are treated as 0, never as an unbounded command) ->
// [-1, 1] with `deadzone` carved out of the middle and the REMAINING travel
// rescaled back up to the full [-1, 1] range (not just subtracted), so full
// physical deflection still reaches exactly +/-1 rather than +/-(1 -
// deadzone) -- this is what lets axisToRate below reach the full configured
// maxDps at full stick throw regardless of the deadzone setting. Exactly 0
// for any |value| <= deadzone (inclusive: a value sitting exactly on the
// boundary is still "inside"); continuous (no jump) just outside it, so a
// hair past the deadzone reads as a hair of rate, not a sudden snap.
export function applyDeadzone(value, deadzone = DEADZONE_DEFAULT) {
  const v = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  const dz = Number.isFinite(deadzone) ? clamp(deadzone, 0, 0.99) : DEADZONE_DEFAULT;
  const mag = Math.abs(v);
  if (mag <= dz) return 0;
  const rescaled = (mag - dz) / (1 - dz);
  return Math.sign(v) * rescaled;
}

// Sign-preserving power curve over an already-deadzoned [-1, 1] value.
// Monotonic in |value| for any exponent >= 1, and exponent 2 (the default)
// maps 0 -> 0 and 1 -> 1 exactly, so composing with applyDeadzone above
// never clips a fully-deflected stick short of full rate.
export function applyCurve(value, exponent = CURVE_EXPONENT) {
  const v = Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  return Math.sign(v) * Math.pow(Math.abs(v), exponent);
}

// The one function that turns a raw stick reading into a commanded rate, in
// deg/s, against the LIVE maxDps (config.ts's maxJogDps, threaded through by
// the caller from dashboard state -- see app.js's applyJogConfig for the
// jog-hold.js precedent this deliberately follows: maxJogDps is a feel
// parameter tuned against real hardware, pushed live on every SSE tick, and
// a hand-copied constant here was a real bug before. This function never has
// a fallback literal baked in for a caller to forget to update -- an
// unusable (missing/non-positive) maxDps produces 0 rate, not a guess.
export function axisToRate(rawValue, maxDps, { deadzone = DEADZONE_DEFAULT, fine = false } = {}) {
  const safeMax = Number.isFinite(maxDps) && maxDps > 0 ? maxDps : 0;
  const shaped = applyCurve(applyDeadzone(rawValue, deadzone));
  const rate = shaped * safeMax;
  return fine ? rate * FINE_MODE_FACTOR : rate;
}

// tracking -> TRIM (nudge the aim offset); otherwise -> JOG (raw jog
// vector). Mirrors app.js's renderTracking()/activeHold() choice for the
// direction-button cluster exactly (see nudge-hold.js's module doc) so
// joystick input can never disagree with the buttons about which of the two
// very different actions the same deflection means.
export const MODE_JOG = "jog";
export const MODE_TRIM = "trim";
export function selectMode(trackingActive) {
  return trackingActive ? MODE_TRIM : MODE_JOG;
}

// Rising-edge (not-pressed -> pressed) detection for a single boolean signal
// across two consecutive polls. This is the entire reason a held button
// (mark-a-sighting, the E-STOP combo) fires its action once per press
// instead of once per ~100ms poll tick for as long as it's held -- a
// repeat-firing sight button would spam sightings, and a repeat-firing
// E-STOP would re-trigger the emergency-stop pipeline on every tick, which
// is worse. Deliberately pure and stateless: the caller (joystick-hold.js)
// owns "what was pressed last poll", not this function, so the transition
// table can be asserted directly without driving a stateful object through
// simulated time.
export function risingEdge(wasPressed, isPressed) {
  return !wasPressed && !!isPressed;
}

// A single button's pressed state out of a gamepad's buttons[] array (as
// booleans, e.g. `gp.buttons.map(b => b.pressed)`). Out-of-range/missing
// reads as not-pressed rather than throwing -- controllers report varying
// button counts.
export function isPressed(pressedArray, index) {
  return Array.isArray(pressedArray) && !!pressedArray[index];
}

// ALL of `indices` currently pressed -- the level (not edge) test for a
// chorded combo like the E-STOP's "two buttons together". An empty/missing
// indices list reads as false, never as vacuously true: a combo with
// nothing required to press must never "fire" on its own.
export function allPressed(pressedArray, indices) {
  if (!Array.isArray(pressedArray) || !Array.isArray(indices) || indices.length === 0) return false;
  return indices.every((i) => !!pressedArray[i]);
}
