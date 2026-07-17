import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, degToSteps, applySign, checkPanTilt, checkSpeed, Limits } from "./angles.js";

export interface MoveResult {
  arrived: boolean;
  pan_deg: number;
  tilt_deg: number;
}

// Move to a USER-frame pan/tilt. Validates soft limits + speed, applies device
// signs, commands the move, and waits for arrival. Throws Error(message) on any
// violation, device rejection, or timeout — callers turn that into an MCP error.
export async function moveToUserAngle(
  device: Device, cfg: Config, panDeg: number, tiltDeg: number, speedDps?: number,
): Promise<MoveResult> {
  const limits: Limits = {
    panMin: cfg.panMin, panMax: cfg.panMax,
    tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
    maxSpeedDps: cfg.maxSpeedDps,
  };
  const lim = checkPanTilt(panDeg, tiltDeg, limits);
  if (!lim.ok) throw new Error(lim.error!);
  const spd = checkSpeed(speedDps, cfg.maxSpeedDps);
  if (!spd.ok) throw new Error(spd.error!);

  const devPan = applySign(panDeg, cfg.panSign);
  const devTilt = applySign(tiltDeg, cfg.tiltSign);
  try {
    await device.gotoAngle(devPan, devTilt, speedDps);
  } catch (e) {
    // `cause` carries the DeviceHttpError through: the message stays the
    // operator-facing string callers already format, while a programmatic
    // caller (the tracking session) can still tell a routine 409 "still
    // decelerating" apart from a real fault without parsing this text.
    throw new Error(`device rejected goto: ${(e as Error).message}`, { cause: e });
  }

  const cur = device.getState();
  const distDeg = Math.max(
    Math.abs(devPan - stepsToDeg(cur.panSteps)),
    Math.abs(devTilt - stepsToDeg(cur.tiltSteps)),
  );
  const effSpeed = speedDps ?? cfg.maxSpeedDps;
  const timeoutMs = Math.max(5000, (distDeg / effSpeed) * 1000 * 3 + 3000);

  const final = await device.waitForArrival(degToSteps(devPan), degToSteps(devTilt), timeoutMs);
  return {
    arrived: true,
    pan_deg: Number(applySign(stepsToDeg(final.panSteps), cfg.panSign).toFixed(3)),
    tilt_deg: Number(applySign(stepsToDeg(final.tiltSteps), cfg.tiltSign).toFixed(3)),
  };
}
