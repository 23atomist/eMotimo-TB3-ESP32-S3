import { describe, it, expect } from "vitest";
import {
  norm360, bearingToPoint, sectorArcSpans, formatBearingReadout, seedNonDegenerate,
  renderSectorEntry, paintSector,
} from "../dashboard/public/sector.js";

describe("norm360", () => {
  it("wraps into [0, 360)", () => {
    expect(norm360(0)).toBe(0);
    expect(norm360(359)).toBe(359);
    expect(norm360(360)).toBe(0);
    expect(norm360(-10)).toBe(350);
    expect(norm360(725)).toBe(5);
  });
});

describe("bearingToPoint", () => {
  it("N is straight up (negative y), E is to the right (positive x)", () => {
    const n = bearingToPoint(100, 100, 80, 0);
    expect(n.x).toBeCloseTo(100, 5);
    expect(n.y).toBeCloseTo(20, 5);
    const e = bearingToPoint(100, 100, 80, 90);
    expect(e.x).toBeCloseTo(180, 5);
    expect(e.y).toBeCloseTo(100, 5);
  });
});

describe("sectorArcSpans", () => {
  it("a non-wrapping arc is a single span", () => {
    expect(sectorArcSpans(90, 270)).toEqual([[90, 270]]);
  });

  it("an arc that wraps through north splits into two spans", () => {
    // 350 -> 10 wraps through 0/360.
    expect(sectorArcSpans(350, 10)).toEqual([[350, 360], [0, 10]]);
  });

  it("tolerates raw values outside [0,360) by normalizing first", () => {
    expect(sectorArcSpans(-10, 370)).toEqual(sectorArcSpans(350, 10));
  });
});

describe("formatBearingReadout", () => {
  it("shows a literal 360 rather than normalizing it to 0", () => {
    expect(formatBearingReadout(360)).toBe("360°");
  });

  it("rounds and normalizes any other value", () => {
    expect(formatBearingReadout(44.6)).toBe("45°");
    expect(formatBearingReadout(-10)).toBe("350°");
  });
});

describe("seedNonDegenerate", () => {
  it("substitutes a real arc for the daemon's disabled default (0/360, zero-width)", () => {
    const seeded = seedNonDegenerate({ enabled: false, startDeg: 0, endDeg: 360 });
    expect(seeded.startDeg).not.toBe(seeded.endDeg);
    expect(seeded.enabled).toBe(false);
  });

  it("leaves any other sector value alone, `enabled` included", () => {
    const s = { enabled: true, startDeg: 10, endDeg: 20 };
    expect(seedNonDegenerate(s)).toEqual(s);
    const disabledButNotDegenerate = { enabled: false, startDeg: 10, endDeg: 20 };
    expect(seedNonDegenerate(disabledButNotDegenerate)).toEqual(disabledButNotDegenerate);
  });
});

// This is the single most important property in this file: drawer.js's
// _renderBody() only rewrites #drawer-body's innerHTML when the registered
// renderer's returned string actually changed. If renderSectorEntry() ever
// baked live values (the current arc, a handle position) into its output,
// an ordinary ~1Hz SSE-driven refresh() tick could rewrite the entry's DOM
// mid-drag -- dropping a handle's pointer capture (removing a captured
// element from the DOM implicitly releases it). Pinning constancy here is
// what makes that regression class structurally impossible, not just
// "currently doesn't happen to trigger it."
describe("renderSectorEntry", () => {
  it("returns the exact same string every time, independent of sectorLocal", () => {
    const first = renderSectorEntry();
    const second = renderSectorEntry();
    expect(second).toBe(first);
  });

  it("carries every id paintSector/wireSectorDelegates depend on", () => {
    const html = renderSectorEntry();
    for (const id of [
      "sector-compass", "sector-wedge-a", "sector-wedge-b",
      "sector-handle-start", "sector-handle-end",
      "sector-start-readout", "sector-end-readout", "sector-enable",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

// -- paintSector: a hand-rolled fake DOM (no jsdom in this repo -- see
// cockpit.test.ts's own fakes for the established convention) -----------

function fakeClassList(initial: string[] = []) {
  const set = new Set<string>(initial);
  return {
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    has: (c: string) => set.has(c),
  };
}

function fakeSvgEl() {
  const attrs: Record<string, string> = {};
  return {
    setAttribute(name: string, value: string) { attrs[name] = value; },
    getAttribute(name: string) { return attrs[name]; },
    classList: fakeClassList(),
    style: {} as Record<string, string>,
  };
}

function fakeTextEl() {
  return { textContent: "" };
}

function fakeCheckbox() {
  return { checked: false, disabled: false };
}

function fakeRoot() {
  const nodes: Record<string, unknown> = {
    "#sector-wedge-a": fakeSvgEl(),
    "#sector-wedge-b": fakeSvgEl(),
    "#sector-handle-start": fakeSvgEl(),
    "#sector-handle-end": fakeSvgEl(),
    "#sector-start-readout": fakeTextEl(),
    "#sector-end-readout": fakeTextEl(),
    "#sector-enable": fakeCheckbox(),
    "#sector-compass": fakeSvgEl(),
  };
  return { nodes, querySelector: (sel: string) => nodes[sel] ?? null };
}

describe("paintSector", () => {
  it("is a harmless no-op when the Track Sector entry isn't mounted", () => {
    expect(() => paintSector({ querySelector: () => null }, { startDeg: 0, endDeg: 90, enabled: true }, false)).not.toThrow();
    expect(() => paintSector(null, { startDeg: 0, endDeg: 90, enabled: true }, false)).not.toThrow();
  });

  it("paints the wedge path, handle positions, readouts, and checkbox state", () => {
    const root = fakeRoot();
    paintSector(root, { startDeg: 45, endDeg: 135, enabled: true }, false);
    const wedgeA = root.nodes["#sector-wedge-a"] as ReturnType<typeof fakeSvgEl>;
    expect(wedgeA.getAttribute("d")).toMatch(/^M 100 100 L/);
    expect((root.nodes["#sector-start-readout"] as ReturnType<typeof fakeTextEl>).textContent).toBe("45°");
    expect((root.nodes["#sector-end-readout"] as ReturnType<typeof fakeTextEl>).textContent).toBe("135°");
    expect((root.nodes["#sector-enable"] as ReturnType<typeof fakeCheckbox>).checked).toBe(true);
  });

  it("greys out the handles and disables the checkbox under E-STOP", () => {
    const root = fakeRoot();
    paintSector(root, { startDeg: 0, endDeg: 90, enabled: true }, true);
    const handleStart = root.nodes["#sector-handle-start"] as ReturnType<typeof fakeSvgEl>;
    expect(handleStart.classList.has("sector-handle-disabled")).toBe(true);
    expect((root.nodes["#sector-enable"] as ReturnType<typeof fakeCheckbox>).disabled).toBe(true);
  });

  it("hides the second wedge path when the arc doesn't wrap (no north-crossing sub-span)", () => {
    const root = fakeRoot();
    paintSector(root, { startDeg: 45, endDeg: 135, enabled: true }, false);
    expect((root.nodes["#sector-wedge-b"] as ReturnType<typeof fakeSvgEl>).style.display).toBe("none");
  });
});
