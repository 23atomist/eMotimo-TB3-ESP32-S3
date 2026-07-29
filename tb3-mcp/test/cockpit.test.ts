import { describe, it, expect, vi } from "vitest";
import { Cockpit } from "../dashboard/public/cockpit.js";

// -- fakes: DOM elements + hold-loop stand-ins, none of which need a browser
// -- this is exactly what makes Cockpit testable: it takes these as injected
// deps instead of reaching for document/window itself (same rationale as
// camera-panel.test.ts's fakes). No jsdom/happy-dom is installed in this
// repo, so every element is a hand-rolled fake, not a real DOM node.

function fakeClassList(initial: string[] = []) {
  const set = new Set<string>(initial);
  return {
    add: (...cs: string[]) => { for (const c of cs) set.add(c); },
    remove: (...cs: string[]) => { for (const c of cs) set.delete(c); },
    has: (c: string) => set.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function fakeTextEl() {
  return { textContent: "", className: "", classList: fakeClassList(), dataset: {} as Record<string, string> };
}

function fakeButton() {
  const handlers: Record<string, Array<(evt: unknown) => void>> = {};
  return {
    disabled: false,
    classList: fakeClassList(),
    addEventListener(evt: string, cb: (e: unknown) => void) { (handlers[evt] ??= []).push(cb); },
    setPointerCapture(_id: number) {},
    hasPointerCapture(_id: number) { return true; },
    releasePointerCapture(_id: number) {},
    fire(evt: string, payload: Record<string, unknown> = {}) {
      const e = { pointerId: 1, preventDefault: () => {}, ...payload };
      (handlers[evt] ?? []).forEach((cb) => cb(e));
    },
  };
}

// The aircraft list is rebuilt via innerHTML each render(); this fake
// "parses" just enough of the real markup (the track-btn's data-hex) to
// reproduce querySelectorAll("button.track-btn") without a real DOM/parser.
function fakeAdsbList() {
  let html = "";
  let buttons: Array<{ dataset: { hex: string }; addEventListener: (e: string, cb: () => void) => void; click: () => void }> = [];
  return {
    get innerHTML() { return html; },
    set innerHTML(v: string) {
      html = v;
      const hexes = [...v.matchAll(/class="track-btn" data-hex="([^"]*)"/g)].map((m) => m[1]);
      buttons = hexes.map((hex) => {
        const handlers: Record<string, Array<() => void>> = {};
        return {
          dataset: { hex },
          addEventListener(evt: string, cb: () => void) { (handlers[evt] ??= []).push(cb); },
          click() { (handlers.click ?? []).forEach((cb) => cb()); },
        };
      });
    },
    querySelectorAll(_sel: string) { return buttons; },
  };
}

function fakeSvc() {
  return { readsb: fakeTextEl(), tb3mcp: fakeTextEl(), tb3agent: fakeTextEl(), llama: fakeTextEl() };
}

// A fake JogHold/NudgeHold: tracks start()/stop() calls and `active`, same
// shape jog-hold.test.ts/nudge-hold.test.ts already pin against the real
// classes -- Cockpit only ever calls .start()/.stop()/.active on these.
function fakeHold() {
  const startCalls: Array<{ panMul: number; tiltMul: number }> = [];
  let active = false;
  let refuse = false;
  return {
    start: vi.fn((panMul: number, tiltMul: number) => {
      if (refuse) return; // simulates the hold's own isGated() refusing internally
      startCalls.push({ panMul, tiltMul });
      active = true;
    }),
    stop: vi.fn(() => { active = false; }),
    get active() { return active; },
    setRefuse(v: boolean) { refuse = v; },
    startCalls,
  };
}

function makeCockpit() {
  const el = {
    mode: fakeTextEl(),
    svc: fakeSvc(),
    calBadge: fakeTextEl(),
    health: { innerHTML: "" },
    rigConnected: fakeTextEl(),
    rigPanTilt: fakeTextEl(),
    rigMoving: fakeTextEl(),
    rigBattery: fakeTextEl(),
    rigTelemetryAge: fakeTextEl(),
    rigImuPitchRoll: fakeTextEl(),
    rigImuTP: fakeTextEl(),
    trkState: fakeTextEl(),
    trkTarget: fakeTextEl(),
    trkAzEl: fakeTextEl(),
    trkRange: fakeTextEl(),
    trkError: fakeTextEl(),
    trkLimits: fakeTextEl(),
    trkOffset: fakeTextEl(),
    adsbCount: fakeTextEl(),
    adsbList: fakeAdsbList(),
    jog: { classList: fakeClassList() },
    jogMode: fakeTextEl(),
    jogUp: fakeButton(),
    jogDown: fakeButton(),
    jogLeft: fakeButton(),
    jogRight: fakeButton(),
  };
  const jogHold = fakeHold();
  const nudgeHold = fakeHold();
  const post = vi.fn(async () => ({ ok: true }));
  const cockpit = new Cockpit({ el, jogHold, nudgeHold, post });
  return { cockpit, el, jogHold, nudgeHold, post };
}

const baseState = {
  mode: "idle",
  services: { readsb: "active", tb3mcp: "active", tb3agent: "inactive", llama: "unknown" },
  rig: { connected: true, panDeg: 12.5, tiltDeg: -3, moving: false, batteryV: 12.1, telemetryAgeMs: 40, imu: null },
  tracking: { state: "stopped", hex: null, callsign: null, targetAzDeg: null, targetElDeg: null, targetRangeM: null, pointingErrorDeg: null, panLimited: false, tiltLimited: false },
  adsb: { rawCount: 3, trackable: [] as unknown[] },
  calibration: { calibrated: false, provisional: false },
  sunGuard: { state: "unknown", locked: false, separationDeg: null },
};

describe("Cockpit telemetry render", () => {
  it("renders rig/tracking/services text", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render(baseState);
    expect(el.rigConnected.textContent).toBe("yes");
    expect(el.rigPanTilt.textContent).toBe("12.5° / -3.0°");
    expect(el.trkState.textContent).toBe("stopped");
    expect(el.svc.readsb.className).toBe("led led-active");
    expect(el.mode.dataset.mode).toBe("idle");
  });

  it("renders the calibration badge via calibrationBadge, distinguishing provisional from calibrated", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, calibration: { calibrated: true } });
    expect(el.calBadge.textContent).toMatch(/CALIBRATED/);
    const calibratedCls = el.calBadge.className;

    cockpit.render({ ...baseState, calibration: { provisional: true } });
    expect(el.calBadge.textContent).toMatch(/PROVISIONAL/);
    expect(el.calBadge.className).not.toBe(calibratedCls);
  });

  it("tolerates a missing/degraded payload without throwing", () => {
    const { cockpit } = makeCockpit();
    expect(() => cockpit.render({})).not.toThrow();
    expect(() => cockpit.render(undefined as unknown as Record<string, unknown>)).not.toThrow();
  });

  it("works with a partial el (only some elements provided), like CameraPanel's optional deps", () => {
    const { jogHold, nudgeHold, post } = makeCockpit();
    const cockpit = new Cockpit({ el: { mode: fakeTextEl() }, jogHold, nudgeHold, post });
    expect(() => cockpit.render(baseState)).not.toThrow();
  });
});

describe("Cockpit aircraft list", () => {
  const row = { hex: "a1b2c3", callsign: "AAL1", azimuth_deg: 47, elevation_deg: 31, range_km: 8.2, altitude_m: 3000, ground_speed_kt: 250, est_track_sec: 30 };

  it("renders a Track button per trackable row and wires it to post(\"track\", {hex})", () => {
    const { cockpit, el, post } = makeCockpit();
    cockpit.render({ ...baseState, adsb: { rawCount: 1, trackable: [row] } });

    const buttons = el.adsbList.querySelectorAll("button.track-btn");
    expect(buttons.length).toBe(1);
    buttons[0].click();
    expect(post).toHaveBeenCalledWith("track", { hex: "a1b2c3" });
  });

  it("shows an empty-list placeholder when nothing is trackable", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, adsb: { rawCount: 0, trackable: [] } });
    expect(el.adsbList.innerHTML).toContain("no trackable aircraft");
  });
});

// -- the AIM block: this IS the point of this task. The four direction
// buttons must mean something different depending on state, and the label
// must always agree with what they actually do.
describe("Cockpit AIM block", () => {
  it("is JOG when idle, and pressing a direction drives JogHold (not NudgeHold)", () => {
    const { cockpit, el, jogHold, nudgeHold } = makeCockpit();
    cockpit.render(baseState); // tracking.state: "stopped"

    expect(cockpit.mode).toBe("jog");
    expect(el.jogMode.textContent).toBe("JOG");
    expect(el.jogUp.disabled).toBe(false);

    el.jogUp.fire("pointerdown");
    expect(jogHold.startCalls).toEqual([{ panMul: 0, tiltMul: 1 }]);
    expect(nudgeHold.startCalls.length).toBe(0);

    el.jogUp.fire("pointerup");
    expect(jogHold.stop).toHaveBeenCalled();
  });

  it("is TRIM while tracking, shows the live offset, and pressing a direction drives NudgeHold (not JogHold)", () => {
    const { cockpit, el, jogHold, nudgeHold } = makeCockpit();
    cockpit.render({
      ...baseState,
      tracking: { ...baseState.tracking, state: "tracking", offsetPanDeg: 1.8, offsetTiltDeg: -0.4 },
    });

    expect(cockpit.mode).toBe("trim");
    expect(el.jogMode.textContent).toContain("TRIM");
    expect(el.jogMode.textContent).toContain("1.80");
    expect(el.jogMode.textContent).toContain("-0.40");
    expect(el.jog.classList.has("jog-mode-trim")).toBe(true);

    el.jogRight.fire("pointerdown");
    expect(nudgeHold.startCalls).toEqual([{ panMul: -1, tiltMul: 0 }]);
    expect(jogHold.startCalls.length).toBe(0);
  });

  it("counts \"acquiring\" and \"waiting\" as trim too -- the tracker already owns the rig", () => {
    const { cockpit } = makeCockpit();
    cockpit.render({ ...baseState, tracking: { ...baseState.tracking, state: "acquiring" } });
    expect(cockpit.mode).toBe("trim");
  });

  it("is locked under E-STOP and shows the reason -- direction buttons disabled", () => {
    const { cockpit, el, jogHold, nudgeHold } = makeCockpit();
    cockpit.render({ ...baseState, estopLatched: true });

    expect(cockpit.mode).toBe("locked");
    expect(el.jogMode.textContent).toMatch(/LOCKED/);
    expect(el.jogMode.textContent).toMatch(/E-STOP/);
    for (const b of [el.jogUp, el.jogDown, el.jogLeft, el.jogRight]) expect(b.disabled).toBe(true);

    // A disabled button's own pointerdown handler must refuse (defense in
    // depth -- mirrors the old wireJogHoldButton's `if (btn.disabled) return`).
    el.jogUp.fire("pointerdown");
    expect(jogHold.startCalls.length).toBe(0);
    expect(nudgeHold.startCalls.length).toBe(0);
  });

  it("is locked under sun lock too, and names the sun lock (not E-STOP) as the reason", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, sunLocked: true, sunGuard: { state: "sun-blocked", locked: true, separationDeg: 8.5 } });

    expect(cockpit.mode).toBe("locked");
    expect(el.jogMode.textContent).toMatch(/sun lock/i);
    expect(el.jogMode.textContent).not.toMatch(/E-STOP/);
  });

  // REGRESSION guard for the exact ordering ui-mode.js's aimMode documents:
  // E-STOP/sun-lock must win over tracking state, not the other way round.
  it("E-STOP wins over an active tracking session -- locked, not trim", () => {
    const { cockpit } = makeCockpit();
    cockpit.render({ ...baseState, tracking: { ...baseState.tracking, state: "tracking" }, estopLatched: true });
    expect(cockpit.mode).toBe("locked");
  });

  it("a mid-hold gate trip (hold refuses to start) leaves the UI un-pressed", () => {
    const { cockpit, el, jogHold } = makeCockpit();
    jogHold.setRefuse(true); // simulates JogHold's own isGated() refusing
    cockpit.render(baseState);

    el.jogUp.fire("pointerdown");
    expect(el.jogUp.classList.has("jog-holding")).toBe(false);
  });

  it("only one direction can be held at a time", () => {
    const { cockpit, el, jogHold } = makeCockpit();
    cockpit.render(baseState);

    el.jogUp.fire("pointerdown");
    el.jogLeft.fire("pointerdown"); // ignored: jogUp already owns the hold
    expect(jogHold.start).toHaveBeenCalledTimes(1);

    el.jogUp.fire("pointerup");
    el.jogLeft.fire("pointerdown"); // now free to start
    expect(jogHold.start).toHaveBeenCalledTimes(2);
  });

  it("pointerleave and pointercancel stop the hold same as pointerup", () => {
    for (const endEvt of ["pointerleave", "pointercancel"]) {
      const { cockpit, el, jogHold } = makeCockpit();
      cockpit.render(baseState);
      el.jogUp.fire("pointerdown");
      el.jogUp.fire(endEvt);
      expect(jogHold.stop).toHaveBeenCalled();
    }
  });

  it("stopHoldUnconditionally halts whichever hold is active, for window-blur/tab-hidden callers", () => {
    const { cockpit, el, jogHold, nudgeHold } = makeCockpit();
    cockpit.render({ ...baseState, tracking: { ...baseState.tracking, state: "tracking" } });
    el.jogUp.fire("pointerdown");
    expect(nudgeHold.active).toBe(true);

    cockpit.stopHoldUnconditionally();
    expect(nudgeHold.stop).toHaveBeenCalled();
    expect(jogHold.stop).toHaveBeenCalled(); // both stopped unconditionally, matching the old app.js behaviour
  });

  it("startHold/stopHold are public, for the keyboard-delegation caller (app.js)", () => {
    const { cockpit, jogHold } = makeCockpit();
    cockpit.render(baseState);
    cockpit.startHold("jog-down");
    expect(jogHold.startCalls).toEqual([{ panMul: 0, tiltMul: -1 }]);
    cockpit.stopHold("jog-down");
    expect(jogHold.stop).toHaveBeenCalled();
  });

  it("startHold refuses while locked -- keyboard has no [disabled] to stop it, so this is the defense-in-depth path", () => {
    const { cockpit, jogHold } = makeCockpit();
    cockpit.render({ ...baseState, estopLatched: true });
    cockpit.startHold("jog-up");
    expect(jogHold.startCalls.length).toBe(0);
  });

  it("re-enables the buttons and clears the locked label once unlocked again", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, estopLatched: true });
    expect(el.jogUp.disabled).toBe(true);

    cockpit.render(baseState);
    expect(el.jogUp.disabled).toBe(false);
    expect(el.jogMode.textContent).toBe("JOG");
  });
});
