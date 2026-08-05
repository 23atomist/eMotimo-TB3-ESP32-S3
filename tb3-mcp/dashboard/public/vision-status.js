// Pure vision-lock status line -- split out so it is testable without a DOM,
// same rationale as capture-label.js/ui-mode.js. Returns a plain STRING (not
// capture-label.js's {text,cls} pair): test/dashboard-vision-status.test.ts
// asserts against the return value with `.toMatch`, and a one-line status
// has no natural "state class" the way capture-label.js's REC/ERROR/skip
// chip does -- cockpit.js is free to wrap it in whatever element it likes.
//
// THE OUTCOME MATTERS MORE THAN THE CORRECTION. An operator watching a bare
// "pan +0.4 tilt -0.2" learns nothing when the real story is
// "none_near_prediction" -- the detector IS finding something in frame, just
// not where ADS-B says the aircraft should be. A silent zero (or a raw
// number with no context) hides exactly that distinction. So every outcome
// VisionCorrector/gateDetections can return (src/vision/corrector.ts,
// src/vision/gate.ts) gets its own line below, never collapsed into a
// generic "no correction" -- including the ones that never carry a
// pan/tilt correction at all (no_frame, no_posture, ...).
const OUTCOME_TEXT = {
  applied: (v) => `corrected pan ${fmtDeg(v.panDeg)} tilt ${fmtDeg(v.tiltDeg)}`,
  read_only: (v) => `would correct pan ${fmtDeg(v.panDeg)} tilt ${fmtDeg(v.tiltDeg)} (not applied)`,
  no_frame: () => "no frame from the camera",
  // Fix B (C3): a frozen upstream stream keeps re-serving the same frame
  // forever -- these two distinguish "camera pipe genuinely stalled" (stale)
  // from "tick ran again before a new frame arrived" (duplicate, routine at
  // a tick rate close to the camera's own frame rate) from a hard "no
  // frame at all" (no_frame, above).
  frame_stale: () => "camera frame too old (see get_vision_status -- the upstream stream may be stalled)",
  frame_duplicate: () => "same camera frame as last tick, not re-processed",
  // A common, EXPECTED bring-up state -- not a bug. If the calibrated
  // latencyMs (calibrate_vision_scale) lands below one telemetry period
  // (the rig's telemetry is 5Hz / 200ms), PostureHistory has nothing to
  // interpolate at the requested exposure time and this fires on most
  // ticks. It fails closed (no correction applied, safe) but can make the
  // loop look dead. See this task's acceptance procedure (task-9-report.md)
  // for why relaxing the posture lookup is a deliberate non-fix, not
  // something to change on the roof.
  no_posture: () => "no rig posture at exposure time (see get_vision_status -- a known bring-up case, not a bug)",
  no_prediction: () => "not tracking (or target stale) -- no predicted position to gate against",
  no_scale: () => "not calibrated -- run calibrate_vision_scale",
  detector_unavailable: () => "detector unreachable",
  no_candidates: () => "no detections in frame",
  none_near_prediction: () => "detections found, none near the prediction",
  ambiguous: () => "multiple detections near the prediction (ambiguous)",
  over_sanity_bound: () => "correction exceeded the sanity bound, rejected",
};

function fmtDeg(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}°` : "?";
}

// v: { enabled, readOnly, lastOutcome, panDeg, tiltDeg } -- panDeg/tiltDeg
// are the last APPLIED-OR-WOULD-APPLY correction (null whenever the last
// tick didn't reach that point, e.g. no_frame/no_posture/none_near_prediction).
export function renderVisionStatus(v) {
  // Disabled always wins, regardless of a stale lastOutcome/correction from
  // before it was turned off -- a leftover "applied" must never look live.
  if (!v || !v.enabled) return "Vision: OFF";
  const mode = v.readOnly ? "OBSERVING (read-only)" : "ACTIVE";
  const describe = v.lastOutcome ? OUTCOME_TEXT[v.lastOutcome] : undefined;
  // An outcome string this module doesn't recognise (a future addition to
  // CorrectorOutcome) still shows up verbatim rather than silently reading
  // as "no ticks yet" -- the whole point here is never to hide a real signal.
  const detail = describe ? describe(v) : (v.lastOutcome ? `outcome: ${v.lastOutcome}` : "no ticks yet");
  return `Vision: ${mode} — ${detail}`;
}
