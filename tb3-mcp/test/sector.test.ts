import { describe, it, expect } from "vitest";
import { inArc, DISABLED_SECTOR, TrackSector } from "../src/track/sector.js";

const arc = (startDeg: number, endDeg: number): TrackSector => ({ enabled: true, startDeg, endDeg });

describe("inArc", () => {
  it("disabled sector is always inside", () => {
    for (const az of [0, 90, 180, 270, 359]) expect(inArc(az, DISABLED_SECTOR)).toBe(true);
    expect(inArc(123, { enabled: false, startDeg: 10, endDeg: 20 })).toBe(true);
  });

  it("non-wrapping arc: inside between start and end, inclusive", () => {
    const s = arc(90, 270);
    expect(inArc(180, s)).toBe(true);
    expect(inArc(90, s)).toBe(true);   // start boundary inclusive
    expect(inArc(270, s)).toBe(true);  // end boundary inclusive
    expect(inArc(89.9, s)).toBe(false);
    expect(inArc(0, s)).toBe(false);
    expect(inArc(300, s)).toBe(false);
  });

  it("north-wrapping arc (300 -> 60) includes the slice through north", () => {
    const s = arc(300, 60);
    expect(inArc(0, s)).toBe(true);
    expect(inArc(350, s)).toBe(true);
    expect(inArc(30, s)).toBe(true);
    expect(inArc(300, s)).toBe(true);
    expect(inArc(60, s)).toBe(true);
    expect(inArc(120, s)).toBe(false);
    expect(inArc(200, s)).toBe(false);
    expect(inArc(61, s)).toBe(false);
  });

  it("normalizes azimuths outside [0,360) before testing", () => {
    expect(inArc(-10, arc(300, 60))).toBe(true);   // -10 -> 350, inside
    expect(inArc(370, arc(300, 60))).toBe(true);    // 370 -> 10, inside
  });

  it("zero-width enabled arc (start === end) admits only that exact bearing", () => {
    const s = arc(90, 90);
    expect(inArc(90, s)).toBe(true);
    expect(inArc(91, s)).toBe(false);
    expect(inArc(89, s)).toBe(false);
  });

  it("full-circle arc (0 -> 360) admits every bearing, not just 0", () => {
    // norm360(360) collapses to 0, which would otherwise make a 0->360 span
    // (semantically "the whole circle") behave like the zero-width start===end
    // case above and admit only bearing 0. A span spanning a full turn must
    // be treated as unrestricted instead.
    const s = arc(0, 360);
    for (const az of [0, 90, 200, 359]) expect(inArc(az, s)).toBe(true);
  });
});
