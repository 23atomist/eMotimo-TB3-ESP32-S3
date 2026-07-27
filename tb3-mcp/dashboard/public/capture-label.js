// Pure label logic, split out so it is testable without a DOM. Ordering is
// deliberate: an error must never be masked by a healthy-looking state.
export function renderCaptureLabel(s) {
  if (!s) return { text: "Capture: —", cls: "capture-unknown" };
  if (s.lastError) return { text: "Capture: ERROR", cls: "capture-error" };
  if (s.lastSkipReason) return { text: "Capture: skipped (disarmed)", cls: "capture-skip" };
  if (!s.autoEnabled) return { text: "Capture: OFF", cls: "capture-off" };
  if (s.recording) return { text: "Capture: REC " + (s.passIcao || ""), cls: "capture-rec" };
  return { text: "Capture: ready", cls: "capture-ready" };
}
