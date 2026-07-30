// PURE: derives the calibration procedure's state from the daemon's own payload.
//
// This is the logic the old UI never had. Calibration is an ORDERED procedure
// with prerequisites -- set_north_zero needs characterize_imu, solving needs two
// sightings -- and presenting it as a flat row of buttons meant the operator had
// to hold that order in their head. A blocked step therefore always carries a
// human-readable reason: WHY a step is unavailable is the single most useful
// thing this UI can say.
//
// Everything here is derived from daemon state, never from local flags, so a
// refresh mid-procedure recovers instead of losing the operator's place.

function solveBlockedReason(sightings, sep) {
  if (sightings.length < 2) return `needs 2 sightings (have ${sightings.length})`;
  if (sep === null) return "sightings are missing their pan/tilt — re-sight";
  if (sep < MIN_SIGHTING_SEPARATION_DEG) {
    return `sightings are only ${sep.toFixed(1)}° apart — needs ≥${MIN_SIGHTING_SEPARATION_DEG}°; re-sight one, high vs low or well apart in azimuth`;
  }
  return "";
}

function step(id, label, done, blockedReason, detail) {
  const blocked = !done && !!blockedReason;
  return {
    id, label, done,
    blocked,
    available: !done && !blocked,
    reason: blocked ? blockedReason : "",
    detail: detail || "",
  };
}

// Angular gap the two sightings must span. Mirrors the daemon's own
// AIRCRAFT_SEPARATION_WARN_DEG (src/geo-tools.ts) -- the daemon is
// authoritative and refuses below its hard floor; this is the fast, local
// answer so the operator is told BEFORE pressing Solve.
export const MIN_SIGHTING_SEPARATION_DEG = 20;

// How far apart two sightings point, using the recorded pan/tilt rather than
// re-deriving ENU directions in the browser. A deliberate proxy: the daemon
// does the true ENU/TRIAD check, and what this needs to catch is "these two
// describe the same direction", which pan/tilt answers directly and without
// duplicating geo math (and its rig-location dependency) client-side.
//
// Returns null when either sighting lacks usable angles -- an unknown gap
// must never read as a satisfied one.
export function sightingSeparationDeg(a, b) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const ap = n(a && a.panDeg), at = n(a && a.tiltDeg);
  const bp = n(b && b.panDeg), bt = n(b && b.tiltDeg);
  if (ap === null || at === null || bp === null || bt === null) return null;
  let dPan = Math.abs(ap - bp) % 360;
  if (dPan > 180) dPan = 360 - dPan;
  // Azimuth converges toward the zenith: 10 deg of pan at 80 deg tilt is a far
  // smaller angle on the sky than 10 deg at the horizon. Without the cosine
  // two steep sightings would read as well separated when they are not.
  const meanTilt = ((at + bt) / 2) * Math.PI / 180;
  const dPanOnSky = dPan * Math.cos(meanTilt);
  return Math.hypot(dPanOnSky, at - bt);
}

export function calibrationSteps(state) {
  const cal = (state && state.calibration) || {};
  const calibrated = cal.calibrated === true;
  const rig = cal.rig || null;
  const imu = cal.imuMounting || null;
  const provisional = cal.provisional === true;
  const sightings = Array.isArray(cal.sightings) ? cal.sightings : [];
  // Counting sightings is NOT enough. On 2026-07-30 the rig held two
  // byte-identical sightings (0.0 deg apart, the same aircraft recorded
  // twice); this list counted them, reported the procedure complete, and
  // Solve looked ready -- over a pair from which no orientation can be
  // derived. The gap is what matters, not the count.
  const sep = sightings.length >= 2 ? sightingSeparationDeg(sightings[0], sightings[1]) : null;

  // Once solved, every step reads as done -- the procedure is complete and the
  // operator should see that at a glance rather than parsing six rows.
  if (calibrated) {
    return [
      step("rig-location", "Rig location", true, "", rig ? `${rig.lat.toFixed(4)}, ${rig.lon.toFixed(4)}, ${rig.height}m` : ""),
      step("imu", "IMU characterised", true, "", imu && imu.rmsDeg != null ? `rms ${imu.rmsDeg.toFixed(1)}°` : ""),
      step("north-zero", "North zero", true, ""),
      step("sight-1", "Sighting 1", true, "", sightings[0] ? String(sightings[0].label || "") : ""),
      step("sight-2", "Sighting 2", true, "", sightings[1] ? String(sightings[1].label || "") : ""),
      step("solve", "Solve", true, ""),
    ];
  }

  const hasRig = !!rig;
  const hasImu = !!imu;

  return [
    step("rig-location", "Rig location", hasRig, "",
      hasRig ? `${rig.lat.toFixed(4)}, ${rig.lon.toFixed(4)}, ${rig.height}m` : ""),
    step("imu", "IMU characterised", hasImu,
      hasRig ? "" : "needs the rig location first",
      hasImu && imu.rmsDeg != null ? `rms ${imu.rmsDeg.toFixed(1)}°` : ""),
    step("north-zero", "North zero", provisional,
      hasImu ? "" : "needs the IMU characterised first"),
    step("sight-1", "Sighting 1", sightings.length >= 1,
      provisional ? "" : "needs a north zero before tracking is possible",
      sightings[0] ? String(sightings[0].label || "") : ""),
    step("sight-2", "Sighting 2", sightings.length >= 2 && sep !== null && sep >= MIN_SIGHTING_SEPARATION_DEG,
      sightings.length >= 1 ? "" : "needs sighting 1 first",
      sightings[1] ? String(sightings[1].label || "") : ""),
    step("solve", "Solve", false, solveBlockedReason(sightings, sep)),
  ];
}
