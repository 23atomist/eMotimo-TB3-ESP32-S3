import { describe, it, expect } from "vitest";
import { renderRezeroBanner } from "../dashboard/public/rezero-banner.js";

// Task 6 / I-C: the dashboard used to say NOTHING about a pending re-zero.
// renderRezeroBanner is the pure logic behind the #rezero-banner element
// (app.js's applyRezeroBanner is the thin DOM-applying wrapper around it) --
// same split as capture-label.js's renderCaptureLabel, tested the same way,
// no DOM required.
describe("renderRezeroBanner", () => {
  it("hides the banner when there is no rezero status yet (pre-first-poll)", () => {
    expect(renderRezeroBanner(null)).toEqual({ hidden: true, text: "" });
  });

  it("hides the banner when no re-zero is pending", () => {
    expect(renderRezeroBanner({ needsRezero: false, landmarkLabel: "tower", remedy: null }))
      .toEqual({ hidden: true, text: "" });
  });

  // The four things an operator must learn without clicking (ambiguity
  // resolution #2, task-6-brief.md): a re-zero is pending, pan limits are
  // cleared, sun protection (the sun guard) is degraded, and the remedy.
  it("shows all four things when a re-zero is pending", () => {
    const r = renderRezeroBanner({
      needsRezero: true, landmarkLabel: "tower",
      remedy: "centre the stored landmark and call rezero_from_landmark (or rezero_from_aircraft <hex>). Jog and teach_limit still work.",
    });
    expect(r.hidden).toBe(false);
    expect(r.text).toMatch(/re-zero/i);
    expect(r.text).toMatch(/pending/i);
    expect(r.text).toMatch(/pan limits/i);
    expect(r.text).toMatch(/clear/i);
    expect(r.text).toMatch(/sun guard/i);
    expect(r.text).toMatch(/degrad/i);
    expect(r.text).toMatch(/rezero_from_landmark/);
  });

  it("falls back to a generic remedy when the daemon reports none (defensive only -- get_rezero_status always sends one while pending)", () => {
    const r = renderRezeroBanner({ needsRezero: true, landmarkLabel: null, remedy: null });
    expect(r.hidden).toBe(false);
    expect(r.text).toMatch(/rezero_from_landmark/);
  });
});
