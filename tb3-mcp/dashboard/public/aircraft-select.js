// Pure helpers for the calibration "sight aircraft" <select> (see app.js's
// renderCalAircraftOptions). Split out so the option-building and
// selection-preserving logic is testable without a DOM -- same rationale as
// minimap.js/camera-mode.js.

// One <option>'s value + label for an AircraftRow (state.adsb.aircraft is
// already sorted nearest-first by the daemon -- see scanAircraft in
// src/adsb-tools.ts -- so this never re-sorts).
export function aircraftOption(row) {
  const az = Number.isFinite(row.azimuth_deg) ? Math.round(row.azimuth_deg) : "—";
  const el = Number.isFinite(row.elevation_deg) ? Math.round(row.elevation_deg) : "—";
  const rng = Number.isFinite(row.range_km) ? row.range_km.toFixed(1) : "—";
  return {
    value: row.hex,
    label: `${row.callsign || row.hex} · az ${az}° el ${el}° · ${rng} km`,
  };
}

// Builds the option list plus which hex should end up selected: the
// operator's previous pick if it's still in range (a tick landing mid-decision
// must not yank the selection away), otherwise the nearest aircraft (rows[0]),
// otherwise none.
export function buildAircraftOptions(rows, previousHex) {
  const list = Array.isArray(rows) ? rows : [];
  const options = list.map(aircraftOption);
  const stillPresent = !!previousHex && list.some((r) => r.hex === previousHex);
  const selectedHex = stillPresent ? previousHex : (list[0] ? list[0].hex : "");
  return { options, selectedHex };
}
