import { describe, it, expect, vi } from "vitest";
import { runOnce, type RigMcpClient, type LoopDeps, type LoopState } from "../src/agent/loop.js";
import type { AircraftBrief, ChooseInput, Decision } from "../src/agent/llm.js";

function brief(hex: string): AircraftBrief {
  // A5 heavy at 70 km => policy tier 4. The daemon does the eligibility
  // gating now (scan_aircraft's only_eligible); these mocked rows arrive
  // pre-filtered, already carrying the tier/rule/canPreempt the daemon
  // annotated them with.
  return { hex, callsign: null, category: "A5", squawk: null, altitude_m: 9000,
    type: null, operator: null, climb_fpm: null, track_deg: null,
    ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 30, range_km: 70, est_track_sec: 60,
    tier: 4, rule: "big-and-distant", canPreempt: false };
}
function client(over: Partial<RigMcpClient> = {}): { c: RigMcpClient; calls: string[] } {
  const calls: string[] = [];
  const c: RigMcpClient = {
    scanAircraft: async () => [brief("aaa"), brief("bbb")],
    getTracked: async () => ({ hex: null }),
    getStatus: async () => ({ state: "stopped", label: null, pointingErrorDeg: null }),
    track: async (h) => { calls.push(`track:${h}`); },
    stop: async () => { calls.push("stop"); },
    parkIdle: async () => { calls.push("parkIdle"); return { parked: true, reason: "parked" }; },
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
    // Losing the target leaves nothing tracked -- stop() is followed by an
    // idle park rather than leaving the rig wherever the lost pass ended.
    expect(calls).toEqual(["stop", "parkIdle"]);
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

  it("parks idle when nothing is tracked and nothing is trackable", async () => {
    // Empty scan, nothing currently tracked, LLM (reasonably) says keep --
    // the exact "multi-minute idle gap" case this behaviour exists for.
    const { c, calls } = client({ scanAircraft: async () => [] });
    const out = await runOnce(deps(c, async () => ({ action: "keep", reason: "" })), { lastSwitchMs: 0 });
    expect(calls).toEqual(["parkIdle"]);
    expect(out.action).toEqual({ kind: "keep" });
  });

  it("does NOT park idle on a keep with a healthy current target", async () => {
    const { c, calls } = client({ getTracked: async () => ({ hex: "aaa" }) }); // aaa is in scan
    const out = await runOnce(deps(c, async () => ({ action: "keep", reason: "" })), { lastSwitchMs: 0 });
    expect(calls).toEqual([]);
    expect(out.action).toEqual({ kind: "keep" });
  });

  // A refusal to park must never be silent: the operator complaint that
  // started this feature was literally "it's been pointing at my neighbours
  // for the last few minutes" -- a refusal with no visible trace anywhere
  // (mcp-client discarding the result, loop.ts never inspecting it) was
  // exactly that failure mode, just moved one level up.
  it("logs a refusal to park idle, but not the normal already_parked no-op or a success", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { c: refused } = client({
        scanAircraft: async () => [], parkIdle: async () => ({ parked: false, reason: "no_safe_path" }),
      });
      await runOnce(deps(refused, async () => ({ action: "keep", reason: "" })), { lastSwitchMs: 0 });
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toMatch(/no_safe_path/);

      errSpy.mockClear();
      const { c: alreadyParked } = client({
        scanAircraft: async () => [], parkIdle: async () => ({ parked: false, reason: "already_parked" }),
      });
      await runOnce(deps(alreadyParked, async () => ({ action: "keep", reason: "" })), { lastSwitchMs: 0 });
      expect(errSpy).not.toHaveBeenCalled();

      errSpy.mockClear();
      const { c: succeeded } = client({ scanAircraft: async () => [] }); // default parkIdle: parked:true
      await runOnce(deps(succeeded, async () => ({ action: "keep", reason: "" })), { lastSwitchMs: 0 });
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // I-2: the LLM prompt is built per-call from the ruleset the daemon just
  // returned (ChooseInput.ruleOrder), not a hard-coded four-tier scheme --
  // this pins that runOnce actually derives and threads it, one entry per
  // distinct tier present in this tick's scan, tier-ascending, deduped.
  it("threads a tier-ordered, deduped ruleOrder derived from this tick's scan into ChooseInput", async () => {
    const { c } = client({
      scanAircraft: async () => [
        { ...brief("aaa"), tier: 2, rule: "big-and-distant", canPreempt: false },
        { ...brief("bbb"), tier: 1, rule: "military", canPreempt: true },
        { ...brief("ccc"), tier: 1, rule: "military", canPreempt: true }, // same tier -- collapses to one entry
      ],
    });
    let seen: ChooseInput | null = null;
    await runOnce(deps(c, async (i) => { seen = i; return { action: "keep", reason: "" }; }), { lastSwitchMs: 0 });
    expect(seen).not.toBeNull();
    expect(seen!.ruleOrder).toEqual([
      { tier: 1, rule: "military", canPreempt: true },
      { tier: 2, rule: "big-and-distant", canPreempt: false },
    ]);
  });

  it("does not blow up sort order for an aircraft with an unknown (null) tier -- treated as lowest priority", async () => {
    const { c } = client({
      scanAircraft: async () => [
        { ...brief("aaa"), tier: null, rule: null, canPreempt: false },
        { ...brief("bbb"), tier: 1, rule: "military", canPreempt: false },
      ],
    });
    let seen: ChooseInput | null = null;
    await runOnce(deps(c, async (i) => { seen = i; return { action: "keep", reason: "" }; }), { lastSwitchMs: 0 });
    // The null-tier row is excluded from ruleOrder (no rule name to show) but
    // must not crash the sort or displace the real rule from position 1.
    expect(seen!.ruleOrder).toEqual([{ tier: 1, rule: "military", canPreempt: false }]);
    expect(seen!.trackable.map((a) => a.hex)).toEqual(["bbb", "aaa"]); // known tier sorts first
  });
});
