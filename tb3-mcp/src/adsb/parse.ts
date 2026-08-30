import { Aircraft } from "./types.js";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

// Normalize a dump1090-fa / readsb aircraft.json body into our Aircraft shape.
// Aircraft with no hex or no position are dropped (they cannot be pointed at).
export function parseAircraftJson(raw: unknown): Aircraft[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { aircraft?: unknown }).aircraft;
  if (!Array.isArray(list)) return [];
  const out: Aircraft[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const hex = strOrNull(r.hex);
    if (hex === null) continue;
    const lat = numOrNull(r.lat);
    const lon = numOrNull(r.lon);
    if (lat === null || lon === null) continue;
    out.push({
      hex: hex.toLowerCase(),
      callsign: strOrNull(r.flight),
      lat, lon,
      altBaroFt: numOrNull(r.alt_baro),   // "ground" (string) → null
      altGeomFt: numOrNull(r.alt_geom),
      gsKt: numOrNull(r.gs),
      trackDeg: numOrNull(r.track),
      baroRateFpm: numOrNull(r.baro_rate),
      geomRateFpm: numOrNull(r.geom_rate),
      category: strOrNull(r.category),
      squawk: strOrNull(r.squawk),
      // ICAO type code and owner/operator. Both come from the receiver's
      // aircraft database rather than off the air, so coverage is good but not
      // universal (~39/43 and ~35/43 on this feed) -- every consumer must treat
      // them as optional. They are the military and airframe-size signal that
      // src/policy/predicates.ts tiers on; without them the agent cannot tell
      // a C-17 from an A320.
      typeCode: strOrNull(r.t),
      operator: strOrNull(r.ownOp),
      seenPosSec: numOrNull(r.seen_pos),
      rssi: numOrNull(r.rssi),
    });
  }
  return out;
}
