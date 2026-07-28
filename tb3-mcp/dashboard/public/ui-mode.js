// PURE: what mode the UI is in, derived ONLY from daemon state.
//
// No local flags: a local "am I tracking?" boolean can drift out of sync with
// the rig, and a control whose label disagrees with what it actually does is
// how an operator wastes a pass -- or worse, jogs when they meant to trim.

export function aimMode(state) {
  const s = state || {};
  if (s.estopLatched === true || s.sunLocked === true) return "locked";
  const t = (s.tracking && s.tracking.state) || "stopped";
  // "acquiring" counts as trim: the tracker owns the rig the moment it starts
  // slewing, so a raw jog would just be overwritten on the next tick.
  return t === "tracking" || t === "acquiring" || t === "waiting" ? "trim" : "jog";
}

export function calibrationBadge(state) {
  const cal = (state && state.calibration) || {};
  if (cal.calibrated === true) return { text: "CALIBRATED", cls: "badge-calibrated" };
  if (cal.provisional === true) return { text: "PROVISIONAL", cls: "badge-provisional" };
  return { text: "UNCALIBRATED", cls: "badge-uncalibrated" };
}
