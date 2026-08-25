import { describe, it, expect, vi } from "vitest";
import { shapeDeflection, STICK_DEADZONE, createVirtualStick } from "../dashboard/public/virtual-stick.js";

// -- shapeDeflection: pure math, no DOM -------------------------------------

describe("shapeDeflection", () => {
  it("returns zero inside the deadzone", () => {
    const r = 74; // a 148px pad's radius
    const d = STICK_DEADZONE * r * 0.9;
    expect(shapeDeflection(d, 0, r)).toEqual({ fx: 0, fy: 0 });
  });

  it("full deflection reaches exactly ±1 on each axis", () => {
    expect(shapeDeflection(0, -74, 74).fy).toBeCloseTo(-1, 9);
    expect(shapeDeflection(74, 0, 74).fx).toBeCloseTo(1, 9);
  });

  it("small deflections are disproportionately small (squared curve)", () => {
    const r = 100;
    const halfLinear = shapeDeflection(r / 2, 0, r).fx;
    // Linear would give ~0.46 after deadzone rescale; squared gives far less.
    expect(halfLinear).toBeLessThan(0.25);
    expect(halfLinear).toBeGreaterThan(0);
  });

  it("preserves direction on diagonals (curve shapes gain, not heading)", () => {
    const { fx, fy } = shapeDeflection(-60, -60, 100);
    // A pure diagonal must stay diagonal.
    expect(fx).toBeCloseTo(fy, 9);
    expect(fx).toBeLessThan(0);
  });

  it("clamps beyond-the-rim pushes to the rim (never exceeds ±1)", () => {
    const out = shapeDeflection(0, -500, 74);
    expect(out.fy).toBeCloseTo(-1, 9);
  });

  it("degenerate radius yields a dead stick rather than NaN", () => {
    expect(shapeDeflection(10, -10, 0)).toEqual({ fx: 0, fy: 0 });
  });
});

// -- createVirtualStick: the widget against fake elements -------------------
//
// No jsdom in this repo, so the mount is the same hand-rolled fake pattern
// cockpit.test.ts uses. Only the surface the module actually touches is
// modelled: classList, style, innerHTML/querySelector for the knob, pointer
// event listener registration + dispatch, and pointer capture.

function fakeMount() {
  const handlers: Record<string, Array<(evt: unknown) => void>> = {};
  const knob = {
    style: {} as Record<string, string>,
  };
  return {
    className: "",
    style: {} as Record<string, string>,
    innerHTML: "",
    _knob: knob,
    classList: {
      add(...cs: string[]) {},
      remove(...cs: string[]) {},
      toggle() {},
    },
    querySelector(sel: string) {
      return sel === ".vstick-knob" ? knob : null;
    },
    addEventListener(evt: string, cb: (e: unknown) => void) { (handlers[evt] ??= []).push(cb); },
    setPointerCapture(_id: number) {},
    hasPointerCapture(_id: number) { return true; },
    releasePointerCapture(_id: number) {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 148, height: 148 }; },
    fire(evt: string, payload: Record<string, unknown> = {}) {
      const e = { pointerId: 7, preventDefault() {}, clientX: 0, clientY: 0, ...payload };
      (handlers[evt] ?? []).forEach((cb) => cb(e));
    },
  };
}

describe("createVirtualStick", () => {
  it("reports shaped deflections while dragged and fires onRelease once per gesture", () => {
    const mount = fakeMount();
    const moves: Array<[number, number]> = [];
    let releases = 0;
    const stick = createVirtualStick({
      mount,
      size: 148,
      onMove: (fx, fy) => moves.push([fx, fy]),
      onRelease: () => { releases += 1; },
    })!;

    mount.fire("pointerdown", { clientX: 74, clientY: 74 });          // centre
    mount.fire("pointermove", { clientX: 74, clientY: 74 - 74 });     // full push UP
    expect(moves[moves.length - 1][1]).toBeCloseTo(-1, 9);

    mount.fire("pointerup");
    expect(releases).toBe(1);
    expect(moves.filter(([, fy]) => fy === -1).length).toBeGreaterThan(0);
    void stick;
  });

  it("a second pointer is ignored while one gesture is live", () => {
    const mount = fakeMount();
    let moves = 0;
    createVirtualStick({ mount, onMove: () => { moves += 1; }, onRelease: () => {} });

    mount.fire("pointerdown", { pointerId: 1, clientX: 74, clientY: 74 });
    mount.fire("pointermove", { pointerId: 2, clientX: 200, clientY: 200 }); // other finger
    expect(moves).toBe(1); // only the initial down-move from pointer 1
  });

  it("setDisabled force-releases a live drag and refuses new ones", () => {
    const mount = fakeMount();
    let moves = 0;
    let releases = 0;
    const stick = createVirtualStick({
      mount,
      onMove: () => { moves += 1; },
      onRelease: () => { releases += 1; },
    })!;

    mount.fire("pointerdown", { clientX: 74, clientY: 40 });
    stick.setDisabled(true);
    expect(releases).toBe(1);   // live drag force-released

    moves = 0;
    mount.fire("pointermove", { clientX: 74, clientY: 20 });
    expect(moves).toBe(0);      // no moves reach the app while disabled
    mount.fire("pointerdown", { clientX: 74, clientY: 40 });
    mount.fire("pointermove", { clientX: 74, clientY: 20 });
    expect(moves).toBe(0);      // new gestures refused too
  });

  it("destroy clears the rendered internals", () => {
    const mount = fakeMount();
    const stick = createVirtualStick({ mount, onMove: () => {}, onRelease: () => {} })!;
    stick.destroy();
    expect(mount.innerHTML).toBe("");
  });

  it("a null mount is tolerated (partial-DOM harnesses)", () => {
    expect(createVirtualStick({ mount: null as never, onMove: () => {}, onRelease: () => {} })).toBeNull();
  });
});
