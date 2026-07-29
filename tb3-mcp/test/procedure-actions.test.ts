import { describe, it, expect, vi } from "vitest";
import { initProcedureActions } from "../dashboard/public/procedure-actions.js";

// Fake Drawer: only the surface initProcedureActions actually calls
// (setEntryRenderer/mode/refresh/updateStrip/collapseToStrip/expand) --
// same hand-rolled-fake convention as drawer.test.ts/cockpit.test.ts (no
// jsdom in this repo).
function fakeDrawer() {
  const renderers = new Map<string, () => string>();
  return {
    _renderers: renderers,
    _mode: "closed" as string,
    setEntryRenderer(id: string, fn: () => string) { renderers.set(id, fn); },
    mode() { return this._mode; },
    refresh: vi.fn(),
    updateStrip: vi.fn(),
    collapseToStrip: vi.fn(),
    expand: vi.fn(),
  };
}

// Fake #drawer-body: only addEventListener, capturing the single delegated
// click handler so tests can invoke it directly with a fake event.
function fakeDrawerBody() {
  const handlers: Array<(evt: unknown) => void> = [];
  return {
    addEventListener(_type: string, cb: (evt: unknown) => void) { handlers.push(cb); },
    fireClick(actEl: { dataset: { act: string } }) {
      const evt = { target: { closest: (sel: string) => (sel === "[data-act]" ? actEl : null) } };
      for (const h of handlers) h(evt);
    },
  };
}

function setup(over: Partial<Parameters<typeof initProcedureActions>[0]> = {}) {
  const drawer = fakeDrawer();
  const drawerBody = fakeDrawerBody();
  const toasts: Array<[string, boolean]> = [];
  const posts: Array<[string, unknown]> = [];
  const actions = initProcedureActions({
    drawer, drawerBody,
    postControl: async (path: string, body: unknown) => { posts.push([path, body]); return { ok: true }; },
    toast: (msg: string, ok: boolean) => { toasts.push([msg, ok]); },
    getLastState: () => ({}),
    isEstopLatched: () => false,
    isSunLocked: () => false,
    isTrimActive: () => false,
    ...over,
  });
  return { drawer, drawerBody, toasts, posts, actions };
}

describe("initProcedureActions", () => {
  it("registers a renderer for calibration, travel-limits, and set-home", () => {
    const { drawer } = setup();
    expect(drawer._renderers.has("calibration")).toBe(true);
    expect(drawer._renderers.has("travel-limits")).toBe(true);
    expect(drawer._renderers.has("set-home")).toBe(true);
  });

  it("refreshSetupDrawer calls drawer.refresh() only in open mode", () => {
    const { drawer, actions } = setup();
    drawer._mode = "open";
    actions.refreshSetupDrawer({});
    expect(drawer.refresh).toHaveBeenCalledTimes(1);
    expect(drawer.updateStrip).not.toHaveBeenCalled();
  });

  it("refreshSetupDrawer pushes strip readouts only in strip mode", () => {
    const { drawer, actions } = setup();
    drawer._mode = "strip";
    actions.refreshSetupDrawer({ tracking: { hex: "abc123", callsign: "AAL1" } });
    expect(drawer.refresh).not.toHaveBeenCalled();
    expect(drawer.updateStrip).toHaveBeenCalledTimes(1);
    const fields = drawer.updateStrip.mock.calls[0][0];
    expect(fields.aircraft).toContain("AAL1");
  });

  it("refreshSetupDrawer is a no-op in closed mode", () => {
    const { drawer, actions } = setup();
    drawer._mode = "closed";
    actions.refreshSetupDrawer({});
    expect(drawer.refresh).not.toHaveBeenCalled();
    expect(drawer.updateStrip).not.toHaveBeenCalled();
  });

  // The verb->handler map dispatch: "home:set" must fire setHomeActions.setHome,
  // but any OTHER id paired with the "home" verb must NOT -- home/set's
  // confirmation must never fire from an unrelated data-act value that
  // happens to share the verb.
  it("dispatches home:set to setHome, but not home:<anything-else>", async () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    const { drawerBody, posts } = setup();
    drawerBody.fireClick({ dataset: { act: "home:set" } });
    await Promise.resolve();
    expect(posts.some(([path]) => path === "home/set")).toBe(true);

    posts.length = 0;
    drawerBody.fireClick({ dataset: { act: "home:cancel" } });
    await Promise.resolve();
    expect(posts.some(([path]) => path === "home/set")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("dispatches clear-limits to the confirm-gated clearLimits action", async () => {
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    const { drawerBody, posts } = setup();
    drawerBody.fireClick({ dataset: { act: "clear-limits:" } });
    await Promise.resolve();
    expect(posts.some(([path]) => path === "limits/clear-taught")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("falls through to stepHandler for calibration step ids (run/reset/start)", async () => {
    const { drawerBody, posts } = setup();
    drawerBody.fireClick({ dataset: { act: "run:north-zero" } });
    await Promise.resolve();
    expect(posts.some(([path]) => path === "calibrate/set-north-zero")).toBe(true);
  });

  it("a non-sighting step's [redo] still reaches its action directly (no confirmation) -- redo:north-zero", async () => {
    const { drawerBody, posts } = setup({
      getLastState: () => ({ calibration: { sightings: [{ label: "A" }, { label: "B" }], calibrated: true } }),
    });
    drawerBody.fireClick({ dataset: { act: "redo:north-zero" } });
    await Promise.resolve();
    expect(posts.some(([path]) => path === "calibrate/set-north-zero")).toBe(true);
  });

  // Smaller-items fix: a done sighting step's [redo] must be gated behind a
  // confirmation once both sightings exist (see procedures.js's
  // destructiveConfirm("resight-sight-1"/"resight-sight-2") tests for the
  // message itself) -- this pins the DISPATCH side: declining the confirm
  // must not sight anything, and accepting it must.
  describe("redo:sight-1 / redo:sight-2 (sighting redo confirmation)", () => {
    function stateWithBothSightings() {
      return {
        tracking: { hex: "a1b2c3" },
        calibration: { sightings: [{ label: "UAL123" }, { label: "AAL456" }], calibrated: false },
      };
    }

    it("declining the confirmation does not re-sight", async () => {
      vi.stubGlobal("window", { confirm: vi.fn(() => false) });
      const { drawerBody, posts } = setup({ getLastState: stateWithBothSightings });
      drawerBody.fireClick({ dataset: { act: "redo:sight-2" } });
      await Promise.resolve();
      expect(posts.some(([path]) => path === "calibrate/sight-aircraft")).toBe(false);
      vi.unstubAllGlobals();
    });

    it("accepting the confirmation re-sights the currently tracked aircraft", async () => {
      vi.stubGlobal("window", { confirm: vi.fn(() => true) });
      const { drawer, drawerBody } = setup({ getLastState: stateWithBothSightings });
      drawerBody.fireClick({ dataset: { act: "redo:sight-2" } });
      await Promise.resolve();
      expect(drawer.collapseToStrip).toHaveBeenCalled(); // startSighting's own strip handoff fired
      vi.unstubAllGlobals();
    });

    it("with fewer than 2 sightings recorded, no confirmation is shown at all", async () => {
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal("window", { confirm: confirmSpy });
      const { drawer, drawerBody } = setup({
        getLastState: () => ({ tracking: { hex: "a1b2c3" }, calibration: { sightings: [{ label: "A" }] } }),
      });
      drawerBody.fireClick({ dataset: { act: "redo:sight-1" } });
      await Promise.resolve();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(drawer.collapseToStrip).toHaveBeenCalled(); // startSighting still ran, ungated
      vi.unstubAllGlobals();
    });
  });
});

describe("sightTrackedAircraft (shared by the sighting strip and the physical joystick)", () => {
  it("refuses with no aircraft currently tracked", async () => {
    const { actions, toasts, posts } = setup({ getLastState: () => ({ tracking: { hex: null } }) });
    const result = await actions.sightTrackedAircraft();
    expect(result).toBeNull();
    expect(posts.length).toBe(0);
    expect(toasts.some(([m]) => /track one first/i.test(m))).toBe(true);
  });

  it("refuses under E-STOP -- the rig may no longer be centred on the target", async () => {
    const { actions, posts } = setup({
      getLastState: () => ({ tracking: { hex: "abc123" } }),
      isEstopLatched: () => true,
    });
    const result = await actions.sightTrackedAircraft();
    expect(result).toBeNull();
    expect(posts.length).toBe(0);
  });

  it("posts calibrate/sight-aircraft with the tracked hex when ungated", async () => {
    const { actions, posts } = setup({ getLastState: () => ({ tracking: { hex: "abc123" } }) });
    await actions.sightTrackedAircraft();
    expect(posts).toEqual([["calibrate/sight-aircraft", { hex: "abc123" }]]);
  });
});
