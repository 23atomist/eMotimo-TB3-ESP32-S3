// Press-and-hold analog-stick motion loop -- the single interactive control
// path for the dashboard's on-screen virtual stick (and the arrow keys, which
// drive the same stick vector). Replaces the four-binary-button model's
// JogHold/NudgeHold pair: a stick is PROPORTIONAL, so the time-based ramps
// those classes existed for (a binary press has no "half pressed") are
// replaced by deflection-proportional output -- how far you push IS the
// throttle, in both JOG and TRIM modes.
//
// The rig-side contract is unchanged and is the load-bearing safety property:
// /api/control/jog is device.ts's setJogVector dead-man (the rig halts on its
// own once refreshes stop, jogVectorTtlMs), and every nudge is a bounded
// setpoint shift. This loop re-posts on a steady cadence comfortably inside
// that TTL while the finger is down, exactly like JogHold did; release posts
// an explicit zero vector (duration 0 = "stop now", see jog tool schema).
//
// Pure logic, no DOM: the virtual stick widget (virtual-stick.js) calls
// setVector()/release(); the keyboard wiring in app.js drives the same two
// entry points. Same injected-deps shape as the classes it replaces, so the
// cadence/gate/failure handling pins with a fake poster + fake timers.

// Trim sensitivity levels -- relocated verbatim from nudge-hold.js (same
// values, same rationale: a distant target subtends less angle per unit of
// miss, so Fine exists). With a proportional stick these are the PER-SECOND
// rate at FULL deflection (a held full-deflection trim moves the offset this
// many deg/s); half deflection is half that, which is what makes the fine
// end genuinely finer than a tap ever was.
export const TRIM_SENSITIVITY = {
  fine: { degPerSec: 0.25 },
  normal: { degPerSec: 1.0 },
  coarse: { degPerSec: 4.0 },
};
export const DEFAULT_TRIM_SENSITIVITY = "normal";

// The SAME Fine/Normal/Coarse selector also has to scale JOG, as a fraction
// of maxJogDps. It did not until now: the trim branch below consulted the
// level and the jog branch went straight to full maxJogDps, so the selector
// was visibly present and completely inert whenever the rig was not
// tracking -- every push was the rig's full ~20 deg/s plateau, reported from
// the roof as "even in fine mode, very very very fast".
//
// Fine lands near 2 deg/s at FULL deflection. That is deliberately just under
// the retired ramp's 3 deg/s floor (which the operator had raised from 1
// because 1 deg/s was imperceptible at a long focal length): 2 deg/s is the
// slowest rate that still reads as motion, and the squared response curve
// gives everything below it for partial deflection. Coarse stays the full
// plateau so repositioning is not punished.
export const JOG_SENSITIVITY = {
  fine: { fraction: 0.10 },
  normal: { fraction: 0.40 },
  coarse: { fraction: 1.0 },
};

// Trim repeat cadence. Slower than the jog keep-alive on purpose: each repeat
// is a full MCP round-trip (nudge_aim_offset), and the operator is watching a
// converging number, not chasing a live rate. (nudge-hold.js's own value.)
const TRIM_INTERVAL_MS = 200;

// ~3 posts/sec against the default 500ms jogVectorTtlMs -- comfortably inside
// it, which is the whole point: the browser half of device.ts's setJogVector
// dead-man contract must refresh strictly faster than the TTL expires.
// Derived from the TTL rather than hardcoded so a config change moves this
// with it. (Inherited verbatim from jog-hold.js, which this loop replaces.)
const JOG_HOLD_INTERVAL_FRACTION = 2 / 3;

export function holdIntervalMs(jogVectorTtlMs) {
  return Math.max(1, Math.floor(jogVectorTtlMs * JOG_HOLD_INTERVAL_FRACTION));
}

export class StickHold {
  constructor({
    // postJog(panDps, tiltDps, durationMs) => boolean -- wraps
    // postControl("jog", ...); must resolve false on failure (see
    // app.js's postJogVector adapter contract).
    // postTrim(dPanDeg, dTiltDeg) => boolean -- wraps
    // postControl("nudge-aim-offset", ...), same contract.
    postJog, postTrim,
    jogVectorTtlMs,
    maxJogDps,
    // () => boolean, consulted before EVERY post: an E-STOP/sun-lock landing
    // mid-push must stop the next tick from posting, exactly like the
    // isGated contracts it inherits from JogHold/NudgeHold.
    isGated,
    now = () => Date.now(),
    onFailure = () => {},
  }) {
    this.postJog = postJog;
    this.postTrim = postTrim;
    this.maxJogDps = maxJogDps;
    this.isGated = isGated || (() => false);
    this.now = now;
    this.onFailure = onFailure;

    this.sensitivity = DEFAULT_TRIM_SENSITIVITY;

    this._jogIntervalMs = holdIntervalMs(jogVectorTtlMs);
    this._timer = null;
    // Non-null while the finger is down: { mode: "jog"|"trim", fx, fy } --
    // fx/fy are ALREADY input-shaped fractional deflections (-1..1) from the
    // stick widget (deadzone + curve applied there, not here).
    this._vec = null;
    this._startedAtMs = null;
  }

  get active() {
    return this._vec !== null;
  }

  setSensitivity(level) {
    if (TRIM_SENSITIVITY[level]) this.sensitivity = level;
    return this.sensitivity;
  }

  // Finger down / moved. mode is "jog" | "trim" (the caller reads it off
  // Cockpit, whose aimMode() is the single source of truth -- never a local
  // copy here). A no-op while gated: the stick LOOKS held but commands
  // nothing, matching how a gated JogHold.start() behaved.
  //
  // Switching mode mid-push (tracking starts under a held stick) restarts
  // the vector cleanly rather than letting a jog rate survive into what is
  // now a tracking session -- the tracker owns the rig there, and the very
  // next tick would re-post as a trim delta anyway.
  setVector(mode, fx, fy) {
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
    const clamped = {
      fx: Math.max(-1, Math.min(1, fx)),
      fy: Math.max(-1, Math.min(1, fy)),
    };
    if (this.isGated()) return;
    if (this.active && this._vec.mode === mode) {
      this._vec.fx = clamped.fx;
      this._vec.fy = clamped.fy;
      return;
    }
    // Fresh push, or a mode flip mid-push: tear down whatever ran before.
    this.release();
    this._vec = { mode, ...clamped };
    this._startedAtMs = this.now();
    void this._tick();
    this._timer = setInterval(
      () => { void this._tick(); },
      mode === "jog" ? this._jogIntervalMs : TRIM_INTERVAL_MS,
    );
  }

  // Finger up (or blur/tab-hidden/E-STOP teardown): stop the interval and
  // post an explicit zero jog vector so the rig halts immediately instead of
  // riding out the last pulse. Safe to call repeatedly; a no-op when idle.
  // A trim path has no standing command to zero (each nudge is a completed
  // bounded shift), so no stop POST is sent there -- matching NudgeHold.
  release() {
    if (!this.active) return;
    const wasJog = this._vec.mode === "jog";
    this._clearTimer();
    this._vec = null;
    this._startedAtMs = null;
    if (wasJog) void this.postJog(0, 0, 0);
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    if (!this.active) return;
    if (this.isGated()) { this._haltMidPush(); return; }

    const { mode, fx, fy } = this._vec;
    let ok = false;
    try {
      if (mode === "jog") {
        // Screen-left/up are NEGATIVE axes; the rig's convention (see
        // cockpit.js's DIRECTIONS heritage) is positive pan = LEFT and
        // positive tilt = UP, hence the negations.
        // Deflection is the throttle, but the SELECTOR sets the ceiling that
        // full deflection reaches (see JOG_SENSITIVITY).
        const ceilingDps = this.maxJogDps * JOG_SENSITIVITY[this.sensitivity].fraction;
        ok = await this.postJog(-fx * ceilingDps, -fy * ceilingDps, this._jogIntervalMs);
      } else {
        const degPerSec = TRIM_SENSITIVITY[this.sensitivity].degPerSec * Math.max(Math.abs(fx), Math.abs(fy));
        ok = await this.postTrim(-fx * degPerSec * (TRIM_INTERVAL_MS / 1000), -fy * degPerSec * (TRIM_INTERVAL_MS / 1000));
      }
    } catch {
      ok = false;
    }
    if (!this.active) return; // released (or halted) while in flight
    if (!ok) this._haltMidPush();
  }

  // Stops the loop without a further command: a failed or gated post must
  // not be retried. The server-side dead-man (jog TTL) brings the rig to a
  // halt on its own once jog posts stop arriving -- the same guarantee the
  // classes this replaces documented and relied on.
  _haltMidPush() {
    this._clearTimer();
    this._vec = null;
    this._startedAtMs = null;
    this.onFailure();
  }
}
