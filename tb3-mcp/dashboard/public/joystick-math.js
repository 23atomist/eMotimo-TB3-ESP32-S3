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

// Field report: "the joystick over bluetooth... it's way way way too
// sensitive. i touch it and it's 20 degree over already." The deadzone +
// squared curve above assume a smoothly-proportional analog stick, where a
// barely-perceptible nudge reports a small raw axis value; this particular
// Bluetooth pad's own reported axis values apparently jump close to full
// scale on a very light touch (a stiff/short-throw mechanism, or a
// digital-ish stick reported through an analog API), so reshaping the curve
// near zero cannot help -- the "small input" this operator is actually
// producing isn't a small RAW value at all. A per-tick overall GAIN, applied
// AFTER the curve (see axisToRate below), fixes exactly this: it scales
// whatever the pad reports, however large, down proportionally, rather than
// only suppressing values already close to the deadzone.
//
// SENSITIVITY_MAX (1) never AMPLIFIES beyond the configured/measured maxDps
// ceiling passed into axisToRate -- sensitivity is a damper only, the same
// "never a fallback literal, never a guessed ceiling" posture maxDps itself
// already has. SENSITIVITY_MIN keeps a live, if very fine, rate always
// reachable -- a "sensitivity" control that can be driven all the way to a
// dead stick would read as a broken control, not a fine one.
export const SENSITIVITY_MAX = 1;
export const SENSITIVITY_MIN = 0.05;
// The operator-facing DEFAULT (well below SENSITIVITY_MAX) -- usable for
// fine framing at a long focal length out of the box, instead of today's
// full-strength behaviour. NOT axisToRate's own parameter default below
// (that stays SENSITIVITY_MAX, so every existing caller/test that never
// mentions sensitivity keeps getting exactly today's curve->maxDps mapping,
// the same "fine/false is a no-op" convention this function's `fine` option
// already follows) -- this constant is instead passed explicitly by
// joystick-panel.js's initJoystickPanel, the actual production wiring, the
// same way DEADZONE_DEFAULT is the constructor default JoystickHold itself
// already uses. At the measured maxJogDps plateau (19 deg/s), this reaches
// ~6.7 deg/s at full deflection -- a fraction of today's ceiling, with
// FINE_MODE_FACTOR still available on top for finer framing still.
export const SENSITIVITY_DEFAULT = 0.35;

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
//
// `sensitivity` (see SENSITIVITY_DEFAULT/_MIN/_MAX above) is an overall gain
// applied AFTER the curve, clamped to [SENSITIVITY_MIN, SENSITIVITY_MAX] --
// degenerate input (negative, >1, non-finite) is clamped/defaulted rather
// than thrown or left to silently produce NaN, the same posture applyDeadzone
// already takes on its own `deadzone` argument. Defaults to SENSITIVITY_MAX,
// NOT SENSITIVITY_DEFAULT: an omitted `sensitivity` means "no opinion", so
// this function keeps producing exactly today's curve->maxDps mapping for
// every existing caller -- the same convention `fine = false` already
// establishes for this same options bag. Callers that DO want the gentler,
// operator-facing default pass SENSITIVITY_DEFAULT explicitly (joystick-
// hold.js's own `sensitivity` constructor parameter follows the identical
// split, for the identical reason -- see its doc comment).
export function axisToRate(rawValue, maxDps, { deadzone = DEADZONE_DEFAULT, fine = false, sensitivity = SENSITIVITY_MAX } = {}) {
  const safeMax = Number.isFinite(maxDps) && maxDps > 0 ? maxDps : 0;
  const safeSensitivity = Number.isFinite(sensitivity) ? clamp(sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX) : SENSITIVITY_DEFAULT;
  const shaped = applyCurve(applyDeadzone(rawValue, deadzone));
  const rate = shaped * safeMax * safeSensitivity;
  return fine ? rate * FINE_MODE_FACTOR : rate;
}

// The reachable ceiling at FULL stick deflection for a given sensitivity --
// literally axisToRate(1, maxDps, { deadzone: 0, sensitivity }) (deadzone is
// irrelevant at |value| === 1; applyDeadzone always rescales full deflection
// back to exactly +/-1, see its own doc comment above). Exposed as its own
// helper purely so joystick-panel.js's sensitivity slider can show the
// operator a real deg/s number ("resulting max rate") instead of a bare 0..1
// fraction, without duplicating axisToRate's own safe-maxDps/clamp-
// sensitivity handling.
export function maxRateForSensitivity(maxDps, sensitivity = SENSITIVITY_DEFAULT) {
  return axisToRate(1, maxDps, { deadzone: 0, sensitivity });
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
