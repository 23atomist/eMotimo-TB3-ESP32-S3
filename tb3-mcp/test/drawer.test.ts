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

// -- fix round 2: UI-8's own regression -------------------------------------
//
// The re-reviewer confirmed setEntryRenderer's renderer really is called
// fresh on every _renderBody() call, but the round-1 tests above never
// called ONE registered renderer twice -- so nothing actually pinned that
// property end to end. UI-8 (the guided calibration procedure) is the first
// real consumer that depends on it: left open across an SSE tick, its step
// list must reflect the tick's fresh daemon state, not whatever state was
// current when the drawer was first opened. refresh() is the seam that
// makes that possible (open()/expand()/a nav click already re-render; a
// tick landing while the drawer just sits open did not, before refresh()
// existed) -- these tests pin refresh() itself AND the "called fresh, never
// cached" property it exists to provide.
describe("Drawer -- refresh() re-renders the active entry in place (UI-8 regression)", () => {
  it("is a no-op when closed -- nothing to refresh, and it must not throw or open anything", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    expect(() => d.refresh()).not.toThrow();
    expect(d.mode()).toBe("closed");
    expect(els.body.innerHTML).toBe("");
  });

  it("re-invokes the registered renderer with FRESH state on each call -- a cached body would freeze the step list at whatever it was when first opened", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    let live = "blocked: needs the rig location first";
    d.setEntryRenderer("calibration", () => `<p class="live">${live}</p>`);

    d.open("calibration");
    expect(els.body.innerHTML).toContain("blocked: needs the rig location first");

    // State changes underneath the drawer (e.g. an operator ran a step and
    // the next SSE tick landed) -- nothing calls open()/expand() again.
    live = "done: rig location set";
    d.refresh();
    expect(els.body.innerHTML).toContain("done: rig location set");
    expect(els.body.innerHTML).not.toContain("blocked: needs the rig location first");

    // And a second, independent change -- proving this isn't a one-shot
    // "renders once more" fluke but genuinely fresh on every call.
    live = "done: solved";
    d.refresh();
    expect(els.body.innerHTML).toContain("done: solved");
  });

  it("does not touch the collapsed strip -- refresh() while mid-sighting must not blow away the strip's Sight/cancel buttons", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    d.setEntryRenderer("calibration", () => "<p>steps</p>");
    d.open("calibration");
    d.collapseToStrip("<button id=\"strip-sight\">Sight it</button>", {});

    d.refresh();

    expect(d.mode()).toBe("strip");
    expect(els.strip.innerHTML).toContain("strip-sight"); // untouched by refresh()
  });

  it("refreshing after expand() shows the entry that was active when it collapsed", () => {
    const els = fakeEls();
    const d = new Drawer(els);
    let live = "before";
    d.setEntryRenderer("calibration", () => `<p>${live}</p>`);

    d.open("calibration");
    d.collapseToStrip("<span>aiming</span>", {});
    d.expand();
    live = "after";
    d.refresh();

    expect(els.body.innerHTML).toContain("after");
  });
});

// -- fix round 3: UI-8 review, finding I-1 -----------------------------------
//
// _renderBody() used to write body.innerHTML UNCONDITIONALLY on every call --
// including every refresh() call, once per SSE tick. That's a foundation
// defect every later drawer entry inherits: a click whose mousedown/mouseup
// straddle a tick loses its target (the pressed button no longer exists by
// mouseup), #drawer's overflow-y:auto scroll position resets every second,
// and keyboard focus inside the drawer is lost every second. The fix caches
// the last-WRITTEN string and skips the DOM write when a fresh render
// produces the identical string -- the renderer itself is still invoked
// every call (setEntryRenderer's "called fresh" contract is about whether
// state is re-read, not whether the DOM is touched), so the existing
// freshness tests above are untouched and still pass unchanged.
//
// A plain fakeEls() body (mk()'s bare `innerHTML: ""` property) can't tell
// these tests how many times it was actually WRITTEN TO, only what its
// current value is -- same reason fakeStripEl() exists above for the strip.
// This is that same technique applied to #drawer-body.
function fakeElsWithTrackedBody() {
  const mk = () => ({ hidden: true, innerHTML: "", classList: { add: vi.fn(), remove: vi.fn() } });
  let html = "";
  let writeCount = 0;
  const body = {
    hidden: true,
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; writeCount++; },
    get writeCount() { return writeCount; },
  };
  return { drawer: mk(), body, strip: mk() };
}

describe("Drawer -- _renderBody skips the DOM write when nothing changed (UI-8 fix round, I-1)", () => {
  it("does not rewrite body.innerHTML across two refresh() calls that render identical content", () => {
    const els = fakeElsWithTrackedBody();
    const d = new Drawer(els);
    d.setEntryRenderer("calibration", () => "<p>unchanging</p>");

    d.open("calibration");
    const writesAfterOpen = els.body.writeCount; // constructor blanks it once, open() writes the real content once

    d.refresh();
    d.refresh();
    // Renderer ran on every call (that's setEntryRenderer's contract) but
    // produced the same string every time -- no reason to touch the DOM,
    // and every reason not to (mid-click/scroll/focus survive only if we
    // don't).
    expect(els.body.writeCount).toBe(writesAfterOpen);
  });

  it("still writes when the renderer's output actually changes", () => {
    const els = fakeElsWithTrackedBody();
    const d = new Drawer(els);
    let live = "first";
    d.setEntryRenderer("calibration", () => `<p>${live}</p>`);

    d.open("calibration");
    const writesAfterOpen = els.body.writeCount;

    live = "second";
    d.refresh();
    expect(els.body.writeCount).toBe(writesAfterOpen + 1);
    expect(els.body.innerHTML).toContain("second");
  });

  it("close() invalidates the cache, so the next open() writes even if it happens to match the pre-close content", () => {
    const els = fakeElsWithTrackedBody();
    const d = new Drawer(els);
    d.setEntryRenderer("calibration", () => "<p>same content</p>");

    d.open("calibration");
    expect(els.body.innerHTML).toContain("same content");

    d.close(); // blanks body.innerHTML directly, bypassing _renderBody()
    expect(els.body.innerHTML).toBe("");

    d.open("calibration"); // must NOT skip this write just because the
    // freshly-rendered string happens to equal what was cached before
    // close() blanked the actual DOM -- that would leave the drawer stuck
    // showing "" forever.
    expect(els.body.innerHTML).toContain("same content");
  });

  it("collapseToStrip() invalidates the cache, so the following expand() writes even if content is unchanged", () => {
    const els = fakeElsWithTrackedBody();
    const d = new Drawer(els);
    d.setEntryRenderer("calibration", () => "<p>same content</p>");

    d.open("calibration");
    const writesAfterOpen = els.body.writeCount;

    d.collapseToStrip("<span>aiming</span>", {});
    d.expand(); // same renderer, same output -- must still write, not trust the cache across the strip round trip

    expect(els.body.writeCount).toBe(writesAfterOpen + 1);
  });
});
