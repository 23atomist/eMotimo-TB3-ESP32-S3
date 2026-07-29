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
});
