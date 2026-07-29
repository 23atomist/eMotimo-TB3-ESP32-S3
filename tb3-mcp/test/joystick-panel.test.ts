import { describe, it, expect } from "vitest";
import { renderJoystickEntry, mountJoystickEntry, renderJoystickSnapshot } from "../dashboard/public/joystick-panel.js";
import { SIGHT_BUTTON_INDEX, FINE_BUTTON_INDEX, ESTOP_BUTTON_INDICES } from "../dashboard/public/joystick-hold.js";

// -- renderJoystickEntry: same constancy requirement as sector.js's
// renderSectorEntry (see its own test's doc) -- this entry's live values
// (connection, axes, buttons, mode) are painted by direct DOM mutation, not
// baked into the html string, so drawer.js's render-skip is never defeated
// by an ordinary ~1Hz refresh() tick while this entry stays open. -----------
describe("renderJoystickEntry", () => {
  it("returns the exact same string every time", () => {
    expect(renderJoystickEntry()).toBe(renderJoystickEntry());
  });

  it("bakes in joystick-hold.js's own exported button-index constants, never hand-typed", () => {
    const html = renderJoystickEntry();
    expect(html).toContain(`button ${SIGHT_BUTTON_INDEX}`);
    expect(html).toContain(`button ${FINE_BUTTON_INDEX}`);
    expect(html).toContain(ESTOP_BUTTON_INDICES.join(" + "));
  });

  it("carries every id the paint/mount functions depend on", () => {
    const html = renderJoystickEntry();
    for (const id of [
      "joystick-conn", "joystick-mode", "joystick-fine", "joystick-deadzone",
      "joystick-deadzone-value", "joystick-axes", "joystick-buttons",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

function fakeSlider() {
  return { value: "" };
}
function fakeTextEl() {
  return { textContent: "" };
}
function fakeContainerEl() {
  return { innerHTML: "" };
}
function fakeClassList() {
  const set = new Set<string>();
  return { toggle: (c: string, force?: boolean) => {
    const on = force === undefined ? !set.has(c) : force;
    if (on) set.add(c); else set.delete(c);
    return on;
  }, has: (c: string) => set.has(c) };
}

function fakeRoot() {
  const nodes: Record<string, unknown> = {
    "#joystick-deadzone": fakeSlider(),
    "#joystick-deadzone-value": fakeTextEl(),
    "#joystick-conn": fakeTextEl(),
    "#joystick-axes": fakeContainerEl(),
    "#joystick-buttons": fakeContainerEl(),
    "#joystick-mode": fakeTextEl(),
    "#joystick-fine": { hidden: true },
  };
  return { nodes, querySelector: (sel: string) => nodes[sel] ?? null };
}

describe("mountJoystickEntry", () => {
  it("syncs the deadzone slider's displayed value to the CURRENT joystickHold.deadzone", () => {
    const root = fakeRoot();
    mountJoystickEntry(root, { deadzone: 0.27 });
    expect((root.nodes["#joystick-deadzone"] as ReturnType<typeof fakeSlider>).value).toBe("0.27");
    expect((root.nodes["#joystick-deadzone-value"] as ReturnType<typeof fakeTextEl>).textContent).toBe("0.27");
  });

  it("is a harmless no-op when the Joystick entry isn't mounted", () => {
    expect(() => mountJoystickEntry({ querySelector: () => null }, { deadzone: 0.15 })).not.toThrow();
  });
});

describe("renderJoystickSnapshot", () => {
  it("reflects a connected pad: id text, axes, buttons, and the cockpit chip's toggle-on class", () => {
    const root = fakeRoot();
    const chip = { classList: fakeClassList() };
    renderJoystickSnapshot(root, chip, () => false, {
      connected: true, id: "Xbox Wireless Controller",
      axes: [0.5, -0.5], buttons: [{ pressed: true }, { pressed: false }],
    });
    expect((root.nodes["#joystick-conn"] as ReturnType<typeof fakeTextEl>).textContent).toContain("Xbox Wireless Controller");
    expect(chip.classList.has("toggle-on")).toBe(true);
    expect((root.nodes["#joystick-axes"] as ReturnType<typeof fakeContainerEl>).innerHTML).toContain("axis 0");
    expect((root.nodes["#joystick-buttons"] as ReturnType<typeof fakeContainerEl>).innerHTML).toContain("pressed");
  });

  it("shows JOG vs TRIM (aim offset) from the isTrimActive predicate, not a local flag", () => {
    const root = fakeRoot();
    renderJoystickSnapshot(root, null, () => true, { connected: false, axes: [], buttons: [] });
    expect((root.nodes["#joystick-mode"] as ReturnType<typeof fakeTextEl>).textContent).toMatch(/TRIM/);
  });

  it("is a harmless no-op when the Joystick entry isn't mounted (only the cockpit chip updates)", () => {
    const chip = { classList: fakeClassList() };
    expect(() => renderJoystickSnapshot({ querySelector: () => null }, chip, () => false, {
      connected: true, axes: [], buttons: [],
    })).not.toThrow();
    expect(chip.classList.has("toggle-on")).toBe(true);
  });
});
