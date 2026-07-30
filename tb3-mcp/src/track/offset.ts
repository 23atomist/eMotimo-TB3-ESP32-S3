// The operator aim-offset: a persistent (panDeg, tiltDeg) correction applied
// to the tracking setpoint while tracking, so the servo holds the target
// where the operator puts it instead of dead-centre. This IS the drift
// calibration measurement -- see the module doc in track/session.ts for how
// it's wired into tick()/beginAcquire(). Kept in its own small, pure module
// (no Device/Config/session knowledge) because this is also the exact
// interface a future automatic (vision-based) corrector will drive: apply a
// delta, get back the resulting offset. Nothing here is async, nothing here
// knows about pan/tilt limits, sun guard, or E-STOP -- those gates all still
// apply downstream, at the setpoint this shifts (see applyOffset's callers).

export interface AimOffset {
  readonly panDeg: number;
  readonly tiltDeg: number;
}

export const ZERO_OFFSET: AimOffset = { panDeg: 0, tiltDeg: 0 };

// A few degrees is a real calibration error; tens of degrees is a bug or an
// operator error (fat-fingered delta, a script gone wrong) -- clamp rather
// than trust an arbitrary nudge, so "a nudge must never command an unbounded
// slew" holds even if a caller passes something absurd.
//
// Also deliberately well under trackReacquireDeg's default (10°, see
// config.ts): tick()'s reacquire trigger compares the ACTUAL boresight
// against the TRUE (unshifted) target direction, so a converged offset shows
// up there as pointing error of roughly the offset's own magnitude. Keeping
// the clamp comfortably below that threshold means a real, converged
// correction is never mistaken for "lost track" and never itself triggers a
// reacquire cycle -- see track/session.ts's tick().
export const MAX_OFFSET_DEG = 5;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface NudgeResult extends AimOffset {
  // Whether THIS nudge was cut short by the clamp on that axis. The operator
  // is watching a number converge while a plane crosses the frame; if it
  // silently stops moving they keep pressing and conclude the control is
  // broken (field, 2026-07-29: "impossible to catch them even with the drift
  // correction"). Reported all the way out through nudge_aim_offset so the
  // dashboard can say "trim at limit" instead of nothing.
  readonly panClamped: boolean;
  readonly tiltClamped: boolean;
  // The ceiling actually applied, carried here so a reporter does not need
  // its own copy of Config to tell the operator what the limit was.
  readonly maxDeg: number;
}

// Apply a delta to the standing offset and clamp both axes independently to
// ±maxDeg. Pure and mechanical on purpose -- this is the whole interface a
// human OR a future automatic corrector drives.
//
// maxDeg is a parameter rather than the bare constant so it can be raised in
// config.json without a deploy: a rough set_north_zero seed can leave a
// pointing error larger than the default 5°, and when it does, the clamp --
// not the operator's aim -- is what stops the plane reaching centre. Keep it
// comfortably under trackReacquireDeg (default 10°) or a converged offset
// starts reading as "lost track"; see MAX_OFFSET_DEG above.
export function nudgeOffset(
  current: AimOffset, deltaPanDeg: number, deltaTiltDeg: number, maxDeg: number = MAX_OFFSET_DEG,
): NudgeResult {
  const wantPan = current.panDeg + deltaPanDeg;
  const wantTilt = current.tiltDeg + deltaTiltDeg;
  const panDeg = clamp(wantPan, -maxDeg, maxDeg);
  const tiltDeg = clamp(wantTilt, -maxDeg, maxDeg);
  return {
    panDeg,
    tiltDeg,
    maxDeg,
    // Only a nudge that ASKED to go further counts as clamped -- sitting at
    // the limit while nudging back toward zero is not being blocked.
    panClamped: panDeg !== wantPan,
    tiltClamped: tiltDeg !== wantTilt,
  };
}

// Shift a computed target setpoint by the standing offset. The ONLY place
// the offset touches the pointing pipeline: callers must feed the result
// through the exact same reachablePanTilt() gate an unshifted target goes
// through (see TrackingSession.tick/beginAcquire) so pan/tilt limits apply
// identically either way.
export function applyOffset(
  panDeg: number, tiltDeg: number, offset: AimOffset,
): { panDeg: number; tiltDeg: number } {
  return { panDeg: panDeg + offset.panDeg, tiltDeg: tiltDeg + offset.tiltDeg };
}
