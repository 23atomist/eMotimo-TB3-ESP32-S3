import { describe, it, expect } from "vitest";
import {
  DEADZONE_DEFAULT, CURVE_EXPONENT, FINE_MODE_FACTOR,
  SENSITIVITY_DEFAULT, SENSITIVITY_MIN, SENSITIVITY_MAX,
  applyDeadzone, applyCurve, axisToRate, maxRateForSensitivity,
  selectMode, MODE_JOG, MODE_TRIM,
  risingEdge, isPressed, allPressed,
} from "../dashboard/public/joystick-math.js";

describe("applyDeadzone", () => {
  it("produces exactly zero for inputs inside the deadzone", () => {
    expect(applyDeadzone(0, 0.15)).toBe(0);
    expect(applyDeadzone(0.1, 0.15)).toBe(0);
    expect(applyDeadzone(-0.1, 0.15)).toBe(0);
    expect(applyDeadzone(0.15, 0.15)).toBe(0); // boundary is inclusive
    expect(applyDeadzone(-0.15, 0.15)).toBe(0);
  });

  it("produces a small non-zero value just outside the deadzone", () => {
    const out = applyDeadzone(0.16, 0.15);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(0.05); // "small" -- nowhere near full scale
  });

  it("is sign-preserving just outside the deadzone on the negative side", () => {
    const out = applyDeadzone(-0.16, 0.15);
    expect(out).toBeLessThan(0);
    expect(out).toBeGreaterThan(-0.05);
  });

  it("rescales the remaining travel so full deflection still reaches +/-1", () => {
    expect(applyDeadzone(1, 0.15)).toBeCloseTo(1, 9);
    expect(applyDeadzone(-1, 0.15)).toBeCloseTo(-1, 9);
  });

  it("uses the generous default deadzone when none is given", () => {
    expect(applyDeadzone(0.1)).toBe(0);
    expect(DEADZONE_DEFAULT).toBeGreaterThan(0);
  });

  it("treats non-finite input as zero rather than propagating NaN/Infinity", () => {
    expect(applyDeadzone(NaN, 0.15)).toBe(0);
    expect(applyDeadzone(Infinity, 0.15)).toBe(0);
    expect(applyDeadzone(-Infinity, 0.15)).toBe(0);
  });

  it("clamps a degenerate deadzone (negative, >=1, non-finite) to something sane", () => {
    expect(() => applyDeadzone(0.5, -1)).not.toThrow();
    expect(() => applyDeadzone(0.5, NaN)).not.toThrow();
    expect(applyDeadzone(1, 1.5)).toBeGreaterThanOrEqual(-1); // never throws / never NaN
    expect(Number.isFinite(applyDeadzone(1, 1.5))).toBe(true);
  });
});

describe("applyCurve", () => {
  it("is sign-preserving", () => {
    expect(applyCurve(0.5)).toBeGreaterThan(0);
    expect(applyCurve(-0.5)).toBeLessThan(0);
    expect(applyCurve(0)).toBe(0);
  });

  it("is monotonic in magnitude across the input range", () => {
    const samples = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1];
    let prev = -1;
    for (const s of samples) {
      const out = Math.abs(applyCurve(s));
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
  });

  it("gives disproportionately small output for small input (fine control)", () => {
    // A squared curve: half deflection gives a quarter output, not half.
    expect(applyCurve(0.5)).toBeCloseTo(0.25, 9);
  });

  it("reaches exactly 1 at full deflection with the default exponent", () => {
    expect(applyCurve(1)).toBeCloseTo(1, 9);
    expect(applyCurve(-1)).toBeCloseTo(-1, 9);
  });

  it("respects a custom exponent", () => {
    expect(applyCurve(0.5, 3)).toBeCloseTo(0.125, 9);
  });

  it("defaults to CURVE_EXPONENT", () => {
    expect(applyCurve(0.5)).toBeCloseTo(applyCurve(0.5, CURVE_EXPONENT), 9);
  });
});

describe("axisToRate", () => {
  const MAX_DPS = 19; // config.ts's maxJogDps default

  it("is monotonic and sign-preserving end to end", () => {
    expect(axisToRate(0.5, MAX_DPS)).toBeGreaterThan(0);
    expect(axisToRate(-0.5, MAX_DPS)).toBeLessThan(0);
    expect(axisToRate(0, MAX_DPS)).toBe(0);
    expect(axisToRate(0.8, MAX_DPS)).toBeGreaterThan(axisToRate(0.5, MAX_DPS));
  });

  it("reaches exactly maxDps at full deflection", () => {
    expect(axisToRate(1, MAX_DPS)).toBeCloseTo(MAX_DPS, 9);
    expect(axisToRate(-1, MAX_DPS)).toBeCloseTo(-MAX_DPS, 9);
  });

  it("fine mode halves the rate at any deflection, including full", () => {
    expect(axisToRate(1, MAX_DPS, { fine: true })).toBeCloseTo(MAX_DPS * FINE_MODE_FACTOR, 9);
    expect(axisToRate(0.6, MAX_DPS, { fine: true }))
      .toBeCloseTo(axisToRate(0.6, MAX_DPS) * FINE_MODE_FACTOR, 9);
  });

  it("produces exactly zero inside the deadzone regardless of maxDps", () => {
    expect(axisToRate(0.1, MAX_DPS)).toBe(0);
    expect(axisToRate(0.1, 500)).toBe(0);
  });

  // REGRESSION guard: the shaping modules' docs call out hand-copied
  // maxJogDps constant as a real bug that shipped before. This asserts the
  // function actually scales with whatever maxDps it's GIVEN -- not a
  // literal baked into this file -- so a caller that forgets to thread the
  // live config value through would be caught by a test comparing against
  // the wrong number, not silently pass because this function ignores its
  // own argument.
  it("scales with the live maxDps argument, not a hardcoded constant", () => {
    expect(axisToRate(1, 19)).toBeCloseTo(19, 9);
    expect(axisToRate(1, 40)).toBeCloseTo(40, 9);
    expect(axisToRate(1, 5)).toBeCloseTo(5, 9);
    expect(axisToRate(1, 19)).not.toBeCloseTo(axisToRate(1, 40), 9);
  });

  it("treats a missing/non-positive maxDps as zero rate rather than throwing", () => {
    expect(axisToRate(1, 0)).toBe(0);
    expect(axisToRate(1, -5)).toBe(0);
    expect(axisToRate(1, NaN)).toBe(0);
    expect(axisToRate(1, undefined as unknown as number)).toBe(0);
  });
});

// Field fix: "the joystick over bluetooth... it's way way way too
// sensitive. i touch it and it's 20 degree over already." -- an overall
// gain applied after the curve (see axisToRate/joystick-math.js's own doc),
// not a smaller maxDps (a measured hardware plateau the brief explicitly
// says not to touch).
describe("sensitivity (overall gain)", () => {
  const MAX_DPS = 19; // config.ts's maxJogDps default

  it("defaults to full sensitivity (no extra damping) when omitted -- existing full-deflection behaviour is unchanged", () => {
    expect(axisToRate(1, MAX_DPS)).toBeCloseTo(MAX_DPS, 9);
    expect(axisToRate(-1, MAX_DPS)).toBeCloseTo(-MAX_DPS, 9);
  });

  // The brief's own acceptance test: a lower sensitivity must yield a
  // MATERIALLY lower rate at a given (small) deflection.
  it("a lower sensitivity yields a materially lower rate at a given small deflection", () => {
    const highSens = axisToRate(0.4, MAX_DPS, { sensitivity: SENSITIVITY_MAX });
    const lowSens = axisToRate(0.4, MAX_DPS, { sensitivity: 0.3 });
    expect(highSens).toBeGreaterThan(0);
    expect(lowSens).toBeGreaterThan(0);
    expect(lowSens).toBeLessThan(highSens * 0.5); // "materially" lower, not marginally
  });

  // The brief's other acceptance test: full deflection must still reach the
  // configured maximum at max sensitivity (sensitivity is a damper, never an
  // amplifier past the hardware ceiling).
  it("full deflection still reaches the configured maximum at max sensitivity", () => {
    expect(axisToRate(1, MAX_DPS, { sensitivity: SENSITIVITY_MAX })).toBeCloseTo(MAX_DPS, 9);
    expect(axisToRate(-1, MAX_DPS, { sensitivity: SENSITIVITY_MAX })).toBeCloseTo(-MAX_DPS, 9);
  });

  it("scales full deflection proportionally at less than max sensitivity", () => {
    expect(axisToRate(1, MAX_DPS, { sensitivity: 0.5 })).toBeCloseTo(MAX_DPS * 0.5, 9);
  });

  it("never amplifies beyond maxDps even if a caller passes a sensitivity above SENSITIVITY_MAX", () => {
    expect(axisToRate(1, MAX_DPS, { sensitivity: 5 })).toBeCloseTo(MAX_DPS, 9);
  });

  it("clamps a degenerate sensitivity (negative, non-finite) to something sane rather than throwing/NaN", () => {
    expect(() => axisToRate(0.5, MAX_DPS, { sensitivity: -1 })).not.toThrow();
    expect(() => axisToRate(0.5, MAX_DPS, { sensitivity: NaN })).not.toThrow();
    expect(Number.isFinite(axisToRate(0.5, MAX_DPS, { sensitivity: NaN }))).toBe(true);
    expect(Number.isFinite(axisToRate(0.5, MAX_DPS, { sensitivity: -1 }))).toBe(true);
  });

  it("SENSITIVITY_DEFAULT sits strictly between the min and max -- usable for fine framing out of the box, not a dead stick", () => {
    expect(SENSITIVITY_DEFAULT).toBeGreaterThan(SENSITIVITY_MIN);
    expect(SENSITIVITY_DEFAULT).toBeLessThan(SENSITIVITY_MAX);
  });
});

describe("maxRateForSensitivity", () => {
  it("reports the reachable ceiling at full deflection for a given sensitivity (the UI's actionable readout)", () => {
    expect(maxRateForSensitivity(19, 1)).toBeCloseTo(19, 9);
    expect(maxRateForSensitivity(19, 0.5)).toBeCloseTo(9.5, 9);
  });

  it("defaults to SENSITIVITY_DEFAULT when not given", () => {
    expect(maxRateForSensitivity(19)).toBeCloseTo(19 * SENSITIVITY_DEFAULT, 9);
  });

  it("treats a missing/non-positive maxDps as zero, matching axisToRate", () => {
    expect(maxRateForSensitivity(0)).toBe(0);
    expect(maxRateForSensitivity(-5)).toBe(0);
  });
});

describe("selectMode", () => {
  it("selects TRIM (aim-offset nudge) while a tracking session is active", () => {
    expect(selectMode(true)).toBe(MODE_TRIM);
  });

  it("selects JOG (raw jog vector) when not tracking", () => {
    expect(selectMode(false)).toBe(MODE_JOG);
  });
});

describe("risingEdge", () => {
  it("fires only on the not-pressed -> pressed transition", () => {
    expect(risingEdge(false, true)).toBe(true);
  });

  it("does not fire while already pressed on the previous poll (the anti-repeat-fire case)", () => {
    expect(risingEdge(true, true)).toBe(false);
  });

  it("does not fire while not pressed on either poll", () => {
    expect(risingEdge(false, false)).toBe(false);
  });

  it("does not fire on release (pressed -> not-pressed)", () => {
    expect(risingEdge(true, false)).toBe(false);
  });

  // Simulates a button held across many consecutive polls: a naive "isPressed"
  // check would fire every tick; risingEdge must fire exactly once.
  it("fires exactly once across a long sequence of polls with the button held down", () => {
    const pressedSequence = [false, false, true, true, true, true, true, false, false];
    let prev = false;
    let fireCount = 0;
    for (const curr of pressedSequence) {
      if (risingEdge(prev, curr)) fireCount++;
      prev = curr;
    }
    expect(fireCount).toBe(1);
  });
});

describe("isPressed", () => {
  it("reads a button's pressed state by index", () => {
    expect(isPressed([false, true, false], 1)).toBe(true);
    expect(isPressed([false, true, false], 0)).toBe(false);
  });

  it("treats an out-of-range index as not pressed", () => {
    expect(isPressed([false, true], 5)).toBe(false);
  });

  it("treats a non-array input as not pressed", () => {
    expect(isPressed(null as unknown as boolean[], 0)).toBe(false);
    expect(isPressed(undefined as unknown as boolean[], 0)).toBe(false);
  });
});

describe("allPressed", () => {
  it("is true only when every index in the combo is pressed", () => {
    expect(allPressed([true, true, false], [0, 1])).toBe(true);
    expect(allPressed([true, false, false], [0, 1])).toBe(false);
  });

  it("is false for a single-button 'combo' that is not pressed", () => {
    expect(allPressed([false], [0])).toBe(false);
  });

  it("is false (never vacuously true) for an empty indices list", () => {
    expect(allPressed([true, true, true], [])).toBe(false);
  });

  it("treats an out-of-range combo index as not pressed", () => {
    expect(allPressed([true, true], [0, 1, 9])).toBe(false);
  });
});
