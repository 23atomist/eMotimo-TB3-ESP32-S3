export interface Aircraft {
  hex: string;
  callsign: string | null;
  lat: number | null;
  lon: number | null;
  altBaroFt: number | null;
  altGeomFt: number | null;
  gsKt: number | null;
  trackDeg: number | null;
  baroRateFpm: number | null;
  geomRateFpm: number | null;
  typeCode: string | null;   // ICAO type designator, e.g. "C17", "B738"
  operator: string | null;   // owner/operator, e.g. "UNITED STATES AIR FORCE"
  category: string | null;
  squawk: string | null;
  seenPosSec: number | null;
  rssi: number | null;
}

export interface EnrichedAircraft extends Aircraft {
  azimuthDeg: number;
  elevationDeg: number;
  rangeM: number;
  // reachable and estTrackSec both require the solved mount orientation (R)
  // to turn a world-frame direction into where the rig must point -- see
  // enrichAircraft. null (not false) when R hasn't been solved yet, so an
  // uncalibrated rig is never misreported as "checked and unreachable".
  // sunSafe/slewOk/inSector are pure rig-location/world-frame geometry and
  // stay real booleans regardless of R.
  reachable: boolean | null;
  sunSafe: boolean;
  slewOk: boolean;
  inSector: boolean;
  requiredSlewDps: number;
  estTrackSec: number | null;
}

export interface AdsbSnapshot {
  aircraft: Aircraft[];
  fetchedAtMs: number;
  ok: boolean;
  error?: string;
}
