import { describe, it, expect } from "vitest";
import { AdsbFollower, type TargetSink } from "../src/adsb/follower.js";
import { Aircraft } from "../src/adsb/types.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Vec3 } from "../src/geo/vec3.js";

function ac(hex: string, p: Partial<Aircraft> = {}): Aircraft {
  return {
    hex, callsign: null, lat: 37, lon: -122, altBaroFt: null, altGeomFt: 10000,
    gsKt: 200, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null,
    squawk: null, seenPosSec: 0, rssi: null, ...p,
  };
}
function fakeSink() {
  const calls: { kind: "start" | "update"; g: Geodetic; vel: Vec3 | null; label?: string | null }[] = [];
  let active = false;
  const sink: TargetSink = {
    start(g, vel, label) { active = true; calls.push({ kind: "start", g, vel, label }); return null; },
    updateTarget(g, vel) { calls.push({ kind: "update", g, vel }); return null; },
    isActive() { return active; },
  };
  return { sink, calls, setActive: (v: boolean) => { active = v; } };
}

describe("AdsbFollower", () => {
  it("starts on first fix then updates on later fixes", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("A1B2C3");
    f.onSnapshot({ aircraft: [ac("a1b2c3")] });   // hex compare is case-insensitive
    f.onSnapshot({ aircraft: [ac("a1b2c3", { lat: 37.1 })] });
    expect(calls.map((c) => c.kind)).toEqual(["start", "update"]);
    expect(calls[0].vel).not.toBeNull();          // gs+track → velocity present
    expect(f.status().hex).toBe("a1b2c3");
  });

  it("re-starts (fresh estimator) when switching to a new hex", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("aaa111"); f.onSnapshot({ aircraft: [ac("aaa111")] });
    f.bind("bbb222"); f.onSnapshot({ aircraft: [ac("bbb222")] });
    expect(calls.map((c) => c.kind)).toEqual(["start", "start"]);
  });

  it("unbinds after the lost threshold when the hex disappears", () => {
    const { sink } = fakeSink();
    let t = 1000;
    const f = new AdsbFollower(sink, "auto", 5000, () => t);
    f.bind("c0ffee"); f.onSnapshot({ aircraft: [ac("c0ffee")] });
    t = 4000; f.onSnapshot({ aircraft: [] });         // gone 3s — still bound
    expect(f.status().hex).toBe("c0ffee");
    t = 7000; f.onSnapshot({ aircraft: [] });         // gone 6s > 5s — released
    expect(f.status().hex).toBeNull();
  });

  it("self-heals: unbinds when the session was stopped elsewhere", () => {
    const { sink, setActive } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("d00d00"); f.onSnapshot({ aircraft: [ac("d00d00")] });  // start → active
    setActive(false);                                              // stop_tracking elsewhere
    f.onSnapshot({ aircraft: [ac("d00d00")] });
    expect(f.status().hex).toBeNull();
  });

  it("skips a fix with no usable altitude but stays bound", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "geom", 15000, () => 1000);
    f.bind("e1e1e1");
    f.onSnapshot({ aircraft: [ac("e1e1e1", { altGeomFt: null })] });  // geom missing under "geom"
    expect(calls.length).toBe(0);
    expect(f.status().hex).toBe("e1e1e1");
  });

  it("releases a persistently altitude-less target once past the lost threshold", () => {
    const { sink, calls } = fakeSink();
    let t = 1000;
    const f = new AdsbFollower(sink, "geom", 5000, () => t);
    f.bind("f00d00");
    // Present every frame, but never has a usable altitude under "geom".
    t = 2000; f.onSnapshot({ aircraft: [ac("f00d00", { altGeomFt: null })] });
    expect(calls.length).toBe(0);
    expect(f.status().hex).toBe("f00d00");             // still within threshold (1s < 5s)

    t = 4000; f.onSnapshot({ aircraft: [ac("f00d00", { altGeomFt: null })] });
    expect(f.status().hex).toBe("f00d00");              // still within threshold (3s < 5s)

    t = 6500; f.onSnapshot({ aircraft: [ac("f00d00", { altGeomFt: null })] });
    expect(f.status().hex).toBeNull();                  // 5.5s > 5s threshold — released
    expect(calls.length).toBe(0);                        // never had a usable fix to send
  });

  it("retries and surfaces a sink start() error instead of swallowing it, then unbinds past threshold", () => {
    const calls: { kind: "start" | "update" }[] = [];
    let startError: string | null = "not calibrated: no rig location set";
    const sink: TargetSink = {
      start(_g, _vel, _label) { calls.push({ kind: "start" }); return startError; },
      updateTarget(_g, _vel) { calls.push({ kind: "update" }); return null; },
      isActive() { return false; },
    };
    let t = 1000;
    const f = new AdsbFollower(sink, "auto", 5000, () => t);
    f.bind("aaface");

    t = 2000; f.onSnapshot({ aircraft: [ac("aaface")] });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe("start");
    expect(f.status().lastError).toBe("not calibrated: no rig location set");
    expect(f.status().hex).toBe("aaface");               // still bound, still within threshold

    // firstFix was NOT consumed — the next snapshot retries start(), not update().
    t = 3000; f.onSnapshot({ aircraft: [ac("aaface")] });
    expect(calls.length).toBe(2);
    expect(calls[1].kind).toBe("start");
    expect(f.status().lastError).toBe("not calibrated: no rig location set");

    // Error persists past the lost threshold (>5s since bind at t=1000) — unbinds.
    t = 6500; f.onSnapshot({ aircraft: [ac("aaface")] });
    expect(f.status().hex).toBeNull();
  });

  it("pushes the bound hex's fix from a multi-aircraft snapshot, not another aircraft's", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("b0b0b0");
    f.onSnapshot({
      aircraft: [
        ac("aaaaaa", { lat: 10, lon: 10 }),
        ac("b0b0b0", { lat: 37.5, lon: -122.5 }),
        ac("cccccc", { lat: 20, lon: 20 }),
      ],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe("start");
    expect(calls[0].g.lat).toBeCloseTo(37.5);
    expect(calls[0].g.lon).toBeCloseTo(-122.5);
  });
});
