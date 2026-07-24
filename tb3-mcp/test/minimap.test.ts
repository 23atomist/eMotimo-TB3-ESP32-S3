import { describe, it, expect } from "vitest";
import { azRangeToXY, nearestDot } from "../dashboard/public/minimap.js";

describe("azRangeToXY (north up, east right)", () => {
  const cx = 100, cy = 100, radius = 100, maxKm = 100;
  it("range 0 is the center", () => {
    const p = azRangeToXY(37, 0, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx, 6); expect(p.y).toBeCloseTo(cy, 6);
  });
  it("north (0deg) at max range is straight up", () => {
    const p = azRangeToXY(0, maxKm, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx, 6); expect(p.y).toBeCloseTo(cy - radius, 6);
  });
  it("east (90deg) is to the right", () => {
    const p = azRangeToXY(90, maxKm, maxKm, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx + radius, 6); expect(p.y).toBeCloseTo(cy, 6);
  });
  it("south (180deg) is down; west (270deg) is left", () => {
    const s = azRangeToXY(180, maxKm, maxKm, cx, cy, radius);
    expect(s.x).toBeCloseTo(cx, 6); expect(s.y).toBeCloseTo(cy + radius, 6);
    const w = azRangeToXY(270, maxKm, maxKm, cx, cy, radius);
    expect(w.x).toBeCloseTo(cx - radius, 6); expect(w.y).toBeCloseTo(cy, 6);
  });
  it("range scales linearly to the rim", () => {
    const p = azRangeToXY(90, 50, 100, cx, cy, radius);
    expect(p.x).toBeCloseTo(cx + radius / 2, 6);
  });
});

describe("nearestDot", () => {
  const dots = [{ x: 10, y: 10, hex: "a" }, { x: 100, y: 100, hex: "b" }];
  it("returns the closest dot within maxDistPx", () => {
    expect(nearestDot(dots, 12, 12, 8)?.hex).toBe("a");
  });
  it("returns null when nothing is within maxDistPx", () => {
    expect(nearestDot(dots, 50, 50, 8)).toBeNull();
  });
});
