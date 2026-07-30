// Press-and-hold NUDGE loop: the drift-calibration counterpart to jog-hold.js's
// JogHold. While a tracking session is active, the direction buttons drive the
// tracking SETPOINT's aim-offset (POST /api/control/nudge-aim-offset ->
// nudge_aim_offset, see src/track-tools.ts) instead of a raw jog rate — see
// app.js's startHold()/stopHold(), which pick this class or JogHold based on
// the current tracking state.
//
// Nudging is fundamentally different from jogging: a jog commands a RATE : you
// hold the button, the rig moves, you let go. A nudge shifts a SETPOINT the
// tracker's own P-controller then servos to and holds — there is no "rate" to
// ramp. So a held press here repeats a small, FIXED-size correction at a
// steady cadence, rather than jog-hold.js's ramped rate. Structured the same
// way as JogHold (post/isGated/onFailure, pure logic, no DOM/timer globals
// touched directly) so the cadence and gate/failure handling can be pinned
// with a fake poster + fake timers, without a browser.

// Small enough that a slip of the finger cannot blow through
// MAX_OFFSET_DEG's clamp (src/track/offset.ts, default 5°) in one press;
// large enough that centring a plane during a real pass (tens of seconds)
// doesn't take forever.
export const NUDGE_STEP_DEG = 0.2;
// A held press ACCELERATES: step size grows from NUDGE_STEP_DEG toward
// NUDGE_MAX_STEP_DEG over NUDGE_RAMP_MS, then holds there.
//
// The fixed 0.2°/200ms step is 1°/s. That is right for the last fraction of a
// degree, and far too slow for the first few: a rough set_north_zero seed can
// leave the plane several degrees off, and a pass lasts seconds -- the
// operator reported (2026-07-29) planes sitting "10 clicks to the left and 10
// clicks up... impossible to catch them even with the drift correction".
// Ramping keeps the tap-for-fine behaviour exactly as it was (the FIRST step
// of any press is always NUDGE_STEP_DEG) while letting a held press close a
// gross error in about a second.
export const NUDGE_MAX_STEP_DEG = 1.0;
export const NUDGE_RAMP_MS = 1200;
// Deliberately slower than jog-hold's ~333ms keep-alive cadence: each repeat
// here is a full MCP round-trip (nudge_aim_offset), not a local vector
// refresh, and the operator is watching a converging number, not chasing a
// live rate.
export const NUDGE_INTERVAL_MS = 200;

export class NudgeHold {
  // deps:
  //   post      -- async (deltaPanDeg, deltaTiltDeg) => boolean. Should wrap
  //                postControl("nudge-aim-offset", ...) and resolve to
  //                whether the POST actually succeeded, same contract as
  //                JogHold's `post`.
  //   stepDeg, intervalMs -- feel constants above; overridable for tests.
  //   isGated   -- () => boolean; consulted before every post, not just at
  //                start() -- mirrors JogHold's isGated (an E-STOP/sun-lock
  //                landing mid-hold must stop this loop from posting again).
  //   onFailure -- called when the loop halts because a post failed or the
  //                gate tripped mid-hold.
  constructor({
    post, stepDeg = NUDGE_STEP_DEG, intervalMs = NUDGE_INTERVAL_MS,
    maxStepDeg = NUDGE_MAX_STEP_DEG, rampMs = NUDGE_RAMP_MS, isGated, onFailure,
  }) {
    this.maxStepDeg = maxStepDeg;
    this.rampMs = rampMs;
    this._heldSteps = 0;
    this.post = post;
    this.stepDeg = stepDeg;
    this.intervalMs = intervalMs;
    this.isGated = isGated || (() => false);
    this.onFailure = onFailure || (() => {});

    this._timer = null;
    this._direction = null; // { panMul, tiltMul }, non-null while held
  }

  get active() {
    return this._direction !== null;
  }

  // Begin nudging panMul/tiltMul (each -1/0/1, matching JogHold's/the
  // existing button wiring). A no-op if a hold is already active or the gate
  // is closed -- same defense-in-depth contract as JogHold.start().
  start(panMul, tiltMul) {
    if (this.active || this.isGated()) return;
    this._direction = { panMul, tiltMul };
    this._heldSteps = 0; // reset the ramp: every press starts fine
    void this._tick(); // apply one step immediately on press
    this._timer = setInterval(() => { void this._tick(); }, this.intervalMs);
  }

  // Release: stop the repeat interval. Unlike JogHold.stop(), there is no
  // "post a zero vector" — a nudge has no standing rate to cancel, only a
  // setpoint that stays exactly where the last accepted nudge left it.
  stop() {
    if (!this.active) return;
    this._clearTimer();
    this._direction = null;
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // One repeat step. Gate-checked up front (not just at start()) and halted
  // on either a closed gate or a failed POST, matching JogHold's _tick().
  async _tick() {
    if (!this.active) return;
    if (this.isGated()) { this._haltMidHold(); return; }

    const { panMul, tiltMul } = this._direction;
    const step = this._stepForHeldMs(this._heldSteps * this.intervalMs);
    this._heldSteps += 1;
    let ok = false;
    try {
      ok = await this.post(panMul * step, tiltMul * step);
    } catch {
      ok = false;
    }
    if (!this.active) return; // stopped (release, or a prior halt) while in flight
    if (!ok) this._haltMidHold();
  }

  // Linear ramp from stepDeg to maxStepDeg over rampMs. Linear rather than
  // jog-ramp.js's curve because a nudge moves a SETPOINT, not a rate: the
  // operator is watching a number converge, and a predictable step is easier
  // to stop on than an accelerating one.
  _stepForHeldMs(heldMs) {
    if (this.maxStepDeg <= this.stepDeg || this.rampMs <= 0) return this.stepDeg;
    const t = Math.max(0, Math.min(1, heldMs / this.rampMs));
    return this.stepDeg + (this.maxStepDeg - this.stepDeg) * t;
  }

  _haltMidHold() {
    this._clearTimer();
    this._direction = null;
    this.onFailure();
  }
}
