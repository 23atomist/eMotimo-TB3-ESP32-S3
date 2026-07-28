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

export function calibrationSteps(state) {
  const cal = (state && state.calibration) || {};
  const calibrated = cal.calibrated === true;
  const rig = cal.rig || null;
  const imu = cal.imuMounting || null;
  const provisional = cal.provisional === true;
  const sightings = Array.isArray(cal.sightings) ? cal.sightings : [];

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
    step("sight-2", "Sighting 2", sightings.length >= 2,
      sightings.length >= 1 ? "" : "needs sighting 1 first",
      sightings[1] ? String(sightings[1].label || "") : ""),
    step("solve", "Solve", false,
      sightings.length >= 2 ? "" : `needs 2 sightings (have ${sightings.length})`),
  ];
}
