// Pure label logic, split out so it is testable without a DOM.
//
// Ordering is deliberate and load-bearing, in two directions:
//
// 1. lastError and lastSkipReason stay AHEAD of `recording`. A failure must
//    never be masked by a healthy-looking state -- this dashboard has already
//    once shown a green REC while the rig wrote zero photos, and those two
//    checks are what stop it recurring. Do not move `recording` above them.
//
// 2. `recording` sits ahead of `!autoEnabled`. The old order returned OFF
//    before ever reading `recording`, which encoded "auto capture is the only
//    way anything gets written". The dashboard's manual [Record] button
//    falsified that: setRecording() sets `recording` unconditionally and does
//    not consult `auto` (src/capture/controller.ts), so the chip could read
//    "Capture: OFF" while the rig was actively recording. `recording` true
//    with both lastError and lastSkipReason null IS the writing case, so it
//    is what the operator needs to see.
//
// AUTO OFF (not OFF) names what is actually off: the auto-arm policy, not
// capture as a whole. `set_capture_mode` is what toggles it.
export function renderCaptureLabel(s) {
  if (!s) return { text: "Capture: —", cls: "capture-unknown" };
  if (s.lastError) return { text: "Capture: ERROR", cls: "capture-error" };
  if (s.lastSkipReason) return { text: "Capture: skipped (disarmed)", cls: "capture-skip" };
  if (s.recording) return { text: "Capture: REC " + (s.passIcao || ""), cls: "capture-rec" };
  if (!s.autoEnabled) return { text: "Capture: AUTO OFF", cls: "capture-off" };
  return { text: "Capture: ready", cls: "capture-ready" };
}
