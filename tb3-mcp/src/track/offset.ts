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

// Apply a delta to the standing offset and clamp both axes independently to
// ±MAX_OFFSET_DEG. Pure and mechanical on purpose -- this is the whole
// interface a human OR a future automatic corrector drives.
export function nudgeOffset(current: AimOffset, deltaPanDeg: number, deltaTiltDeg: number): AimOffset {
  return {
    panDeg: clamp(current.panDeg + deltaPanDeg, -MAX_OFFSET_DEG, MAX_OFFSET_DEG),
    tiltDeg: clamp(current.tiltDeg + deltaTiltDeg, -MAX_OFFSET_DEG, MAX_OFFSET_DEG),
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
