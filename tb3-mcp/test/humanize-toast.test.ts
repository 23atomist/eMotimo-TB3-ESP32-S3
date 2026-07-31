import { describe, it, expect } from "vitest";
import { humanizeToolMessage } from "../dashboard/public/tool-message.js";

// FIELD 2026-07-30: "now i'm getting json errors". They were not errors --
// several daemon tools return a JSON document as their text payload and
// runAction relays it verbatim, so the toast showed raw braces and quotes.
describe("humanizeToolMessage", () => {
  it("passes plain prose straight through", () => {
    expect(humanizeToolMessage("tracking stopped")).toBe("tracking stopped");
  });

  it("prefers a note the tool already wrote for the operator", () => {
    expect(humanizeToolMessage('{"edge":"pan_max","value_deg":20.6,"note":"captured."}')).toBe("captured.");
  });

  it("renders a note-less document as readable pairs, not braces", () => {
    const out = humanizeToolMessage('{"offset_pan_deg":1.4,"offset_tilt_deg":-0.2}');
    expect(out).toBe("offset pan deg: 1.4, offset tilt deg: -0.2");
    expect(out).not.toMatch(/[{}"]/);
  });

  it("drops false flags rather than shouting them every nudge", () => {
    expect(humanizeToolMessage('{"offset_pan_deg":1,"clamped":false}')).toBe("offset pan deg: 1");
  });

  it("keeps a true flag -- that one is the whole point", () => {
    expect(humanizeToolMessage('{"offset_pan_deg":5,"clamped":true}')).toMatch(/clamped: true/);
  });

  it("leaves malformed JSON alone instead of hiding it", () => {
    expect(humanizeToolMessage('{"broken":')).toBe('{"broken":');
  });

  it("tolerates null/undefined without throwing", () => {
    expect(humanizeToolMessage(undefined)).toBe(null);
  });
});
