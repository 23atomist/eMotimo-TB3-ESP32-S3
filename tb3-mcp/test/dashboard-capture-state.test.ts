import { describe, it, expect } from "vitest";
import { renderCaptureLabel } from "../dashboard/public/capture-label.js";

describe("renderCaptureLabel", () => {
  it("shows a dash when the daemon has not reported yet", () => {
    expect(renderCaptureLabel(null)).toEqual({ text: "Capture: —", cls: "capture-unknown" });
  });

  it("shows REC with the aircraft while recording", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: true, passIcao: "ABC123",
      lastSnapshot: "/s/ABC123.jpg", lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: REC ABC123", cls: "capture-rec" });
  });

  it("shows armed-and-waiting when auto is on but nothing is tracked", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: ready", cls: "capture-ready" });
  });

  it("shows OFF when auto capture is disabled", () => {
    expect(renderCaptureLabel({
      autoEnabled: false, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    })).toEqual({ text: "Capture: OFF", cls: "capture-off" });
  });

  it("an error outranks everything -- it must never be invisible", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: true, passIcao: "ABC123",
      lastSnapshot: null, lastError: "record on: ECONNREFUSED", lastSkipReason: null,
    })).toEqual({ text: "Capture: ERROR", cls: "capture-error" });
  });

  it("a skip reason is shown rather than looking idle", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: false, passIcao: null, lastSnapshot: null,
      lastError: null, lastSkipReason: "camera disarmed at lock on ABC123; capture skipped",
    })).toEqual({ text: "Capture: skipped (disarmed)", cls: "capture-skip" });
  });
});
