import { describe, it, expect } from "vitest";
import { scanAircraft, isTrackable, type ScanParams } from "../src/adsb-tools.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot, EnrichedAircraft } from "../src/adsb/types.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Mat3 } from "../src/geo/vec3.js";
import { CalibrationStore } from "../src/calibration.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG: Geodetic = { lat: 0, lon: 0, height: 0 };
const NIGHT = Date.UTC(2026, 0, 1, 0, 0, 0);
const cfg = loadConfig(undefined, {});
const P: ScanParams = { maxRangeKm: 100, onlyTrackable: true, limit: 20 };

function snap(aircraft: AdsbSnapshot["aircraft"]): AdsbSnapshot {
  return { aircraft, fetchedAtMs: 1000, ok: true };
}
function raw(hex: string, lat: number, altFt = 10000): AdsbSnapshot["aircraft"][number] {
  return {
    hex, callsign: null, lat, lon: 0, altBaroFt: null, altGeomFt: altFt,
    gsKt: 100, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null,
    squawk: null, seenPosSec: 0, rssi: null,
  };
}

describe("scanAircraft", () => {
  it("errors when not calibrated", () => {
    const r = scanAircraft(snap([]), null, null, cfg, NIGHT, P);
    expect("error" in r).toBe(true);
  });

  it("sorts by proximity and caps to the limit", () => {
    const r = scanAircraft(snap([raw("far", 0.5), raw("near", 0.05)]), RIG, I, cfg, NIGHT,
      { ...P, limit: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);
    expect(r.aircraft[0].hex).toBe("near");
  });

  it("filters out unreachable aircraft when only_trackable", () => {
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "80" });   // only near-zenith reachable
    // lat 0.5 => ~55km slant range (elevation ~0.7°, well below the 80° tilt
    // floor, so unreachable) -- must stay inside the default 100km maxRangeKm
    // so this exercises the trackable filter alone, not the range filter too.
    const r = scanAircraft(snap([raw("low", 0.5, 3000)]), RIG, I, c2, NIGHT, P);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
    const r2 = scanAircraft(snap([raw("low", 0.5, 3000)]), RIG, I, c2, NIGHT, { ...P, onlyTrackable: false });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.aircraft).toHaveLength(1);        // still returned when the filter is off
  });

  it("drops aircraft beyond max range", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, I, cfg, NIGHT, { ...P, maxRangeKm: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
  });
});

// Pre-calibration widening: a rig location lets the picker populate (real
// azimuth/elevation/range) even with no solved mount orientation (R), but
// anything that depends on pan/tilt reachability stays honestly unknown
// (null), never a fabricated false, and pointing/trackability filtering
// still hard-requires R. See src/adsb-tools.ts's scanAircraft doc comment.
describe("scanAircraft with rig set but no solved orientation (R null)", () => {
  it("only_trackable:false returns real geometry with reachable/est_track_sec null, not false", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, null, cfg, NIGHT, { ...P, onlyTrackable: false });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);
    const a = r.aircraft[0];
    expect(a.azimuthDeg).toBeCloseTo(0, 1);        // due north, matches raw()'s lat offset
    expect(a.rangeM).toBeGreaterThan(0);
    expect(typeof a.elevationDeg).toBe("number");
    expect(typeof a.sunSafe).toBe("boolean");       // world-frame geometry, never needs R
    expect(typeof a.slewOk).toBe("boolean");
    expect(typeof a.inSector).toBe("boolean");
    expect(a.reachable).toBeNull();                 // unknown, NOT false
    expect(a.estTrackSec).toBeNull();                // unknown, NOT a fabricated number
  });

  it("only_trackable:true still errors not-calibrated (filtering by trackability is meaningless without R)", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, null, cfg, NIGHT, { ...P, onlyTrackable: true });
    expect("error" in r).toBe(true);
  });

  it("track_aircraft's own call shape (onlyTrackable:true, limit:1000) still refuses without R", () => {
    // Mirrors registerAdsbTools' track_aircraft handler exactly, so this pins
    // that motion-commanding tool stays hard-gated on calibration.
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, null, cfg, NIGHT,
      { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 });
    expect("error" in r).toBe(true);
  });
});

describe("scanAircraft with a PROVISIONAL orientation (set_north_zero seed)", () => {
  it("track_aircraft's own call shape accepts a provisional orientation — the whole point is tracking before being properly calibrated", () => {
    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-adsb-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setProvisionalOrientation(I, new Date(0).toISOString(), 1);
    // NOT a solved calibration ...
    expect(store.isCalibrated()).toBe(false);
    // ... but registerAdsbTools' track_aircraft handler pulls store.getOrientation()
    // (not isCalibrated()), and that IS available from a provisional seed.
    const R = store.getOrientation();
    expect(R).toBeDefined();

    const r = scanAircraft(snap([raw("near", 0.05)]), store.get().rig!, R!, cfg, NIGHT,
      { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 });
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);
  });

  it("REGRESSION: without an orientation at all (no characterize_imu/set_north_zero/solve_calibration), track_aircraft still refuses", () => {
    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-adsb-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    // No setProvisionalOrientation/setOrientation call at all.
    const R = store.getOrientation();
    expect(R).toBeUndefined();
    const r = scanAircraft(snap([raw("near", 0.05)]), store.get().rig!, R ?? null, cfg, NIGHT,
      { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 });
    expect("error" in r).toBe(true);
  });
});

describe("scanAircraft with no rig location at all", () => {
  it("errors even with only_trackable:false — location is genuinely required for any geometry", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), null, null, cfg, NIGHT, { ...P, onlyTrackable: false });
    expect("error" in r).toBe(true);
    const r2 = scanAircraft(snap([raw("near", 0.05)]), null, I, cfg, NIGHT, { ...P, onlyTrackable: false });
    expect("error" in r2).toBe(true);
  });
});

describe("isTrackable", () => {
  it("requires all four hard flags", () => {
    // Cast to EnrichedAircraft (not `never`): isTrackable only reads these four
    // flags, but `never` can't be spread (`{ ...base, ... }` below), while a
    // cast object type can.
    const base = { reachable: true, sunSafe: true, slewOk: true, inSector: true } as unknown as EnrichedAircraft;
    expect(isTrackable(base)).toBe(true);
    expect(isTrackable({ ...base, sunSafe: false })).toBe(false);
    expect(isTrackable({ ...base, inSector: false })).toBe(false);
  });
});

// FIELD 2026-07-30: fix age now reaches the estimator, so an aircraft whose
// position report is already older than the session's staleness threshold
// would light up [Track] and immediately fall into "waiting". Don't offer it.
describe("isTrackable rejects a stale position report", () => {
  const base = {
    reachable: true, sunSafe: true, slewOk: true, inSector: true, seenPosSec: 1.0,
  } as unknown as Parameters<typeof isTrackable>[0];

  it("keeps a fresh report trackable", () => {
    expect(isTrackable(base, 5)).toBe(true);
  });

  it("rejects a report older than the threshold", () => {
    expect(isTrackable({ ...base, seenPosSec: 37.8 }, 5)).toBe(false);
  });

  it("treats an unknown position age as unusable, not as fresh", () => {
    expect(isTrackable({ ...base, seenPosSec: null }, 5)).toBe(false);
  });

  it("without a threshold, behaviour is unchanged (every existing caller)", () => {
    expect(isTrackable({ ...base, seenPosSec: 999 })).toBe(true);
    expect(isTrackable({ ...base, seenPosSec: null })).toBe(true);
  });
});
