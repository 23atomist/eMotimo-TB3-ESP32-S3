import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  JoystickHold, POLL_INTERVAL_MS,
  SIGHT_BUTTON_INDEX, FINE_BUTTON_INDEX, ESTOP_BUTTON_INDICES,
} from "../dashboard/public/joystick-hold.js";

const MAX_DPS = 19; // config.ts's maxJogDps default
const NUM_BUTTONS = 12;

function makeButtons(pressedIndices: number[]) {
  return Array.from({ length: NUM_BUTTONS }, (_, i) => ({
    pressed: pressedIndices.includes(i),
    value: pressedIndices.includes(i) ? 1 : 0,
  }));
}

// A mutable fake gamepad source standing in for navigator.getGamepads() --
// tests mutate `.state` between advanceTimersByTimeAsync calls to simulate
// the operator moving the stick / pressing buttons / unplugging the pad.
function fakeGamepadSource() {
  const state = { connected: true, axes: [0, 0, 0, 0] as number[], pressed: [] as number[] };
  const getGamepads = () => {
    if (!state.connected) return [null];
    return [{ id: "Test Pad", axes: state.axes, buttons: makeButtons(state.pressed) }];
  };
  return { getGamepads, state };
}

function fakePostJog() {
  const calls: Array<{ panDps: number; tiltDps: number; durationMs: number }> = [];
  let okReturn = true;
  let shouldThrow = false;
  const post = vi.fn(async (panDps: number, tiltDps: number, durationMs: number) => {
    calls.push({ panDps, tiltDps, durationMs });
    if (shouldThrow) throw new Error("network connection was lost");
    return okReturn;
  });
  return { post, calls, setOk: (v: boolean) => { okReturn = v; }, setThrows: (v: boolean) => { shouldThrow = v; } };
}

function fakePostNudge() {
  const calls: Array<{ deltaPanDeg: number; deltaTiltDeg: number }> = [];
  let okReturn = true;
  const post = vi.fn(async (deltaPanDeg: number, deltaTiltDeg: number) => {
    calls.push({ deltaPanDeg, deltaTiltDeg });
    return okReturn;
  });
  return { post, calls, setOk: (v: boolean) => { okReturn = v; } };
}

function makeHold() {
  const gamepad = fakeGamepadSource();
  const jog = fakePostJog();
  const nudge = fakePostNudge();
  const onSight = vi.fn();
  const onEstop = vi.fn();
  const onFailure = vi.fn();
  const onSnapshot = vi.fn();
  const flags = { tracking: false, gated: false, sightGated: false, maxJogDps: MAX_DPS };

  const hold = new JoystickHold({
    getGamepads: gamepad.getGamepads,
    postJog: jog.post,
    postNudge: nudge.post,
    onSight, onEstop, onFailure, onSnapshot,
    isTrackingActive: () => flags.tracking,
    isGated: () => flags.gated,
    isSightGated: () => flags.sightGated,
    getMaxJogDps: () => flags.maxJogDps,
  });

  return { hold, gamepad, jog, nudge, onSight, onEstop, onFailure, onSnapshot, flags };
}

describe("JoystickHold", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe("proportional jog (not tracking)", () => {
    it("posts a jog vector proportional to stick deflection on start", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0]; // full pan deflection, left stick
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(jog.calls.length).toBe(1);
      // PAN_SIGN inverts raw +1 (right) to a negative panDps -- see the
      // module doc's note on matching the existing button convention.
      expect(jog.calls[0].panDps).toBeCloseTo(-MAX_DPS, 5);
      expect(jog.calls[0].tiltDps).toBeCloseTo(0, 9); // -0 is a valid "zero" here (TILT_SIGN * 0)
    });

    it("never calls postNudge while not tracking", async () => {
      const { hold, gamepad, jog, nudge } = makeHold();
      gamepad.state.axes = [0, 1, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(jog.calls.length).toBeGreaterThan(0);
      expect(nudge.calls.length).toBe(0);
    });

    it("uses the live maxJogDps, not a hardcoded constant", async () => {
      const { hold, gamepad, jog, flags } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      flags.maxJogDps = 40;
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(jog.calls[0].panDps).toBeCloseTo(-40, 5);

      flags.maxJogDps = 5;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(jog.calls[jog.calls.length - 1].panDps).toBeCloseTo(-5, 5);
    });

    it("fine mode (right trigger held) halves the commanded rate", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      gamepad.state.pressed = [FINE_BUTTON_INDEX];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(jog.calls[0].panDps).toBeCloseTo(-MAX_DPS * 0.5, 5);
    });
  });

  describe("deadzone", () => {
    it("commands nothing while both axes are within the deadzone", async () => {
      const { hold, gamepad, jog, nudge } = makeHold();
      gamepad.state.axes = [0.05, -0.05, 0, 0]; // well inside the default deadzone
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      expect(jog.calls.length).toBe(0);
      expect(nudge.calls.length).toBe(0);
    });
  });

  describe("mode selection", () => {
    it("drives the jog vector while not tracking", async () => {
      const { hold, gamepad, jog, nudge, flags } = makeHold();
      flags.tracking = false;
      gamepad.state.axes = [0, 1, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(jog.calls.length).toBe(1);
      expect(nudge.calls.length).toBe(0);
    });

    it("nudges the aim offset (TRIM) while tracking", async () => {
      const { hold, gamepad, jog, nudge, flags } = makeHold();
      flags.tracking = true;
      gamepad.state.axes = [0, 1, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(nudge.calls.length).toBe(1);
      expect(jog.calls.length).toBe(0);
      expect(nudge.calls[0].deltaTiltDeg).not.toBe(0);
    });
  });

  describe("button edge detection", () => {
    it("fires the sight action exactly once for a button held across many polls", async () => {
      const { hold, gamepad, onSight } = makeHold();
      gamepad.state.pressed = [SIGHT_BUTTON_INDEX];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); // held for 5 ticks
      expect(onSight).toHaveBeenCalledTimes(1);

      gamepad.state.pressed = [];
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      gamepad.state.pressed = [SIGHT_BUTTON_INDEX]; // press again
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(onSight).toHaveBeenCalledTimes(2); // a second, separate press fires again
    });

    it("does not fire the sight action while calibration writes are gated (E-STOP)", async () => {
      const { hold, gamepad, onSight, flags } = makeHold();
      flags.sightGated = true;
      gamepad.state.pressed = [SIGHT_BUTTON_INDEX];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(onSight).not.toHaveBeenCalled();
    });

    it("fires E-STOP exactly once for the combo held across many polls, not per poll", async () => {
      const { hold, gamepad, onEstop } = makeHold();
      gamepad.state.pressed = [...ESTOP_BUTTON_INDICES];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6);
      expect(onEstop).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire E-STOP for only one of the two combo buttons", async () => {
      const { hold, gamepad, onEstop } = makeHold();
      gamepad.state.pressed = [ESTOP_BUTTON_INDICES[0]];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(onEstop).not.toHaveBeenCalled();
    });

    // E-STOP must always be reachable -- it is what clears the very gates
    // that block jog/nudge/sight, so it must never itself be blocked by them.
    it("fires E-STOP even while the motion gate and sight gate are both closed", async () => {
      const { hold, gamepad, onEstop, flags } = makeHold();
      flags.gated = true;
      flags.sightGated = true;
      gamepad.state.pressed = [...ESTOP_BUTTON_INDICES];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(onEstop).toHaveBeenCalledTimes(1);
    });
  });

  describe("motion gating (E-STOP / sun-lock)", () => {
    it("does not post jog/nudge while gated", async () => {
      const { hold, gamepad, jog, nudge, flags } = makeHold();
      flags.gated = true;
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(jog.calls.length).toBe(0);
      expect(nudge.calls.length).toBe(0);
    });

    it("notifies onFailure once when the gate closes while deflected, not once per poll", async () => {
      const { hold, gamepad, onFailure, flags } = makeHold();
      flags.gated = true;
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it("re-arms after the stick recentres, even while still gated (a fresh deflection re-latches once)", async () => {
      const { hold, gamepad, onFailure, flags } = makeHold();
      flags.gated = true;
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(onFailure).toHaveBeenCalledTimes(1);

      gamepad.state.axes = [0, 0, 0, 0]; // centre
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      gamepad.state.axes = [1, 0, 0, 0]; // deflect again, still gated
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(onFailure).toHaveBeenCalledTimes(2);
    });

    it("resumes posting once the gate opens and the stick is deflected again", async () => {
      const { hold, gamepad, jog, flags } = makeHold();
      flags.gated = true;
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      expect(jog.calls.length).toBe(0);

      flags.gated = false;
      gamepad.state.axes = [0, 0, 0, 0]; // recentre to clear the latch
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      gamepad.state.axes = [1, 0, 0, 0]; // deflect again
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(jog.calls.length).toBeGreaterThan(0);
    });
  });

  describe("post failure handling", () => {
    it("a failed post halts further posting until the stick recentres", async () => {
      const { hold, gamepad, jog, onFailure } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0); // first post ok

      jog.setOk(false);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // this post fails
      const countAfterFailure = jog.calls.length;
      expect(onFailure).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); // still deflected, must not retry
      expect(jog.calls.length).toBe(countAfterFailure);
    });

    it("a post that throws halts the same way", async () => {
      const { hold, gamepad, jog, onFailure } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      jog.setThrows(true);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      expect(onFailure).toHaveBeenCalledTimes(1);

      const countAfterThrow = jog.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(jog.calls.length).toBe(countAfterThrow);
    });
  });

  describe("loss of control -- explicit stop", () => {
    it("gamepaddisconnected posts an explicit zero jog when a rate was in flight", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(jog.calls[jog.calls.length - 1].panDps).not.toBe(0);

      hold.handleDisconnected();
      const last = jog.calls[jog.calls.length - 1];
      expect(last.panDps).toBe(0);
      expect(last.tiltDps).toBe(0);
    });

    it("a gamepad vanishing (found missing on the next poll) also posts an explicit zero jog", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      gamepad.state.connected = false;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      const last = jog.calls[jog.calls.length - 1];
      expect(last.panDps).toBe(0);
      expect(last.tiltDps).toBe(0);
    });

    // window blur / visibilitychange-hidden are wired by app.js directly to
    // haltDrive() (there is no browser event this class listens for itself,
    // by design -- see the module doc) -- this asserts haltDrive() itself
    // has the required effect.
    it("haltDrive() (wired to window blur / visibilitychange hidden) posts an explicit zero jog", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [0, 1, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      hold.haltDrive();
      const last = jog.calls[jog.calls.length - 1];
      expect(last.panDps).toBe(0);
      expect(last.tiltDps).toBe(0);
    });

    it("destroy() (the polling loop stopping) posts an explicit zero jog and stops future ticks", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      hold.destroy();
      const last = jog.calls[jog.calls.length - 1];
      expect(last.panDps).toBe(0);
      expect(last.tiltDps).toBe(0);
      expect(hold.running).toBe(false);

      const countAfterDestroy = jog.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(jog.calls.length).toBe(countAfterDestroy); // no further ticks at all
    });

    // TRIM has no standing rate to cancel (matches NudgeHold.stop()) -- none
    // of the loss-of-control triggers should post an extra correction.
    it("does NOT post an extra nudge on disconnect/blur/destroy while in TRIM mode", async () => {
      const { hold, gamepad, nudge, flags } = makeHold();
      flags.tracking = true;
      gamepad.state.axes = [0, 1, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);
      const countAfterFirst = nudge.calls.length;
      expect(countAfterFirst).toBeGreaterThan(0);

      hold.handleDisconnected();
      hold.haltDrive();
      expect(nudge.calls.length).toBe(countAfterFirst); // unchanged
    });
  });

  describe("bounded post rate", () => {
    it("posts at a fixed, modest cadence while continuously deflected -- not once per animation frame", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(1000);

      // ~10Hz over 1000ms (immediate post + one per POLL_INTERVAL_MS) --
      // nowhere near a 60fps requestAnimationFrame rate, which this loop
      // deliberately never uses.
      expect(jog.calls.length).toBeGreaterThanOrEqual(9);
      expect(jog.calls.length).toBeLessThanOrEqual(11);
    });

    it("never posts a jog duration longer than the poll interval", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      await vi.advanceTimersByTimeAsync(500);
      for (const call of jog.calls) {
        expect(call.durationMs).toBeLessThanOrEqual(POLL_INTERVAL_MS);
      }
    });
  });

  describe("live snapshot for the input display", () => {
    it("reports connected state, axes, and buttons every poll", async () => {
      const { hold, gamepad, onSnapshot } = makeHold();
      gamepad.state.axes = [0.3, -0.4, 0, 0];
      gamepad.state.pressed = [SIGHT_BUTTON_INDEX];
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(onSnapshot).toHaveBeenCalled();
      const snap = onSnapshot.mock.calls[onSnapshot.mock.calls.length - 1][0];
      expect(snap.connected).toBe(true);
      expect(snap.axes[0]).toBeCloseTo(0.3, 9);
      expect(snap.axes[1]).toBeCloseTo(-0.4, 9);
      expect(snap.buttons[SIGHT_BUTTON_INDEX].pressed).toBe(true);
    });

    it("reports disconnected state when no gamepad is present", async () => {
      const { hold, gamepad, onSnapshot } = makeHold();
      gamepad.state.connected = false;
      hold.start();
      await vi.advanceTimersByTimeAsync(0);

      const snap = onSnapshot.mock.calls[onSnapshot.mock.calls.length - 1][0];
      expect(snap.connected).toBe(false);
    });
  });

  describe("start/running", () => {
    it("start() is idempotent -- calling it twice does not double the post rate", async () => {
      const { hold, gamepad, jog } = makeHold();
      gamepad.state.axes = [1, 0, 0, 0];
      hold.start();
      hold.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(jog.calls.length).toBeLessThanOrEqual(11);
    });
  });
});
