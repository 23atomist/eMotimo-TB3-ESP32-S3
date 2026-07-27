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

  // The four cases below all set two "reasons to render something other than
  // ERROR" at once. Without them, a version of renderCaptureLabel that
  // checks !autoEnabled (or lastSkipReason) BEFORE lastError still passes
  // every case above -- none of those cases ever has more than one
  // precedence-relevant field set at a time, so nothing actually exercises
  // the ordering the function's ordering comment claims to guarantee.

  it("an error outranks a skip reason, even when both are set", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: false, passIcao: "ABC123", lastSnapshot: null,
      lastError: "record on: ECONNREFUSED",
      lastSkipReason: "camera disarmed at lock on ABC123; capture skipped",
    })).toEqual({ text: "Capture: ERROR", cls: "capture-error" });
  });

  it("an error outranks OFF -- a broken pipeline is not just an inert one", () => {
    expect(renderCaptureLabel({
      autoEnabled: false, recording: false, passIcao: null, lastSnapshot: null,
      lastError: "record on: ECONNREFUSED", lastSkipReason: null,
    })).toEqual({ text: "Capture: ERROR", cls: "capture-error" });
  });

  it("a skip reason outranks OFF -- the operator disarmed mid-pass, not the auto toggle", () => {
    expect(renderCaptureLabel({
      autoEnabled: false, recording: false, passIcao: null, lastSnapshot: null,
      lastError: null, lastSkipReason: "camera disarmed at lock on ABC123; capture skipped",
    })).toEqual({ text: "Capture: skipped (disarmed)", cls: "capture-skip" });
  });

  it("an error outranks REC -- a recording that just failed must not read as healthy", () => {
    expect(renderCaptureLabel({
      autoEnabled: true, recording: true, passIcao: "ABC123", lastSnapshot: null,
      lastError: "record on: ECONNREFUSED", lastSkipReason: null,
    })).toEqual({ text: "Capture: ERROR", cls: "capture-error" });
  });
});
