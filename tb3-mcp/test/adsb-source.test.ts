import { describe, it, expect } from "vitest";
import { AdsbSource } from "../src/adsb/source.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot } from "../src/adsb/types.js";

const cfg = loadConfig(undefined, { TB3_ADSB_URL: "http://x/aircraft.json" });

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("AdsbSource", () => {
  it("starts empty and populates after a poll", async () => {
    const src = new AdsbSource(cfg, {
      now: () => 1000,
      fetchFn: fakeFetch({ aircraft: [{ hex: "abc", lat: 1, lon: 2, alt_geom: 10000 }] }),
    });
    expect(src.getSnapshot().aircraft).toEqual([]);
    await src.pollOnceForTest();
    const s = src.getSnapshot();
    expect(s.ok).toBe(true);
    expect(s.aircraft.map((a) => a.hex)).toEqual(["abc"]);
    expect(s.fetchedAtMs).toBe(1000);
  });

  it("degrades to ok:false on fetch failure without throwing", async () => {
    const src = new AdsbSource(cfg, {
      now: () => 5,
      fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    await src.pollOnceForTest();
    const s = src.getSnapshot();
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/ECONNREFUSED/);
    expect(s.aircraft).toEqual([]);
  });

  it("fires onSnapshot each poll and runs on the scheduler tick", async () => {
    let fn: (() => void) | null = null;
    const sched = { every: (_ms: number, f: () => void) => { fn = f; return { cancel() { fn = null; } }; } };
    const seen: AdsbSnapshot[] = [];
    const src = new AdsbSource(cfg, {
      scheduler: sched, now: () => 7,
      fetchFn: fakeFetch({ aircraft: [{ hex: "z9", lat: 0, lon: 0, alt_geom: 100 }] }),
      onSnapshot: (s) => seen.push(s),
    });
    src.start();
    fn!();                                  // fire one scheduled tick
    await new Promise((r) => setTimeout(r, 0));  // let the async poll settle
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1].aircraft[0].hex).toBe("z9");
    src.stop();
  });

  it("a throwing onSnapshot cannot crash the poll (rejection guard)", async () => {
    const src = new AdsbSource(cfg, {
      now: () => 3,
      fetchFn: fakeFetch({ aircraft: [{ hex: "q1", lat: 0, lon: 0, alt_geom: 100 }] }),
      onSnapshot: () => { throw new Error("consumer blew up"); },
    });
    await expect(src.pollOnceForTest()).resolves.toBeUndefined();  // did not reject
    expect(src.getSnapshot().aircraft.map((a) => a.hex)).toEqual(["q1"]);  // snapshot still updated
  });
});
