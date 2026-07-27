// Press-and-hold jog loop: keeps the existing bounded /api/control/jog
// action (see controls.ts's "jog" case, which calls device.ts's
// jog()/setJogVector()) alive for as long as a direction is held, instead of
// requiring one click per bounded nudge.
//
// device.ts documents setJogVector as a dead-man's switch: the rig moves
// while the vector is refreshed and halts on its own once refreshes stop
// (jogVectorTtlMs, config.ts, default 500ms). This loop is the client half
// of that contract -- it re-posts on a steady cadence *comfortably inside*
// that TTL, so a browser crash, wifi drop, or tab close leaves the rig
// stopping itself rather than depending on the browser to say "stop".
//
// Pulled out of app.js (which owns the DOM/pointer/keyboard wiring) so the
// posting cadence, ramp application, and failure handling can be pinned with
// a fake poster + fake timers, without a browser -- same rationale as
// camera-panel.js.
import { jogRampDps, JOG_MIN_DPS_DEFAULT, JOG_RAMP_SECONDS_DEFAULT } from "./jog-ramp.js";

// ~3 posts/sec against the default 500ms jogVectorTtlMs -- comfortably
// inside it (never at, let alone beyond, the rate the TTL would require),
// which is the whole point: fewer requests than clicking, not more. Derived
// from jogVectorTtlMs (a fraction of it) rather than a hardcoded interval,
// so a config change to the TTL moves this with it instead of silently
// de-syncing from the dead-man it's meant to stay inside.
const JOG_HOLD_INTERVAL_FRACTION = 2 / 3;

// Exported so both the interval this loop actually uses AND a direct table
// of (ttl -> interval) pairs can be pinned without instantiating a JogHold.
export function holdIntervalMs(jogVectorTtlMs) {
  return Math.max(1, Math.floor(jogVectorTtlMs * JOG_HOLD_INTERVAL_FRACTION));
}

export class JogHold {
  // deps:
  //   post      -- async (panDps, tiltDps, durationMs) => boolean. Should
  //                wrap postControl("jog", ...) and resolve to whether the
  //                POST actually succeeded (not just whether fetch() itself
  //                didn't throw) -- see app.js's postJogVector adapter.
  //                Never expected to throw (postControl already catches),
  //                but a throw is treated as failure defensively.
  //   jogVectorTtlMs, maxJogDps -- config.ts values (mirrored client-side
  //                the same way app.js's MAX_RANGE_KM already is).
  //   jogMinDps, jogRampSeconds -- config.ts's feel-tuning knobs for the
  //                ramp (see jog-ramp.js). Unlike jogVectorTtlMs/maxJogDps,
  //                app.js keeps these live from the daemon's SSE tick
  //                (state.jog) rather than a hand-synced constant, since
  //                that's the whole point of making them configurable --
  //                default here to jog-ramp.js's own defaults so a JogHold
  //                built before the first tick (or in a test) still ramps
  //                sanely.
  //   isGated   -- () => boolean; consulted before every post, not just at
  //                start(). Mirrors applyMotionGate's `estopLatched ||
  //                sunLocked` -- an E-STOP that lands mid-hold must stop
  //                this loop from posting again, not just disable the
  //                button (which does nothing for a hold already in
  //                progress).
  //   now       -- () => number, for deterministic held-duration under fake
  //                timers in tests.
  //   onFailure -- called when the loop halts because a post failed or the
  //                gate tripped mid-hold; app.js uses this to toast.
  constructor({
    post, jogVectorTtlMs, maxJogDps,
    jogMinDps = JOG_MIN_DPS_DEFAULT, jogRampSeconds = JOG_RAMP_SECONDS_DEFAULT,
    isGated, now = () => Date.now(), onFailure,
  }) {
    this.post = post;
    this.maxJogDps = maxJogDps;
    this.jogMinDps = jogMinDps;
    this.jogRampSeconds = jogRampSeconds;
    this.isGated = isGated || (() => false);
    this.now = now;
    this.onFailure = onFailure || (() => {});
    this._intervalMs = holdIntervalMs(jogVectorTtlMs);

    this._timer = null;
    this._startedAtMs = null;
    this._direction = null; // { panMul, tiltMul }, non-null while held
  }

  get active() {
    return this._direction !== null;
  }

  // Begin jogging panMul/tiltMul (each -1/0/1, matching the existing button
  // wiring). A no-op if a hold is already active or the gate is closed --
  // app.js is responsible for only ever calling start() for the control that
  // isn't already the active hold source (see activeHoldSource there), and
  // for not calling it at all on a .disabled button; this is the second,
  // load-bearing line of defense against ever starting a gated hold.
  start(panMul, tiltMul) {
    if (this.active || this.isGated()) return;
    this._direction = { panMul, tiltMul };
    this._startedAtMs = this.now();
    void this._tick(); // post immediately, at the ramp's slow starting rate
    this._timer = setInterval(() => { void this._tick(); }, this._intervalMs);
  }

  // Release: stop the interval and post an explicit zero vector so the rig
  // halts right away rather than riding out the last pulse's duration_ms,
  // then clear ramp state so the next start() begins slow again.
  stop() {
    if (!this.active) return;
    this._clearTimer();
    this._direction = null;
    this._startedAtMs = null;
    void this.post(0, 0, 0);
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // One keep-alive pulse. Gate-checked up front (not just at start()) and
  // halted -- with no further posts -- on either a closed gate or a failed
  // POST, so neither a mid-hold E-STOP nor a lost connection can leave this
  // loop quietly still trying to command motion the operator can no longer
  // see the result of.
  async _tick() {
    if (!this.active) return;
    if (this.isGated()) { this._haltMidHold(); return; }

    const { panMul, tiltMul } = this._direction;
    const heldMs = this.now() - this._startedAtMs;
    const dps = jogRampDps(heldMs, this.maxJogDps, this.jogMinDps, this.jogRampSeconds);

    let ok = false;
    try {
      ok = await this.post(panMul * dps, tiltMul * dps, this._intervalMs);
    } catch {
      ok = false;
    }
    if (!this.active) return; // stopped (release, or a prior halt) while in flight
    if (!ok) this._haltMidHold();
  }

  // Stops the loop without sending a further command: a failed or gated
  // post must not be retried (that IS "continuing the ramp"), and there is
  // no reason a bare stop vector would land when the post that just failed
  // didn't. The server-side dead-man (the vector's TTL) brings the rig to a
  // halt on its own once posts stop arriving -- see the module comment.
  _haltMidHold() {
    this._clearTimer();
    this._direction = null;
    this._startedAtMs = null;
    this.onFailure();
  }
}
