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

// The aircraft list is rebuilt via innerHTML each render(); this fake parses
// just enough of the real markup -- each <button>'s class (track-btn/
// sight-btn), data-hex, disabled attribute, and title -- to reproduce
// querySelectorAll("button.track-btn"/"button.sight-btn") and the disabled/
// title state aircraftRowActions drives, without a real DOM/parser.
//
// Click wiring models real event delegation (review fix, finding C-3):
// cockpit.js no longer attaches a listener to each button directly (that
// listener would be silently dropped the moment the NEXT render() rewrites
// #adsb-list's innerHTML); it wires ONE listener on #adsb-list itself, via
// this fake's own addEventListener, and every button's .click() dispatches
// a synthetic event through THAT container-level handler -- exactly how a
// real click bubbles from a button up to its stable ancestor. A fake button
// therefore has no addEventListener of its own any more (kept as a no-op
// so any accidental direct-listener code fails loudly by never firing,
// rather than silently working here but not in a real browser).
interface FakeAdsbButton {
  className: string;
  dataset: { hex: string };
  disabled: boolean;
  title: string;
  addEventListener: (evt: string, cb: () => void) => void;
  click: () => void;
}

function fakeAdsbList() {
  let html = "";
  let allButtons: FakeAdsbButton[] = [];
  const containerHandlers: Record<string, Array<(evt: unknown) => void>> = {};
  return {
    get innerHTML() { return html; },
    set innerHTML(v: string) {
      html = v;
      const tags = [...v.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
      allButtons = tags.map((tag) => {
        const className = tag.match(/class="([^"]*)"/)?.[1] ?? "";
        const hex = tag.match(/data-hex="([^"]*)"/)?.[1] ?? "";
        const title = tag.match(/title="([^"]*)"/)?.[1] ?? "";
        const disabled = /\sdisabled(?=[\s>])/.test(tag);
        const btn: FakeAdsbButton = {
          className,
          dataset: { hex },
          disabled,
          title,
          addEventListener() {}, // no-op -- see this function's own doc above
          click() {
            const evt = { target: { closest: (sel: string) => (sel === `button.${className}` ? btn : null) } };
            for (const cb of containerHandlers.click ?? []) cb(evt);
          },
        };
        return btn;
      });
    },
    querySelectorAll(sel: string) {
      const cls = sel.replace(/^button\./, "");
      return allButtons.filter((b) => b.className === cls);
    },
    addEventListener(evt: string, cb: (e: unknown) => void) { (containerHandlers[evt] ??= []).push(cb); },
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
  adsb: { rawCount: 3, aircraft: [] as unknown[] },
  calibration: { calibrated: false, provisional: false },
  sunGuard: { state: "unknown", locked: false, separationDeg: null },
};

// Extracts the LAST "led led-xxx" class out of #health's rendered innerHTML
// -- _renderHealth emits rig, then sun, then svc dots in that fixed order,
// so the last match is always the services dot.
function svcDotClass(html: string): string | undefined {
  const matches = [...html.matchAll(/class="led (led-[a-z]+)"/g)];
  return matches[matches.length - 1]?.[1];
}

describe("Cockpit health glance -- service dot semantics", () => {
  // REGRESSION: this project has hit "permanently-amber/red indicator nobody
  // trusts" twice already (capture-skipped, capture-error). tb3agent reads
  // "inactive" whenever Autonomous mode is off -- the default, entirely
  // healthy state during ordinary manual tracking -- and must never render
  // the same as a real fault.
  it("is healthy when every service is active", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, services: { readsb: "active", tb3mcp: "active", tb3agent: "active", llama: "active" } });
    expect(svcDotClass(el.health.innerHTML)).toBe("led-active");
  });

  it("REGRESSION: tb3agent:\"inactive\" (Autonomous mode simply off) with everything else active is still healthy, not unknown -- inactive is a deliberate state, not a fault", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, services: { readsb: "active", tb3mcp: "active", tb3agent: "inactive", llama: "active" } });
    expect(svcDotClass(el.health.innerHTML)).toBe("led-active");
  });

  it("is failed when any service has genuinely failed", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, services: { readsb: "active", tb3mcp: "failed", tb3agent: "inactive", llama: "active" } });
    expect(svcDotClass(el.health.innerHTML)).toBe("led-failed");
  });

  it("is unknown (not yet polled / daemon unreachable) when a service is genuinely unknown, distinct from both healthy and failed", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, services: { readsb: "active", tb3mcp: "unknown", tb3agent: "active", llama: "active" } });
    const cls = svcDotClass(el.health.innerHTML);
    expect(cls).toBe("led-unknown");
    expect(cls).not.toBe("led-active");
    expect(cls).not.toBe("led-failed");
  });

  it("failed outranks unknown when both are present", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, services: { readsb: "failed", tb3mcp: "unknown", tb3agent: "active", llama: "active" } });
    expect(svcDotClass(el.health.innerHTML)).toBe("led-failed");
  });
});

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
  const row = { hex: "a1b2c3", callsign: "AAL1", azimuth_deg: 47, elevation_deg: 31, range_km: 8.2, altitude_m: 3000, ground_speed_kt: 250, est_track_sec: 30, trackable: true };
  const calibratedWithRig = { calibrated: true, rig: { lat: 1, lon: 2, height: 3 } };

  it("renders a Track button per row sourced from adsb.aircraft (not the pre-filtered adsb.trackable) and wires it to post(\"track\", {hex})", () => {
    const { cockpit, el, post } = makeCockpit();
    cockpit.render({ ...baseState, calibration: calibratedWithRig, adsb: { rawCount: 1, aircraft: [row] } });

    const buttons = el.adsbList.querySelectorAll("button.track-btn");
    expect(buttons.length).toBe(1);
    expect(buttons[0].disabled).toBe(false);
    buttons[0].click();
    expect(post).toHaveBeenCalledWith("track", { hex: "a1b2c3" });
  });

  it("renders a Sight button per row and wires it to post(\"calibrate/sight-aircraft\", {hex})", () => {
    const { cockpit, el, post } = makeCockpit();
    cockpit.render({ ...baseState, calibration: calibratedWithRig, adsb: { rawCount: 1, aircraft: [row] } });

    const buttons = el.adsbList.querySelectorAll("button.sight-btn");
    expect(buttons.length).toBe(1);
    expect(buttons[0].disabled).toBe(false);
    buttons[0].click();
    expect(post).toHaveBeenCalledWith("calibrate/sight-aircraft", { hex: "a1b2c3" });
  });

  // REGRESSION: this IS the operator's blocker this task closes. adsb.trackable
  // is a separate only_trackable:true scan that requires calibration and is
  // empty without it (see scan_aircraft/track_aircraft in src/adsb-tools.ts) --
  // rendering from it would leave the list, and therefore [Track], empty on
  // exactly the pre-calibration bootstrap pass that needs a Track button.
  it("renders rows from adsb.aircraft even when adsb.trackable is empty and there is no calibration yet", () => {
    const { cockpit, el } = makeCockpit();
    const uncalRow = { ...row, trackable: null as boolean | null };
    cockpit.render({ ...baseState, calibration: {}, adsb: { rawCount: 1, aircraft: [uncalRow], trackable: [] } });
    expect(el.adsbList.querySelectorAll("button.track-btn").length).toBe(1);
  });

  it("disables Track (with a reason) when there is no orientation yet, and Sight (with a reason) when there is no rig location", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, calibration: {}, adsb: { rawCount: 1, aircraft: [row] } });

    const trackBtn = el.adsbList.querySelectorAll("button.track-btn")[0];
    const sightBtn = el.adsbList.querySelectorAll("button.sight-btn")[0];
    expect(trackBtn.disabled).toBe(true);
    expect(trackBtn.title).toMatch(/calibrat|north zero/i);
    expect(sightBtn.disabled).toBe(true);
    expect(sightBtn.title).toMatch(/location/i);
  });

  it("disables Track (with a reason) under E-STOP even when calibrated", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, calibration: calibratedWithRig, estopLatched: true, adsb: { rawCount: 1, aircraft: [row] } });
    const trackBtn = el.adsbList.querySelectorAll("button.track-btn")[0];
    expect(trackBtn.disabled).toBe(true);
    expect(trackBtn.title).toMatch(/stop/i);
  });

  // REGRESSION: the sun guard can park the rig under a PROVISIONAL
  // orientation too (src/track/supervisor.ts) -- exactly the drift-
  // calibration bootstrap window this feature exists for. track_aircraft
  // and sight_aircraft (src/adsb-tools.ts / src/geo-tools.ts) each refuse
  // identically under sun-lock; a button that looks available and then
  // fails with an unexplained server error is the same "greyed control with
  // no explanation" defect wearing a different hat.
  it("disables BOTH Track and Sight (each with a reason naming the sun lock) when sun-locked, even when otherwise fully ready", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, calibration: calibratedWithRig, sunLocked: true, adsb: { rawCount: 1, aircraft: [row] } });
    const trackBtn = el.adsbList.querySelectorAll("button.track-btn")[0];
    const sightBtn = el.adsbList.querySelectorAll("button.sight-btn")[0];
    expect(trackBtn.disabled).toBe(true);
    expect(trackBtn.title).toMatch(/sun/i);
    expect(sightBtn.disabled).toBe(true);
    expect(sightBtn.title).toMatch(/sun/i);
  });

  // E-STOP and sun-lock are independent checks -- each must disable Track on
  // its own, not merely in combination, so removing either check regresses
  // silently. (Sight has no independent E-STOP check by design -- see
  // task-6-report.md's Deviations -- so this is Track-only.)
  it("E-STOP and sun-lock each independently disable Track (neither alone is enough coverage for the other)", () => {
    const { cockpit, el } = makeCockpit();

    cockpit.render({ ...baseState, calibration: calibratedWithRig, estopLatched: true, sunLocked: false, adsb: { rawCount: 1, aircraft: [row] } });
    expect(el.adsbList.querySelectorAll("button.track-btn")[0].disabled).toBe(true);

    cockpit.render({ ...baseState, calibration: calibratedWithRig, estopLatched: false, sunLocked: true, adsb: { rawCount: 1, aircraft: [row] } });
    expect(el.adsbList.querySelectorAll("button.track-btn")[0].disabled).toBe(true);

    cockpit.render({ ...baseState, calibration: calibratedWithRig, estopLatched: false, sunLocked: false, adsb: { rawCount: 1, aircraft: [row] } });
    expect(el.adsbList.querySelectorAll("button.track-btn")[0].disabled).toBe(false);
  });

  it("shows an empty-list placeholder when no aircraft are in range", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, adsb: { rawCount: 0, aircraft: [] } });
    expect(el.adsbList.innerHTML).toContain("no aircraft in range");
  });

  // Review finding C-2: sight_aircraft commands no motion, but the row's
  // [Sight] button was gated only by the sun lock, not E-STOP -- the drawer
  // strip's [Sight it] and the physical joystick's Sight button both
  // already refuse under E-STOP too (a halted slew may no longer be
  // centred on the target). Companion to the Track-under-E-STOP test above.
  it("disables Sight (with a reason) under E-STOP, even when a rig location is known (C-2)", () => {
    const { cockpit, el } = makeCockpit();
    cockpit.render({ ...baseState, calibration: calibratedWithRig, estopLatched: true, adsb: { rawCount: 1, aircraft: [row] } });
    const sightBtn = el.adsbList.querySelectorAll("button.sight-btn")[0];
    expect(sightBtn.disabled).toBe(true);
    expect(sightBtn.title).toMatch(/stop/i);
  });

  // Review finding C-3: a fresh per-button listener used to be attached
  // after EVERY render() tick (~1Hz, driven by live ADS-B data) -- a press
  // whose pointerdown/pointerup straddled a tick landed on a button that
  // had just been detached and replaced, silently swallowing the click.
  // The fix delegates on the stable #adsb-list container, wired ONCE from
  // the constructor -- these two tests pin that specifically.
  describe("click delegation survives re-renders (C-3)", () => {
    it("a button reference from an EARLIER render still posts correctly after a LATER render rewrites #adsb-list", () => {
      const { cockpit, el, post } = makeCockpit();
      const rowA = { ...row, hex: "aaa111" };
      const rowB = { ...row, hex: "bbb222" };

      cockpit.render({ ...baseState, calibration: calibratedWithRig, adsb: { rawCount: 1, aircraft: [rowA] } });
      const staleTrackBtn = el.adsbList.querySelectorAll("button.track-btn")[0];

      // Rewrites #adsb-list's innerHTML wholesale, same as the next live
      // SSE tick -- staleTrackBtn is now an orphaned reference to a button
      // that no longer exists in the "current" render.
      cockpit.render({ ...baseState, calibration: calibratedWithRig, adsb: { rawCount: 1, aircraft: [rowB] } });

      staleTrackBtn.click();
      expect(post).toHaveBeenCalledWith("track", { hex: "aaa111" });
    });

    it("wires the click listener once (constructor), not per render -- N renders then a click still posts exactly once", () => {
      const { cockpit, el, post } = makeCockpit();
      for (let i = 0; i < 5; i++) {
        cockpit.render({ ...baseState, calibration: calibratedWithRig, adsb: { rawCount: 1, aircraft: [row] } });
      }
      el.adsbList.querySelectorAll("button.track-btn")[0].click();
      expect(post).toHaveBeenCalledTimes(1);
    });
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
