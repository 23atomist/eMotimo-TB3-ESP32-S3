// Speed ramp for press-and-hold jogging. Pulled out as a pure function of
// held-duration (rather than inlined in the hold loop) so it is testable
// without a timer or a browser -- same rationale as camera-mode.js's
// pickCameraMode.
//
// The operator's complaint was "3 speeds... it's more like micro micro-ish
// and race car": a coarse click moved too far to frame precisely, a fine
// click barely moved at all. A ramp replaces the presets: start slow enough
// for fine framing, then ease up to the rig's full jog rate the longer the
// button stays down, so one press can both nudge a hair and sweep across the
// sky without the operator ever having to pick a speed first.
//
// JOG_RAMP_START_DPS is an absolute floor, independent of maxDps: "slow
// enough to frame with" doesn't get faster just because the site raises its
// jog ceiling. JOG_RAMP_MS is how long the ease-in takes to reach maxDps.
// The exponent shapes the curve so it passes close to ~2/~6/~12 dps at
// 0/500/1000 ms against the default maxJogDps of 19 (see config.ts) before
// reaching 19 at 1500ms -- a gentle ease-in, not a straight ramp, so the
// first couple hundred ms (the part doing the fine-framing work) stays slow.
export const JOG_RAMP_START_DPS = 2;
export const JOG_RAMP_MS = 1500;
const JOG_RAMP_EXPONENT = 1.3;

// heldMs: milliseconds the button/key has been held (0 at the moment of
// press). maxDps: the configured ceiling (config.ts's maxJogDps) -- the
// curve always clamps to it, so a bad/absurd heldMs (negative, NaN,
// Infinity) can never command more than the rig's real jog ceiling.
export function jogRampDps(heldMs, maxDps) {
  if (!(maxDps > 0)) return 0;
  const start = Math.min(JOG_RAMP_START_DPS, maxDps);
  if (!(heldMs > 0)) return start; // covers 0, negative, and NaN (NaN > 0 is false)
  const t = Math.min(heldMs, JOG_RAMP_MS) / JOG_RAMP_MS; // clamped to [0, 1]
  const dps = start + (maxDps - start) * Math.pow(t, JOG_RAMP_EXPONENT);
  return Math.min(dps, maxDps);
}
