// USB joystick / gamepad control loop, the third sibling of jog-hold.js's
// JogHold and nudge-hold.js's NudgeHold: same DI shape (post callbacks,
// isGated, onFailure), same "pure logic lives elsewhere, this class is only
// the stateful wiring" split, but driven by the browser's Gamepad API
// instead of a pressed/held button.
//
// Why a joystick at all: the operator calibrates by watching a plane in the
// video feed and trimming until it centres -- eyes on the plane, not the
// dashboard. A proportional stick lets them trim by thumb feel instead of
// reaching for on-screen buttons, and removes the need for jog-ramp.js's
// speed ramp entirely: with a stick, DEFLECTION IS THE RATE (see
// joystick-math.js's axisToRate), so there is nothing to ramp up over held
// duration the way a binary button press needs.
//
// The Gamepad API is poll-based (no "axis moved" event) -- navigator.
// getGamepads() must be read on a loop. This class owns that loop as a
// plain setInterval, at a FIXED, MODEST cadence (POLL_INTERVAL_MS, ~10Hz),
// deliberately not requestAnimationFrame: the brief that asked for this is
// explicit that an earlier version of this dashboard caused connection
// failures by firing unbounded per-frame request bursts, and this control
// loop both reads the pad AND posts commands on every tick, so the poll
// cadence IS the post cadence -- bounding one bounds the other for free,
// with no separate throttle to keep in sync.
//
// Field report ("stuttery even while holding the stick steady"): the
// original version of this loop also used the poll interval as the JOG
// vector's duration_ms on every post, so each burst of commanded motion was
// scheduled to expire EXACTLY when the next post was due -- any network
// jitter, event-loop scheduling delay, or GC pause meant the rig finished
// its motion and sat still until the next post landed. The fix decouples
// the two: the poll/post CADENCE stays ~10Hz (pollIntervalMs, for
// responsiveness and to keep this a bounded, predictable loop per the
// brief above), but the commanded DURATION (jogDurationMs) is comfortably
// longer than that cadence -- close to, but always strictly under,
// jogVectorTtlMs -- so each new post EXTENDS motion the rig is already
// executing instead of racing an about-to-expire one. Both are pure
// functions of jogVectorTtlMs (see their doc comments below), the same
// "derive it, don't hardcode it" precedent jog-hold.js's holdIntervalMs
// already established for the press-and-hold ramp. If posting stops for
// any reason, the rig still halts within jogVectorTtlMs -- the dead-man
// margin is unchanged.
//
// Safety posture (see the module's design brief):
//   - Deadzone + curve are applied by joystick-math.js's axisToRate before
//     any rate ever reaches a post() call -- a stick at rest, or a hair off
//     rest, commands exactly zero, never a silent creep.
//   - isGated (the same estopLatched||sunLocked gate JogHold/NudgeHold use)
//     is checked every tick, not just once -- an E-STOP that lands mid-drive
//     stops this loop from posting again on its very next tick.
//   - Every one of "gamepaddisconnected", window blur, visibilitychange to
//     hidden, and this loop stopping for any reason (an internal throw, or
//     destroy()) routes through the same haltDrive() -- see its doc comment.
//   - The E-STOP combo and the sight button are edge-detected (fire once per
//     press, via joystick-math.js's risingEdge), never level-detected -- a
//     held button must not repeat-fire an action every ~100ms tick.
//   - This never bypasses jog/nudge/E-STOP's own server-side gating (pan/
//     tilt limits, sun guard, the aim-offset clamp): it is just another
//     caller of the exact same POST paths the on-screen buttons use.
import {
  DEADZONE_DEFAULT, SENSITIVITY_MAX, axisToRate, selectMode, MODE_TRIM,
  risingEdge, isPressed, allPressed,
} from "./joystick-math.js";

// jogVectorTtlMs's default (config.ts) -- mirrored here the same way
// jog-hold.js/app.js mirror it, purely so this module's own exported
// defaults (POLL_INTERVAL_MS below) are self-consistent without a live
// config value.
const JOG_VECTOR_TTL_MS_DEFAULT = 500;

// Fraction of jogVectorTtlMs used for the poll/post cadence: ~10Hz at the
// default 500ms TTL (Math.floor(500 * 1/5) = 100) -- "enough for responsive
// feel, bounded and predictable" per the module brief, and preserves this
// loop's existing, already-tuned cadence at that default. Expressed as a
// function of jogVectorTtlMs (not a bare hardcoded number) so a TTL config
// change moves it, the same "derive it" precedent as jog-hold.js's
// holdIntervalMs.
const JOG_POLL_INTERVAL_FRACTION = 1 / 5;
export function pollIntervalMs(jogVectorTtlMs) {
  return Math.max(1, Math.floor(jogVectorTtlMs * JOG_POLL_INTERVAL_FRACTION));
}

// The commanded JOG vector's duration_ms on every post. Deliberately NOT
// equal to pollIntervalMs (that equality was the stutter bug -- see the
// module doc above): instead this is comfortably longer than the poll
// interval, so each new post overlaps and extends motion that's already in
// flight, while staying strictly under jogVectorTtlMs so the dead-man still
// applies if posting stops for any reason (a dropped connection, a closed
// tab, a crashed tab) -- the margin between this and the TTL is exactly one
// poll interval, i.e. even a single dropped/delayed post cannot make the
// commanded motion outlive the TTL.
export function jogDurationMs(jogVectorTtlMs) {
  const interval = pollIntervalMs(jogVectorTtlMs);
  const ttl = Math.floor(jogVectorTtlMs);
  return Math.max(interval + 1, ttl - interval);
}

// ~10Hz at the default jogVectorTtlMs (500ms): "enough for responsive feel,
// bounded and predictable" per the module brief. Kept as a named export
// (still equal to the historical 100) for backward compatibility with
// existing callers/tests that reference it directly as the DEFAULT poll
// cadence; a JoystickHold constructed with a non-default jogVectorTtlMs
// uses pollIntervalMs(jogVectorTtlMs) instead (see the constructor below).
export const POLL_INTERVAL_MS = pollIntervalMs(JOG_VECTOR_TTL_MS_DEFAULT);

// Default button/axis mapping for a browser "standard" gamepad layout
// (https://www.w3.org/TR/gamepad/#remapping). Exported (not just used
// internally) so app.js's live-input display and this file's own tests
// reference the exact same indices the control loop acts on -- a mapping
// documented in a UI label that quietly drifted from the code that reads it
// would be exactly the "mysterious wrong guess" the live display exists to
// prevent.
export const PAN_AXIS_INDEX = 0;  // left stick X
export const TILT_AXIS_INDEX = 1; // left stick Y
export const SIGHT_BUTTON_INDEX = 0;       // "A" / bottom face button
export const FINE_BUTTON_INDEX = 7;        // right trigger ("RT"/"R2")
export const ESTOP_BUTTON_INDICES = [8, 9]; // Back/Select + Start, TOGETHER

// Standard Gamepad API convention: pushing the stick LEFT reports a
// NEGATIVE x, pushing it UP reports a NEGATIVE y. The existing direction-
// button cluster's convention is the opposite sign for both (see app.js's
// JOG_SOURCES: jog-left => panMul: +1, jog-up => tiltMul: +1 -- "left/right
// were reversed vs. the camera view" per that file's own comment). These
// constants make the joystick agree with the buttons it is a drop-in
// alternative for, rather than silently inverting them.
const PAN_SIGN = -1;
const TILT_SIGN = -1;

function defaultGetGamepads() {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  return navigator.getGamepads() || [];
}

// The first connected pad, by index -- multiple simultaneous controllers are
// out of scope (the rig has one operator).
function readFirstGamepad(getGamepads) {
  let pads;
  try { pads = getGamepads(); } catch { pads = null; }
  if (!pads) return null;
  for (const gp of pads) {
    if (gp) return gp;
  }
  return null;
}

export class JoystickHold {
  // deps:
  //   getGamepads     -- () => (Gamepad|null)[], defaults to
  //                       navigator.getGamepads(). Injected so this is
  //                       testable without a browser or physical controller.
  //   postJog         -- async (panDps, tiltDps, durationMs) => boolean.
  //                       Same contract as JogHold's `post` -- app.js passes
  //                       its existing postJogVector adapter, so this drives
  //                       the exact same /api/control/jog path the buttons
  //                       do (see the module doc's "never a third way").
  //   postNudge       -- async (deltaPanDeg, deltaTiltDeg) => boolean. Same
  //                       contract as NudgeHold's `post` -- app.js passes
  //                       its existing postNudgeVector adapter.
  //   onSight         -- () => void, fires the "mark a sighting" action
  //                       (app.js's sightTrackedAircraft, the same one the
  //                       "Sight it" button calls) for the currently
  //                       selected aircraft.
  //   onEstop         -- () => void, fires E-STOP (app.js's doEstop). Never
  //                       gated by isGated/isSightGated -- E-STOP must
  //                       always be reachable, including to clear the very
  //                       lock it engages.
  //   isTrackingActive-- () => boolean, app.js's `() => trackingActive`.
  //   isGated         -- () => boolean, the motion gate (estopLatched ||
  //                       sunLocked) -- identical condition to JogHold/
  //                       NudgeHold's isGated.
  //   isSightGated    -- () => boolean, the calibration-writes gate for
  //                       sighting -- matches sightGateOk's own union
  //                       (procedure-actions.js) and app.js's wiring of this
  //                       parameter: estopLatched||sunLocked, the same
  //                       combined gate as isGated above. sight_aircraft
  //                       commands no motion, but is NOT harmless under
  //                       E-STOP (a halted slew may no longer be centred on
  //                       the target) or under a sun lock (the guard may
  //                       have already parked the rig) -- see the drawer's
  //                       [Sight it] strip for the identical reasoning.
  //   getMaxJogDps    -- () => number, the LIVE config value (config.ts's
  //                       maxJogDps). app.js passes `() => jogHold.
  //                       maxJogDps`, reusing the exact value applyJogConfig
  //                       already keeps current from the daemon's SSE tick
  //                       -- see joystick-math.js's axisToRate doc for why
  //                       this must be live, not a hand-copied constant.
  //   onSnapshot      -- (snapshot) => void, called every poll tick with
  //                       `{ connected, id, axes, buttons }` (buttons as
  //                       `{pressed, value}[]`) so app.js's live-input
  //                       display can render whatever the controller
  //                       actually reports -- independent of whether
  //                       anything was gated/posted this tick.
  //   onFailure       -- () => void, called the first time this loop halts
  //                       driving (a failed post, or the gate closing while
  //                       deflected) -- see haltAndLatch()'s doc comment for
  //                       why this fires once per episode, not once per
  //                       tick.
  //   jogVectorTtlMs  -- config.ts's dead-man TTL (mirrored client-side the
  //                       same way jog-hold.js/app.js already do). Source
  //                       for BOTH derived defaults below when intervalMs
  //                       isn't given explicitly -- see pollIntervalMs/
  //                       jogDurationMs's doc comments.
  //   intervalMs      -- poll/post cadence; defaults to
  //                       pollIntervalMs(jogVectorTtlMs) (~10Hz at the
  //                       default TTL, i.e. POLL_INTERVAL_MS). An explicit
  //                       override is honoured as-is (tests use this), but
  //                       app.js leaves it derived.
  //   deadzone        -- initial deadzone fraction; defaults to
  //                       joystick-math.js's DEADZONE_DEFAULT. A plain
  //                       mutable property (not a getter callback) because
  //                       the live-display's deadzone input writes to it
  //                       directly, the same way jogHold.maxJogDps is
  //                       written by applyJogConfig.
  //   sensitivity     -- initial overall-gain fraction (see joystick-math.js's
  //                       axisToRate); defaults to SENSITIVITY_MAX (1, i.e.
  //                       no extra damping beyond the curve above), so any
  //                       existing caller/test that constructs a JoystickHold
  //                       without an opinion on feel keeps getting exactly
  //                       today's curve->maxDps mapping -- the identical
  //                       "neutral default here, real product default passed
  //                       explicitly by the actual caller" split axisToRate's
  //                       own `sensitivity` parameter uses. joystick-panel.js's
  //                       initJoystickPanel -- the real production wiring --
  //                       passes SENSITIVITY_DEFAULT explicitly instead (see
  //                       its own doc), the same way it relies on this
  //                       constructor's OWN default for `deadzone` rather
  //                       than repeating DEADZONE_DEFAULT itself; sensitivity
  //                       needs the explicit pass BECAUSE its neutral and
  //                       product defaults intentionally differ (deadzone's
  //                       do not). A plain mutable property for the same
  //                       reason as deadzone above -- the live slider writes
  //                       to it directly, and it must take effect on the very
  //                       next poll tick, no restart.
  constructor({
    getGamepads = defaultGetGamepads,
    postJog, postNudge, onSight, onEstop,
    isTrackingActive, isGated, isSightGated,
    getMaxJogDps,
    onSnapshot, onFailure,
    jogVectorTtlMs = JOG_VECTOR_TTL_MS_DEFAULT,
    intervalMs,
    deadzone = DEADZONE_DEFAULT,
    sensitivity = SENSITIVITY_MAX,
  }) {
    this.getGamepads = getGamepads;
    this.postJog = postJog;
    this.postNudge = postNudge;
    this.onSight = onSight || (() => {});
    this.onEstop = onEstop || (() => {});
    this.isTrackingActive = isTrackingActive || (() => false);
    this.isGated = isGated || (() => false);
    this.isSightGated = isSightGated || (() => false);
    this.getMaxJogDps = getMaxJogDps || (() => 0);
    this.onSnapshot = onSnapshot || (() => {});
    this.onFailure = onFailure || (() => {});
    this.jogVectorTtlMs = jogVectorTtlMs;
    this.intervalMs = intervalMs !== undefined ? intervalMs : pollIntervalMs(jogVectorTtlMs);
    // The JOG vector's duration_ms on every post -- see jogDurationMs's doc
    // comment. Derived once from jogVectorTtlMs at construction, same
    // lifecycle as this.intervalMs above (both are effectively fixed for
    // the life of this loop, like JogHold's this._intervalMs).
    this._jogDurationMs = jogDurationMs(jogVectorTtlMs);
    this.deadzone = deadzone; // public, mutable -- see doc above.
    this.sensitivity = sensitivity; // public, mutable -- see doc above.

    this._timer = null;
    this._prevButtons = [];       // previous poll's pressed[] -- edge detection
    this._prevEstopCombo = false;
    this._jogActive = false;      // true once a non-zero JOG vector has been posted
    this._failedLatch = false;    // see haltAndLatch()'s doc comment
  }

  get running() {
    return this._timer !== null;
  }

  start() {
    if (this._timer !== null) return;
    void this._tick(); // read/act immediately, matching JogHold.start()'s convention
    this._timer = setInterval(() => { void this._tick(); }, this.intervalMs);
  }

  // Fully tears the loop down. Not part of normal operation (the joystick
  // is meant to poll for the lifetime of the page, the same way
  // connectStream()'s EventSource does) -- provided for test teardown and as
  // the "the polling loop stopping for any reason" case the safety brief
  // calls out by name, so that case has a concrete, callable, testable
  // implementation rather than being purely aspirational.
  destroy() {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
    this.haltDrive();
  }

  // The explicit stop, called from every one of the four loss-of-control
  // triggers named in the safety brief: window blur, visibilitychange to
  // hidden, gamepaddisconnected, and destroy()/an internal tick failure.
  // A no-op unless a non-zero JOG rate was actually in flight -- TRIM has no
  // standing rate to cancel (matching NudgeHold.stop()'s identical
  // no-further-post choice: a nudge only ever shifts a setpoint, it never
  // leaves something "running" that needs zeroing).
  //
  // Note this is a belt-and-braces immediacy measure, not the sole safety
  // net: device.ts's jog() tool already self-terminates (explicit
  // clearJog()) at the end of whatever duration_ms it was last posted with
  // (jogDurationMs(jogVectorTtlMs) here -- always strictly under the TTL,
  // see that function's doc comment) even if this class posts nothing
  // further at all, so the worst case for a bug in this method is a stale
  // rate for at most one more commanded duration, still bounded by the TTL,
  // not an unbounded runaway.
  haltDrive() {
    if (this._jogActive) {
      this._jogActive = false;
      void this.postJog(0, 0, 0);
    }
  }

  // Wired by app.js to window's "gamepadconnected"/"gamepaddisconnected".
  // Connection needs no special handling -- the very next poll tick reads
  // the newly-present pad on its own -- kept as a named, callable method
  // only for symmetry with handleDisconnected and so app.js has something
  // concrete to attach.
  handleConnected() {}

  // A gamepad vanishing mid-drive (unplugged, battery dead, OS drops
  // Bluetooth) must not leave a stale rate commanded until the next poll
  // happens to notice -- stop immediately rather than waiting up to
  // intervalMs for _tick's own "no pad found" branch to reach the same
  // conclusion.
  handleDisconnected() {
    this.haltDrive();
  }

  // Halts driving AND latches this loop off until the stick returns to
  // centre -- the continuous-polling equivalent of JogHold's "a failed or
  // gated post must not be retried" (see jog-hold.js's _haltMidHold doc).
  // JogHold expresses that as "requires a fresh start() (a new button
  // press)"; a stick has no discrete press to wait for, so recentring (the
  // next tick where BOTH axes read back inside the deadzone) is the
  // equivalent deliberate re-arm signal instead of retrying every ~100ms
  // against a gate or a server that's still down. onFailure fires exactly
  // once per newly-latched episode (guarded by _failedLatch), not once per
  // tick for as long as the stick stays deflected against a closed gate --
  // otherwise a toast-per-poll would spam the operator the entire time an
  // E-STOP is latched and they're still holding the stick over.
  _haltAndLatch() {
    this.haltDrive();
    if (!this._failedLatch) {
      this._failedLatch = true;
      this.onFailure();
    }
  }

  _buildSnapshot(gp) {
    if (!gp) return { connected: false, id: null, axes: [], buttons: [] };
    return {
      connected: true,
      id: gp.id || null,
      axes: Array.prototype.slice.call(gp.axes || []),
      buttons: Array.prototype.map.call(gp.buttons || [], (b) => ({
        pressed: !!(b && b.pressed),
        value: b && typeof b.value === "number" ? b.value : 0,
      })),
    };
  }

  async _tick() {
    try {
      const gp = readFirstGamepad(this.getGamepads);
      this.onSnapshot(this._buildSnapshot(gp));

      if (!gp) {
        // No controller connected (or just disconnected and this tick got
        // there first) -- stop driving, and reset edge-detection/failure
        // state so a later reconnect starts clean rather than diffing
        // against a stale press or a stale latch from before the gap.
        this.haltDrive();
        this._prevButtons = [];
        this._prevEstopCombo = false;
        this._failedLatch = false;
        return;
      }

      const buttons = Array.prototype.map.call(gp.buttons || [], (b) => !!(b && b.pressed));

      // E-STOP combo: level-tested (both held) then edge-fired (once per
      // press-together), evaluated BEFORE the motion gate and unconditional
      // on it -- E-STOP must fire even while already latched (clearing it
      // is a separate, deliberate action) or while sun-locked; it must never
      // be gate-able by the very thing it exists to override.
      const comboNow = allPressed(buttons, ESTOP_BUTTON_INDICES);
      if (risingEdge(this._prevEstopCombo, comboNow)) this.onEstop();
      this._prevEstopCombo = comboNow;

      // Mark-a-sighting: edge-fired, gated the same as the on-screen
      // "Sight it" button and the aircraft-row [Sight] button --
      // estopLatched||sunLocked (see isSightGated's own doc comment above;
      // app.js wires this parameter to that exact union, matching
      // sightGateOk in procedure-actions.js).
      const sightNow = isPressed(buttons, SIGHT_BUTTON_INDEX);
      if (risingEdge(this._prevButtons[SIGHT_BUTTON_INDEX], sightNow) && !this.isSightGated()) {
        this.onSight();
      }
      this._prevButtons = buttons;

      const fine = isPressed(buttons, FINE_BUTTON_INDEX);
      const maxDps = this.getMaxJogDps();
      const rawPan = typeof gp.axes[PAN_AXIS_INDEX] === "number" ? gp.axes[PAN_AXIS_INDEX] : 0;
      const rawTilt = typeof gp.axes[TILT_AXIS_INDEX] === "number" ? gp.axes[TILT_AXIS_INDEX] : 0;
      const panRate = PAN_SIGN * axisToRate(rawPan, maxDps, { deadzone: this.deadzone, fine, sensitivity: this.sensitivity });
      const tiltRate = TILT_SIGN * axisToRate(rawTilt, maxDps, { deadzone: this.deadzone, fine, sensitivity: this.sensitivity });
      const deflected = panRate !== 0 || tiltRate !== 0;

      if (!deflected) {
        // Centred: the deliberate re-arm signal for a prior failure/gate
        // latch (see _haltAndLatch's doc), and the normal "stop posting
        // when centred" case from the safety brief -- either way, nothing
        // further to command this tick.
        this._failedLatch = false;
        this.haltDrive();
        return;
      }

      if (this._failedLatch) return; // still latched off; wait for centre.

      if (this.isGated()) { this._haltAndLatch(); return; }

      const mode = selectMode(this.isTrackingActive());
      let ok;
      if (mode === MODE_TRIM) {
        const dtSec = this.intervalMs / 1000;
        ok = await this.postNudge(panRate * dtSec, tiltRate * dtSec);
      } else {
        this._jogActive = true;
        // this._jogDurationMs, NOT this.intervalMs -- see the module doc's
        // "field report" note and jogDurationMs's own doc comment for why
        // commanding a duration equal to the poll interval was the stutter
        // bug this replaces.
        ok = await this.postJog(panRate, tiltRate, this._jogDurationMs);
      }
      if (!ok) this._haltAndLatch();
    } catch {
      this._haltAndLatch();
    }
  }
}
