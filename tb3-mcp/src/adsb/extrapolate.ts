import { Aircraft } from "./types.js";
import { AltSource, aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { Geodetic, geodeticPlusEnu } from "../geo/wgs84.js";
import { scale, norm } from "../geo/vec3.js";

export interface ExtrapolatedSighting {
  geodetic: Geodetic;
  // Magnitude of the applied position correction, meters -- the operator's
  // "how far did you move it" number.
  movedM: number;
  // Age (seconds) of the ADS-B position report this was extrapolated from
  // (ac.seenPosSec) -- the operator's "how much do you trust this" number.
  positionAgeSec: number;
}

export type ExtrapolationError = { error: string };

// Moves an aircraft's last-reported position forward to the instant the
// operator actually saw it centered in the video frame -- the correctness
// requirement the whole aircraft-sighting feature rests on. At 10km slant
// range, 1deg of pointing error is ~175m; a fast jet with a couple of
// un-extrapolated seconds of ADS-B lag is already worse than the calibration
// being sought, so this cannot be skipped or approximated by "just use the
// last report."
//
// Two corrections, both needed:
//  1. ADS-B report age (ac.seenPosSec): the report itself already describes
//     where the aircraft WAS that many seconds ago, not where it is now.
//  2. Video latency (videoLatencyMs): the operator centred the crosshair on a
//     video frame that is itself latencyMs old, so their pan/tilt corresponds
//     to an EARLIER instant than "now" -- hence subtracting latency instead
//     of adding it.
// Net: extrapolate forward by (seenPosSec - videoLatencyMs/1000) seconds from
// the reported fix. That net duration can be negative (a fresh report, e.g.
// seenPosSec=0, with a nonzero video latency) -- correctly moving the sighted
// position slightly BACKWARD along the flight path, not forward.
//
// Refuses (returns {error}) rather than guessing whenever the inputs can't
// support a trustworthy extrapolation: no usable position/altitude, unknown
// or excessive position age, or no velocity to extrapolate with. A silently
// wrong sighting corrupts the calibration solve and everything pointed at
// downstream of it -- far worse than a refusal the operator can retry a few
// seconds later.
export function extrapolateSightingPosition(
  ac: Aircraft,
  altSource: AltSource,
  videoLatencyMs: number,
  maxPosAgeSec: number,
): ExtrapolatedSighting | ExtrapolationError {
  const g = aircraftGeodetic(ac, altSource);
  if (!g) return { error: `aircraft ${ac.hex} has no usable position/altitude` };

  if (ac.seenPosSec === null) {
    return { error: `aircraft ${ac.hex} reports no position age (seen_pos) — refusing to guess how stale it is` };
  }
  if (ac.seenPosSec > maxPosAgeSec) {
    return {
      error: `aircraft ${ac.hex}'s position report is ${ac.seenPosSec.toFixed(1)}s old ` +
        `(max ${maxPosAgeSec}s) — too stale to sight; wait for a fresher report`,
    };
  }

  const vel = aircraftVelocity(ac);
  if (!vel) {
    return { error: `aircraft ${ac.hex} has no ground speed/track reported — cannot extrapolate its position` };
  }

  const dtSec = ac.seenPosSec - videoLatencyMs / 1000;
  const enuOffset = scale(vel, dtSec);
  return {
    geodetic: geodeticPlusEnu(g, enuOffset),
    movedM: norm(enuOffset),
    positionAgeSec: ac.seenPosSec,
  };
}
