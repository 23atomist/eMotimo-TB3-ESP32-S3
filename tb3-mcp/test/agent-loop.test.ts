import { describe, it, expect } from "vitest";
import { runOnce, type RigMcpClient, type LoopDeps, type LoopState } from "../src/agent/loop.js";
import type { AircraftBrief, ChooseInput, Decision } from "../src/agent/llm.js";

function brief(hex: string): AircraftBrief {
  return { hex, callsign: null, category: null, squawk: null, altitude_m: 9000,
    ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 30, range_km: 40, est_track_sec: 60 };
}
function client(over: Partial<RigMcpClient> = {}): { c: RigMcpClient; calls: string[] } {
  const calls: string[] = [];
  const c: RigMcpClient = {
    scanAircraft: async () => [brief("aaa"), brief("bbb")],
    getTracked: async () => ({ hex: null }),
    getStatus: async () => ({ state: "stopped", label: null, pointingErrorDeg: null }),
    track: async (h) => { calls.push(`track:${h}`); },
    stop: async () => { calls.push("stop"); },
    ...over,
  };
  return { c, calls };
}
function deps(c: RigMcpClient, choose: (i: ChooseInput) => Promise<Decision>, now = 100000): LoopDeps {
  return { client: c, choose, cfg: { maxRangeKm: 100, minDwellMs: 25000 }, now: () => now };
}

describe("runOnce", () => {
  it("tracks the LLM's pick and stamps the switch time", async () => {
    const { c, calls } = client();
    const out = await runOnce(deps(c, async () => ({ action: "track", hex: "bbb", reason: "" })), { lastSwitchMs: 0 });
    expect(calls).toEqual(["track:bbb"]);
    expect(out.action).toEqual({ kind: "track", hex: "bbb" });
    expect(out.state.lastSwitchMs).toBe(100000);
  });

  it("fails safe (stop) when the LLM throws and current is lost", async () => {
    // Bound to ccc, but ccc is NOT in the current scan → unhealthy.
    const { c, calls } = client({ getTracked: async () => ({ hex: "ccc" }) });
    const out = await runOnce(deps(c, async () => { throw new Error("llm down"); }), { lastSwitchMs: 0 });
    expect(calls).toEqual(["stop"]);
    expect(out.action).toEqual({ kind: "stop" });
  });

  it("keeps (no tool call) when the LLM throws and current is healthy", async () => {
    const { c, calls } = client({ getTracked: async () => ({ hex: "aaa" }) });   // aaa is in scan
    const out = await runOnce(deps(c, async () => { throw new Error("llm down"); }), { lastSwitchMs: 0 });
    expect(calls).toEqual([]);
    expect(out.action).toEqual({ kind: "keep" });
  });

  it("respects min-dwell: keeps a healthy current despite a different pick", async () => {
    const { c, calls } = client({ getTracked: async () => ({ hex: "aaa" }) });
    const out = await runOnce(deps(c, async () => ({ action: "track", hex: "bbb", reason: "" }), 100000),
      { lastSwitchMs: 90000 });   // only 10s since last switch < 25s
    expect(calls).toEqual([]);
    expect(out.action).toEqual({ kind: "keep" });
    expect(out.state.lastSwitchMs).toBe(90000);   // unchanged
  });
});
