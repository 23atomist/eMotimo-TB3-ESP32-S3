import { describe, it, expect, vi } from "vitest";
import { Drawer } from "../dashboard/public/drawer.js";

function fakeEls() {
  const mk = () => ({ hidden: true, innerHTML: "", classList: { add: vi.fn(), remove: vi.fn() } });
  return { drawer: mk(), body: mk(), strip: mk() };
}

describe("Drawer", () => {
  it("starts closed", () => {
    expect(new Drawer(fakeEls()).mode()).toBe("closed");
  });
  it("opens and closes", () => {
    const d = new Drawer(fakeEls());
    d.open("calibration"); expect(d.mode()).toBe("open");
    d.close();             expect(d.mode()).toBe("closed");
  });
  it("collapsing to a strip hides the drawer body but keeps the procedure active", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.open("calibration");
    d.collapseToStrip("<b>trim</b>", {});
    expect(d.mode()).toBe("strip");
    expect(els.drawer.hidden).toBe(true);   // video must not be covered
    expect(els.strip.hidden).toBe(false);
  });
  it("expanding from a strip returns to the open drawer", () => {
    const d = new Drawer(fakeEls());
    d.open("calibration"); d.collapseToStrip("x", {}); d.expand();
    expect(d.mode()).toBe("open");
  });
  it("closing from a strip clears the strip", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.open("calibration"); d.collapseToStrip("x", {}); d.close();
    expect(d.mode()).toBe("closed");
    expect(els.strip.hidden).toBe(true);
  });
  it("open() falls back to the first entry for an unrecognized id", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.open("not-a-real-entry");
    expect(d.mode()).toBe("open");
    expect(els.body.innerHTML).toContain("Calibration");
  });
});

// -- fix round 1: two seams UI-8 (guided calibration) needs immediately --
//
// 1. updateStrip(fields) -- an aiming step ticks a live trim-offset readout
//    while the operator centres a plane; collapseToStrip() on every tick
//    would tear down and recreate the strip's Mark/Cancel buttons (and their
//    listeners) at trim-rate. updateStrip must change only a named
//    `data-region` element's text, never touch the strip's innerHTML or the
//    buttons/listeners already wired by collapseToStrip.
// 2. setEntryRenderer(entryId, renderFn) -- lets a procedure module hand the
//    drawer its real body from OUTSIDE this file, keeping today's
//    placeholder as the fallback for every entry that hasn't registered one.

// A richer fake strip than fakeEls()'s plain mk() -- one that actually
// parses ids/data-regions out of whatever's written to innerHTML, and
// counts writes, so these tests can assert the property that matters:
// after collapseToStrip() wires a button, repeated updateStrip() calls
// must (a) never rewrite the strip's innerHTML again and (b) return that
// EXACT SAME button object on every subsequent lookup -- not just "the text
// changed", which would pass even if the whole strip had been silently
// rebuilt from scratch on every call.
interface FakeStripNode {
  addEventListener: (evt: string, cb: () => void) => void;
  click: () => void;
}
interface FakeStripRegion {
  textContent: string;
}

function fakeStripEl() {
  let html = "";
  let writeCount = 0;
  let buttons: Record<string, FakeStripNode> = {};
  let regions: Record<string, FakeStripRegion> = {};

  function reparse(markup: string) {
    buttons = {};
    regions = {};
    for (const m of markup.matchAll(/\bid="([^"]+)"/g)) {
      const id = m[1];
      const handlers: Record<string, Array<() => void>> = {};
      buttons[id] = {
        addEventListener(evt: string, cb: () => void) { (handlers[evt] ??= []).push(cb); },
        click() { (handlers.click ?? []).forEach((cb) => cb()); },
      };
    }
    for (const m of markup.matchAll(/data-region="([^"]+)"/g)) {
      regions[m[1]] = { textContent: "" };
    }
  }

  return {
    hidden: true,
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; writeCount++; reparse(v); },
    get writeCount() { return writeCount; },
    querySelector(sel: string): FakeStripNode | FakeStripRegion | null {
      const idMatch = sel.match(/^#(.+)$/);
      if (idMatch) return buttons[idMatch[1]] ?? null;
      const regionMatch = sel.match(/data-region="([^"]+)"/);
      if (regionMatch) return regions[regionMatch[1]] ?? null;
      return null;
    },
  };
}

describe("Drawer -- strip live-update seam (updateStrip)", () => {
  it("updates a data-region's text without rewriting the strip or touching its buttons", () => {
    const els = fakeEls();
    const strip = fakeStripEl();
    const d = new Drawer({ drawer: els.drawer, body: els.body, strip });
    const onMark = vi.fn();

    d.open("calibration");
    d.collapseToStrip(
      '<span data-region="offset">0.0deg</span><button id="strip-mark">Mark</button>',
      { "strip-mark": onMark },
    );

    const buttonBefore = strip.querySelector("#strip-mark");
    const writesAfterCollapse = strip.writeCount;

    d.updateStrip({ offset: "1.2deg" });
    d.updateStrip({ offset: "2.4deg" });

    const region = strip.querySelector('[data-region="offset"]') as FakeStripRegion;
    expect(region.textContent).toBe("2.4deg");
    // Same button object across repeated updates -- proof the strip was
    // never rewritten (a rebuilt strip would return a fresh object here).
    expect(strip.querySelector("#strip-mark")).toBe(buttonBefore);
    expect(strip.writeCount).toBe(writesAfterCollapse);

    // ...and its listener is still wired, not silently dropped.
    (buttonBefore as FakeStripNode).click();
    expect(onMark).toHaveBeenCalledTimes(1);
  });
});

describe("Drawer -- per-entry content seam (setEntryRenderer)", () => {
  it("uses a registered renderer for its entry, and the placeholder for entries without one", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.setEntryRenderer("calibration", () => '<p class="real">REAL CALIBRATION BODY</p>');

    d.open("calibration");
    expect(els.body.innerHTML).toContain("REAL CALIBRATION BODY");

    d.open("travel-limits");
    expect(els.body.innerHTML).toContain("Not implemented yet.");
    expect(els.body.innerHTML).not.toContain("REAL CALIBRATION BODY");
  });
});
