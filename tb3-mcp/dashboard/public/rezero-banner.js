// Pure re-zero-pending banner text, split out so it is testable without a
// DOM -- same convention as capture-label.js's renderCaptureLabel, and the
// reason app.js stays a thin caller here instead of growing past its
// 800-line ceiling (see procedure-actions.js's own doc for that same split).
//
// Task 6 / I-C: before this, `grep -rn "rezero" dashboard/` returned
// nothing -- the operator's primary surface showed a normally calibrated rig
// while every automated motion tool refused, pan limits were gone, and sun
// protection was degraded, with none of that visible anywhere on screen.
// Four things must be learnable at a glance, with no click required: that a
// re-zero is pending, that pan limits are cleared, that sun protection (the
// sun guard) is degraded, and the remedy.
//
// state.rezero is null both pre-first-poll and on a failed get_rezero_status
// leg (see state.ts's own doc on the field) -- both read as "hide the
// banner", same collapsing-to-null convention capture-label.js's `!s` branch
// already follows for a null capture status.
//
// `remedy` is sourced from the daemon (rezeroGuard's own text, echoed
// verbatim by get_rezero_status) rather than reworded here, so the banner
// and every automated tool's own refusal message can never drift apart --
// the fallback string below is ONLY a defensive stand-in for a daemon old
// enough to report needs_rezero without a remedy field at all, never the
// normal path. SunSupervisor is deliberately NOT gated by a pending re-zero
// (rezero-tools.ts's own comment on get_rezero_status/rezeroGuard) -- naming
// that degradation here, explicitly, is the ONLY mitigation this task can
// give it.
export function renderRezeroBanner(rezero) {
  if (!rezero || !rezero.needsRezero) return { hidden: true, text: "" };
  return {
    hidden: false,
    text: "RE-ZERO PENDING — pan limits are cleared, the sun guard is degraded. " +
      (rezero.remedy || "Centre the stored landmark and call rezero_from_landmark (or rezero_from_aircraft <hex>)."),
  };
}
