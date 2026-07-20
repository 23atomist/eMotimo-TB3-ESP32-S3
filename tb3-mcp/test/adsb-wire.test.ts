import { describe, it, expect } from "vitest";
import { AdsbSource } from "../src/adsb/source.js";
import { AdsbFollower } from "../src/adsb/follower.js";
import { loadConfig } from "../src/config.js";

// The source's onSnapshot must drive the follower (this is the wiring server.ts does).
describe("adsb wiring", () => {
  it("a source poll delivers the snapshot to the follower", async () => {
    const cfg = loadConfig(undefined, { TB3_ADSB_URL: "http://x/aircraft.json" });
    let started = false;
    const sink = {
      start() { started = true; return null; },
      updateTarget() { return null; },
      isActive() { return started; },
    };
    const follower = new AdsbFollower(sink, cfg.adsbAltSource, cfg.adsbLostSec * 1000, () => 1000);
    follower.bind("abc");
    const src = new AdsbSource(cfg, {
      now: () => 1000,
      fetchFn: (async () => ({ ok: true, json: async () => ({ aircraft: [{ hex: "abc", lat: 1, lon: 2, alt_geom: 10000 }] }) })) as unknown as typeof fetch,
      onSnapshot: (s) => follower.onSnapshot(s),
    });
    await src.pollOnceForTest();
    expect(started).toBe(true);        // first fix reached the sink via the wiring
  });
});
