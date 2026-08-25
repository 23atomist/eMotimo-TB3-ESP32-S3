import { Vec3, add, sub, scale, deg2rad } from "../geo/vec3.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";

export interface EnuFix {
  readonly enu: Vec3;   // meters, relative to the rig
  readonly tMs: number;
}

// A heading sample feeding the turn-rate estimate. Headings come from the
// stated ADS-B track when available (decoder-smoothed, low latency), else
// from the bearing between consecutive accepted fixes.
interface HeadSample {
  readonly tMs: number;
  readonly headDeg: number;
}

export interface EstimatorState {
  readonly fix: EnuFix | null;      // last ACCEPTED fix (new position information)
  readonly prevFix: EnuFix | null;
  readonly statedVel: Vec3 | null;  // latest stated ENU m/s
  // Recent accepted fixes, oldest first. Bounded by both count and age; this
  // is what the regression fallback fits when no velocity is stated.
  readonly hist: readonly EnuFix[];
  // The SMOOTHED extrapolation origin. Raw fixes snap around by tens of
  // meters (CPR decode quantization, GPS noise) and their stamp times jitter
  // with seen_pos; pointing straight off the newest raw fix reproduces all of
  // that as aim chatter. The anchor follows the measurements through a fixed
  // fractional gain instead, so each fix NUDGES the trajectory rather than
  // resetting it.
  readonly anchor: EnuFix | null;
  // Best-known velocity, ENU m/s: the stated ADS-B velocity when present,
  // else a least-squares fit over `hist`. Feeds both extrapolation and the
  // outlier gate.
  readonly vel: Vec3;
  // Signed yaw-rate estimate, deg/s in COMPASS terms: + = right turn (ADS-B
  // track increasing). Used to bend the coasting extrapolation along the
  // aircraft's arc instead of a straight line that a turning departure walks
  // away from.
  readonly turnRateDps: number;
  readonly headSamp: readonly HeadSample[];
}

export function emptyEstimator(): EstimatorState {
  return {
    fix: null, prevFix: null, statedVel: null,
    hist: [], anchor: null, vel: [0, 0, 0], turnRateDps: 0, headSamp: [],
  };
}

// --- Tuning constants -------------------------------------------------------
// All of these exist because the raw ADS-B stream is quantized and lossy in
// ways a single-fix extrapolator turns directly into camera motion. They are
// constants rather than config on purpose: each is tied to a physical property
// of the feed or the target, not an operator taste.

// How many fixes and how much time the regression window spans. Long enough
// to average report-to-report position noise, short enough that a sustained
// turn only lags the fit by roughly half the window (~4s).
const HIST_MAX_N = 8;
const HIST_MAX_AGE_MS = 8000;

// A "repeat" is dump1090/readsb re-serving the SAME position with a growing
// seen_pos after position messages stop decoding -- which happens constantly,
// not only on hard dropouts. Repeats carry NO new position information, and
// admitting them corrupts a finite-difference/regression velocity toward zero
// (the rig visibly stalled between real updates because of this) while making
// staleness look like freshness. 15m at a 1Hz poll means groundspeeds under
// ~54km/h read as stationary; anything an aircraft-tracking rig follows moves
// faster, and its stated velocity keeps those honest anyway.
const REPEAT_EPS_M = 15;

// Fix stamps come from now() - seen_pos*1000, and seen_pos occasionally goes
// DOWN between snapshots (readsb merging late messages). A fix claiming to be
// older than the one we already hold would drag the extrapolation BACKWARD;
// tolerate tiny jitter, reject the rest.
const MONOTONIC_TOL_MS = 50;

// Fractional gain the anchor moves toward each accepted fix's measurement.
// 0 = pure dead-reckoning (ignores measurements entirely), 1 = today's snap.
// 0.35 absorbs a noisy fix in ~3 updates (~3s at 1Hz) while keeping steady-
// state lag at zero for constant velocity: the correction term vanishes once
// the anchor rides the same line the measurements do.
const ANCHOR_ALPHA = 0.35;

// Innovation gate: reject a fix whose distance from the propagated prediction
// exceeds what legitimate flight could produce, so one bad CPR decode cannot
// yank the aim. The allowance grows with the gap since the last accepted fix
// -- linearly with speed (model error along track) and quadratically with the
// capped turn rate (model error across track) -- but never below this floor,
// which is sized to swallow GPS/CPR noise at short gaps several times over.
const GATE_FLOOR_M = 500;

// ...and the gate only runs once the prediction has had TIME to mean anything:
// within one poll interval of the last fix there is no elapsed time to predict
// across, and a wildly-different same-instant report is a genuine correction
// (decoder swapped solution, manual update_target), not an outlier to reject.
const GATE_MIN_GAP_MS = 250;

// Turn rates above a standard-rate (3 deg/s) turn are rare for tracked traffic
// and usually mean a noisy heading pair; cap what the coasting arc may bend.
const TURN_MAX_DPS = 6;
// Below this speed a "turn rate" is heading noise (hovering helicopter,
// taxiing), not coordinated flight.
const TURN_MIN_SPEED_MPS = 5;
// Heading samples older than this stop contributing to the turn rate.
const HEAD_WINDOW_MS = 10000;
const HEAD_MAX_N = 12;
// Displacement headings below this length are pure noise.
const HEAD_MIN_DISPLACEMENT_M = 30;

// Step size for the curved (turn-following) propagation. Rotation is applied
// per step, so smaller steps track the arc better; 0.25s keeps the worst-case
// arc chord error sub-meter at 250 m/s while bounding a full 12s coast to a
// few dozen steps.
const PROP_STEP_SEC = 0.25;

// Aviation-natural velocity -> ENU. Heading 0 = North, 90 = East.
export function velocityFromSpeedHeading(speedMps: number, headingDeg: number, climbMps: number): Vec3 {
  const h = deg2rad(headingDeg);
  return [speedMps * Math.sin(h), speedMps * Math.cos(h), climbMps];
}

function distM(a: Vec3, b: Vec3): number {
  const d = sub(a, b);
  return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
}

function wrapDeg180(d: number): number {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Least-squares velocity over the fix history: one slope per ENU axis against
// time. With two fixes this IS the old finite difference (a line through two
// points has that slope), but with more it averages report-to-report position
// noise instead of amplifying whatever the two nearest samples happen to say,
// and it tolerates the irregular spacing seen_pos gives the stamps.
function regressionVelocity(hist: readonly EnuFix[]): Vec3 | null {
  const n = hist.length;
  if (n < 2) return null;
  let sumT = 0, sumTT = 0;
  // Mutable tuples -- Vec3 itself is readonly and these are accumulators.
  const sumP: [number, number, number] = [0, 0, 0];
  const sumTP: [number, number, number] = [0, 0, 0];
  for (const f of hist) {
    const tSec = f.tMs / 1000;
    sumT += tSec;
    sumTT += tSec * tSec;
    sumP[0] += f.enu[0]; sumP[1] += f.enu[1]; sumP[2] += f.enu[2];
    sumTP[0] += tSec * f.enu[0]; sumTP[1] += tSec * f.enu[1]; sumTP[2] += tSec * f.enu[2];
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-9) return null;   // simultaneous stamps: no time axis
  const k = (n * sumTP[0] - sumT * sumP[0]) / denom;
  const m = (n * sumTP[1] - sumT * sumP[1]) / denom;
  const u = (n * sumTP[2] - sumT * sumP[2]) / denom;
  return [k, m, u];
}

function headingOfVel(v: Vec3): number {
  const h = (Math.atan2(v[0], v[1]) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

function trimWindow<T extends { tMs: number }>(items: readonly T[], nowMs: number, maxAgeMs: number, maxN: number): T[] {
  const kept = items.filter((x) => nowMs - x.tMs <= maxAgeMs);
  return kept.slice(Math.max(0, kept.length - maxN));
}

// How far a legitimate maneuver could plausibly put the aircraft from the
// prediction, given how long the prediction has been running uncorrected.
function gateAllowanceM(speedMps: number, gapSec: number): number {
  const turnRadPs = deg2rad(TURN_MAX_DPS);
  const crossTrack = 0.5 * speedMps * turnRadPs * gapSec * gapSec;
  return Math.max(GATE_FLOOR_M, 0.6 * speedMps * gapSec + crossTrack);
}

/**
 * Admit a fix and re-derive the smoothed state.
 *
 * Admission rules, in order:
 *  1. NON-MONOTONIC: a fix stamped before the one we hold is clock garbage --
 *    reject. Leading from it would point BEHIND the aircraft.
 *  2. REPEAT: same position as the last accepted fix is the decoder re-serving
 *    stale data -- ignore for state, so it can neither reset the trajectory
 *    nor flatten the estimated velocity. (Callers still get success: a repeat
 *    proves the feed is alive, which is exactly what keeps AdsbFollower bound
 *    through a dropout while the predictor coasts.)
 *  3. OUTLIER: farther from the propagated prediction than any real maneuver
 *    could explain -- reject, and let the next good fix re-sync.
 *
 * On acceptance the anchor advances to the new stamp by PROPAGATING there
 * first and then moving ANCHOR_ALPHA of the way toward the measurement, so
 * measurement noise becomes a bounded nudge rather than a jump.
 */
export function withFix(
  s: EstimatorState, rig: Geodetic, g: Geodetic, tMs: number, statedVel: Vec3 | null,
): EstimatorState {
  const meas: EnuFix = { enu: enuPosition(rig, g), tMs };

  // Gap since the last accepted fix (infinite when there is none). Under one
  // poll interval the prediction has had no time to mean anything: a wildly-
  // different same-instant report is a genuine correction (decoder swapped
  // solution, manual update_target) -- adopted outright and never gated.
  const gapMs = s.fix ? tMs - s.fix.tMs : Infinity;
  const sameInstant = gapMs < GATE_MIN_GAP_MS;

  if (s.fix) {
    if (tMs < s.fix.tMs - MONOTONIC_TOL_MS) return s;
    if (distM(meas.enu, s.fix.enu) <= REPEAT_EPS_M) {
      // A repeat carries no POSITION information, but a stated velocity
      // broadcast alongside it is still fresh information (the decoder keeps
      // emitting gs/track after position messages stop decoding) -- admit it,
      // or a dropout would coast on the pre-dropout heading even while the
      // feed is telling us the plane turned.
      if (statedVel) return { ...s, statedVel, vel: statedVel };
      return s;
    }

    // Gate only against a REAL velocity model: before any stated velocity or
    // second fix, the prediction is "sits still" -- gating against that would
    // reject exactly the fix that establishes motion.
    const hasVelocityModel = s.statedVel !== null || s.hist.length >= 2;
    if (hasVelocityModel && !sameInstant) {
      const predicted = estimateAt(s, tMs);
      if (predicted) {
        const innovation = distM(meas.enu, predicted);
        const speedMps = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
        if (innovation > gateAllowanceM(speedMps, gapMs / 1000)) return s;
      }
    }
  }

  const hist = trimWindow([...s.hist, meas], tMs, HIST_MAX_AGE_MS, HIST_MAX_N);

  // Velocity policy unchanged in spirit: a STATED velocity wins (the decoder
  // derives it from the same messages we see, already smoothed); regression
  // over the window fills in when none is broadcast.
  const vel = statedVel ?? regressionVelocity(hist) ?? s.vel;

  // Anchor: propagate the old trajectory to the new stamp, then take a
  // fraction of the residual. First fix seeds it directly (nothing to smooth).
  // Same-instant corrections are adopted OUTRIGHT (alpha 1): they restate
  // where the aircraft is RIGHT NOW, and smoothing them would leave the aim
  // lagging behind a truth the feed has already corrected -- which is also
  // exactly what the sector/floor/limit gates evaluate.
  const propagated = estimateAt(s, tMs);
  const anchorEnu = propagated
    ? add(propagated, scale(sub(meas.enu, propagated), sameInstant ? 1 : ANCHOR_ALPHA))
    : meas.enu;

  // Turn rate: prefer the stated track (per-fix heading, no displacement
  // needed), fall back to bearings between accepted fixes. Rate = total
  // heading change across the window divided by the time it took, capped --
  // a momentary noisy pair then relaxes back over the whole window instead
  // of spiking the estimate.
  const speed = Math.hypot(vel[0], vel[1]);
  let headSamp = s.headSamp;
  if (statedVel && speed >= TURN_MIN_SPEED_MPS) {
    headSamp = [...headSamp, { tMs, headDeg: headingOfVel(statedVel) }];
  } else if (!statedVel && s.fix && speed >= TURN_MIN_SPEED_MPS) {
    const d = sub(meas.enu, s.fix.enu);
    if (Math.hypot(d[0], d[1]) >= HEAD_MIN_DISPLACEMENT_M) {
      headSamp = [...headSamp, { tMs, headDeg: headingOfVel(d) }];
    }
  }
  headSamp = trimWindow(headSamp, tMs, HEAD_WINDOW_MS, HEAD_MAX_N);
  let turnRateDps = s.turnRateDps;
  if (speed < TURN_MIN_SPEED_MPS) {
    turnRateDps = 0;
  } else if (headSamp.length >= 2) {
    const first = headSamp[0], last = headSamp[headSamp.length - 1];
    const dtSec = (last.tMs - first.tMs) / 1000;
    if (dtSec > 0) {
      turnRateDps = clamp(wrapDeg180(last.headDeg - first.headDeg) / dtSec, -TURN_MAX_DPS, TURN_MAX_DPS);
    }
  }

  return {
    fix: meas,
    prevFix: s.fix,
    statedVel,
    hist,
    anchor: { enu: anchorEnu, tMs },
    vel,
    turnRateDps,
    headSamp,
  };
}

export function velocityOf(s: EstimatorState): Vec3 {
  return s.vel;
}

// Constant-velocity/turn-rate extrapolation in the rig's ENU frame. Straight-
// line ENU is an excellent model for level cruise (a 300mph target over a 10s
// horizon covers ~1.3km, across which earth curvature drops ~0.13m -- far
// below achievable pointing), so curvature is applied ONLY as the estimated
// yaw rotation, integrated in PROP_STEP_SEC slices: cheap, and it bends the
// coasting prediction along an arc a turning aircraft actually flies.
export function estimateAt(s: EstimatorState, tMs: number): Vec3 | null {
  if (!s.anchor) return null;
  const dtSec = (tMs - s.anchor.tMs) / 1000;
  if (dtSec === 0) return s.anchor.enu;

  const wRadPs = deg2rad(s.turnRateDps);
  if (wRadPs === 0) return add(s.anchor.enu, scale(s.vel, dtSec));

  const dir = Math.sign(dtSec);
  let remainingSec = Math.abs(dtSec);
  let elapsedSec = 0;
  let p = s.anchor.enu;
  while (remainingSec > 1e-9) {
    const stepSec = Math.min(PROP_STEP_SEC, remainingSec);
    // Rotate the horizontal velocity by the turn completed at the MIDDLE of
    // this slice (midpoint rule): exact for constant w, stable at the coarse
    // step a long coast takes. The MINUS is the compass/rotZ convention
    // mismatch: rotZ(+a) rotates an ENU vector toward DECREASING compass
    // bearing, while turnRateDps is stored compass-positive (right turn =
    // track increasing). Negating here makes +w bend the arc right.
    const midAngle = -wRadPs * (elapsedSec + stepSec / 2) * dir;
    const c = Math.cos(midAngle), sn = Math.sin(midAngle);
    p = [
      p[0] + (s.vel[0] * c - s.vel[1] * sn) * stepSec * dir,
      p[1] + (s.vel[0] * sn + s.vel[1] * c) * stepSec * dir,
      p[2] + s.vel[2] * stepSec * dir,
    ];
    elapsedSec += stepSec;
    remainingSec -= stepSec;
  }
  return p;
}

export function lastFixMs(s: EstimatorState): number | null {
  return s.fix?.tMs ?? null;
}
