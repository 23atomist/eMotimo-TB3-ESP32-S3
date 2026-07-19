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
  category: string | null;
  squawk: string | null;
  seenPosSec: number | null;
  rssi: number | null;
}

export interface EnrichedAircraft extends Aircraft {
  azimuthDeg: number;
  elevationDeg: number;
  rangeM: number;
  reachable: boolean;
  sunSafe: boolean;
  slewOk: boolean;
  requiredSlewDps: number;
  estTrackSec: number;
}

export interface AdsbSnapshot {
  aircraft: Aircraft[];
  fetchedAtMs: number;
  ok: boolean;
  error?: string;
}
