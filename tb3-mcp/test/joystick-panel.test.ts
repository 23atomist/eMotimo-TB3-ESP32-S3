import { describe, it, expect, vi } from "vitest";
import {
  renderJoystickEntry, mountJoystickEntry, renderJoystickSnapshot, wireJoystickDelegates,
} from "../dashboard/public/joystick-panel.js";
import { SIGHT_BUTTON_INDEX, FINE_BUTTON_INDEX, ESTOP_BUTTON_INDICES } from "../dashboard/public/joystick-hold.js";
import { SENSITIVITY_DEFAULT } from "../dashboard/public/joystick-math.js";

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
      "joystick-sensitivity", "joystick-sensitivity-value", "joystick-sensitivity-rate",
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
    "#joystick-sensitivity": fakeSlider(),
    "#joystick-sensitivity-value": fakeTextEl(),
    "#joystick-sensitivity-rate": fakeTextEl(),
    "#joystick-conn": fakeTextEl(),
    "#joystick-axes": fakeContainerEl(),
    "#joystick-buttons": fakeContainerEl(),
    "#joystick-mode": fakeTextEl(),
    "#joystick-fine": { hidden: true },
  };
  return { nodes, querySelector: (sel: string) => nodes[sel] ?? null, addEventListener: vi.fn() };
}

function fakeJoystickHold(overrides: Partial<{ deadzone: number; sensitivity: number; getMaxJogDps: () => number }> = {}) {
  return {
    deadzone: 0.15,
    sensitivity: SENSITIVITY_DEFAULT,
    getMaxJogDps: () => 19,
    ...overrides,
  };
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

  it("is a harmless no-op for the sensitivity block when joystickHold has no opinion on sensitivity (a partial/older stub)", () => {
    const root = fakeRoot();
    expect(() => mountJoystickEntry(root, { deadzone: 0.27 })).not.toThrow();
  });

  it("syncs the sensitivity slider's displayed value, and shows the resulting max rate (not a bare fraction)", () => {
    const root = fakeRoot();
    mountJoystickEntry(root, fakeJoystickHold({ sensitivity: 0.4, getMaxJogDps: () => 20 }));
    expect((root.nodes["#joystick-sensitivity"] as ReturnType<typeof fakeSlider>).value).toBe("0.4");
    expect((root.nodes["#joystick-sensitivity-value"] as ReturnType<typeof fakeTextEl>).textContent).toBe("0.40");
    expect((root.nodes["#joystick-sensitivity-rate"] as ReturnType<typeof fakeTextEl>).textContent).toBe("max 8.0°/s");
  });
});

describe("wireJoystickDelegates", () => {
  it("writes a moved deadzone slider straight to joystickHold.deadzone and updates its own readout", () => {
    const root = fakeRoot();
    const joystickHold = fakeJoystickHold({ deadzone: 0.15 });
    wireJoystickDelegates(root, joystickHold);
    const handler = (root.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1];
    handler({ target: { id: "joystick-deadzone", value: "0.22" } });
    expect(joystickHold.deadzone).toBeCloseTo(0.22, 9);
    expect((root.nodes["#joystick-deadzone-value"] as ReturnType<typeof fakeTextEl>).textContent).toBe("0.22");
  });

  it("writes a moved sensitivity slider straight to joystickHold.sensitivity and updates both its readout and the resulting max rate", () => {
    const root = fakeRoot();
    const joystickHold = fakeJoystickHold({ sensitivity: SENSITIVITY_DEFAULT, getMaxJogDps: () => 19 });
    wireJoystickDelegates(root, joystickHold);
    const handler = (root.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1];
    handler({ target: { id: "joystick-sensitivity", value: "0.5" } });
    expect(joystickHold.sensitivity).toBeCloseTo(0.5, 9);
    expect((root.nodes["#joystick-sensitivity-value"] as ReturnType<typeof fakeTextEl>).textContent).toBe("0.50");
    expect((root.nodes["#joystick-sensitivity-rate"] as ReturnType<typeof fakeTextEl>).textContent).toBe("max 9.5°/s");
  });

  it("ignores a non-finite slider value rather than writing NaN", () => {
    const root = fakeRoot();
    const joystickHold = fakeJoystickHold({ sensitivity: 0.35 });
    wireJoystickDelegates(root, joystickHold);
    const handler = (root.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0][1];
    handler({ target: { id: "joystick-sensitivity", value: "not-a-number" } });
    expect(joystickHold.sensitivity).toBe(0.35);
  });

  it("is a harmless no-op when root has no addEventListener (not yet mounted)", () => {
    expect(() => wireJoystickDelegates({}, fakeJoystickHold())).not.toThrow();
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
