// Speed ramp for press-and-hold jogging. Pulled out as a pure function of
// held-duration (rather than inlined in the hold loop) so it is testable
// without a timer or a browser -- same rationale as camera-mode.js's
// pickCameraMode.
//
// The operator's original complaint was "3 speeds... it's more like micro
// micro-ish and race car": a coarse click moved too far to frame precisely,
// a fine click barely moved at all. A ramp replaces the presets: start slow
// enough for fine framing, then ease up to the rig's full jog rate the
// longer the button stays down, so one press can both nudge a hair and
// sweep across the sky without the operator ever having to pick a speed
// first.
//
// Follow-up feedback from real hardware: the first cut of this ramp (2 deg/s
// up to maxJogDps over ~1.5s) still accelerated faster than a shot could be
// framed -- the useful fine-control window was too short. jogMinDps/
// jogRampSeconds (config.ts) make the floor and duration tunable without a
// code edit per iteration; JOG_MIN_DPS_DEFAULT/JOG_RAMP_SECONDS_DEFAULT below
// mirror config.ts's own defaults so this module behaves sanely even before
// a config value has reached it (see app.js's applyJogConfig).
//
// minDps is an absolute floor, independent of maxDps: "slow enough to frame
// with" doesn't get faster just because the site raises its jog ceiling.
// rampSeconds is how long the ease-in takes to reach maxDps. The exponent
// shapes the curve so it eases in gently (slow at first, not a straight
// ramp) for ANY maxDps/minDps/rampSeconds -- no checkpoint speed is
// hardcoded, so the shape generalizes across whatever those are configured to.
export const JOG_MIN_DPS_DEFAULT = 1;
export const JOG_RAMP_SECONDS_DEFAULT = 4;
const JOG_RAMP_EXPONENT = 1.3;

// heldMs: milliseconds the button/key has been held (0 at the moment of
// press). maxDps: the configured ceiling (config.ts's maxJogDps) -- the
// curve always clamps to it, so a bad/absurd heldMs (negative, NaN,
// Infinity) can never command more than the rig's real jog ceiling.
// minDps/rampSeconds: config.ts's jogMinDps/jogRampSeconds. Both are
// independently guarded so a degenerate value (minDps above maxDps, a
// zero/negative/non-finite rampSeconds) still produces a sane, non-NaN rate
// clamped to [0, maxDps] rather than propagating the bad input.
export function jogRampDps(heldMs, maxDps, minDps = JOG_MIN_DPS_DEFAULT, rampSeconds = JOG_RAMP_SECONDS_DEFAULT) {
  if (!(maxDps > 0)) return 0;
  const floor = Number.isFinite(minDps) ? Math.max(minDps, 0) : JOG_MIN_DPS_DEFAULT;
  const start = Math.min(floor, maxDps); // clamps jogMinDps > maxJogDps down to the ceiling
  if (!(heldMs > 0)) return start; // covers 0, negative, and NaN (NaN > 0 is false)
  // A non-positive/non-finite rampSeconds can't be divided by directly (it
  // would produce Infinity/NaN below) -- fall back to the default duration
  // rather than let a bad config value kill the control.
  const safeRampSeconds = Number.isFinite(rampSeconds) && rampSeconds > 0 ? rampSeconds : JOG_RAMP_SECONDS_DEFAULT;
  const rampMs = safeRampSeconds * 1000;
  const t = Math.min(heldMs, rampMs) / rampMs; // clamped to [0, 1]
  const dps = start + (maxDps - start) * Math.pow(t, JOG_RAMP_EXPONENT);
  return Math.min(dps, maxDps);
}
