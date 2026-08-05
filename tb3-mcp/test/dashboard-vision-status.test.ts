import { describe, it, expect } from "vitest";
import { renderVisionStatus } from "../dashboard/public/vision-status.js";

describe("renderVisionStatus", () => {
  it("says OFF when disabled, regardless of a stale last outcome", () => {
    const t = renderVisionStatus({ enabled: false, readOnly: true, lastOutcome: "applied", panDeg: 1, tiltDeg: 2 });
    expect(t).toMatch(/off/i);
    expect(t).not.toMatch(/applied/i);
  });

  it("distinguishes read-only from active", () => {
    const ro = renderVisionStatus({ enabled: true, readOnly: true, lastOutcome: "read_only", panDeg: 0.4, tiltDeg: -0.2 });
    const on = renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "applied", panDeg: 0.4, tiltDeg: -0.2 });
    expect(ro).toMatch(/observing|read.?only/i);
    expect(on).not.toMatch(/observing|read.?only/i);
  });

  it("surfaces a rejection reason rather than showing a bare zero", () => {
    const t = renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "none_near_prediction", panDeg: null, tiltDeg: null });
    expect(t).toMatch(/prediction/i);
  });

  it("survives a null correction", () => {
    expect(() => renderVisionStatus({ enabled: true, readOnly: false, lastOutcome: "no_frame", panDeg: null, tiltDeg: null })).not.toThrow();
  });
});
