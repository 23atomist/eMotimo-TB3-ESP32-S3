export const STEPS_PER_DEG = 444.444;

export function stepsToDeg(steps: number): number {
  return steps / STEPS_PER_DEG;
}

export function degToSteps(deg: number): number {
  return deg * STEPS_PER_DEG;
}

// Device frame ↔ user frame. sign is +1 or -1; multiplying is its own inverse.
export function applySign(deg: number, sign: number): number {
  return deg * sign;
}

export interface Limits {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
  maxSpeedDps: number;
}

export function checkPanTilt(
  userPanDeg: number,
  userTiltDeg: number,
  limits: Limits,
): { ok: boolean; error?: string } {
  if (!Number.isFinite(userPanDeg) || !Number.isFinite(userTiltDeg)) {
    return { ok: false, error: "pan_deg and tilt_deg must be finite numbers" };
  }
  if (userPanDeg < limits.panMin || userPanDeg > limits.panMax) {
    return {
      ok: false,
      error: `pan ${userPanDeg}° is outside the allowed range [${limits.panMin}, ${limits.panMax}]`,
    };
  }
  if (userTiltDeg < limits.tiltMin || userTiltDeg > limits.tiltMax) {
    return {
      ok: false,
      error: `tilt ${userTiltDeg}° is outside the allowed range [${limits.tiltMin}, ${limits.tiltMax}]`,
    };
  }
  return { ok: true };
}

export function checkSpeed(
  speedDps: number | undefined,
  maxDps: number,
): { ok: boolean; error?: string } {
  if (speedDps === undefined) return { ok: true };
  if (!Number.isFinite(speedDps) || speedDps <= 0) {
    return { ok: false, error: "speed_dps must be a positive number" };
  }
  if (speedDps > maxDps) {
    return { ok: false, error: `speed ${speedDps}°/s exceeds max ${maxDps}°/s` };
  }
  return { ok: true };
}
