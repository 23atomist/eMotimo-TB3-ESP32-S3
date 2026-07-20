import { describe, it, expect } from "vitest";
import { chooseTarget, DecisionSchema, type ChooseInput } from "../src/agent/llm.js";

const INPUT: ChooseInput = {
  trackable: [
    { hex: "abc123", callsign: "UAL1", category: "A3", squawk: "1200", altitude_m: 9000,
      ground_speed_kt: 420, azimuth_deg: 90, elevation_deg: 30, range_km: 40, est_track_sec: 60 },
  ],
  current: { hex: null, label: null, state: "stopped", pointingErrorDeg: null },
};

function llmReturning(content: string, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) })) as unknown as typeof fetch;
}

describe("chooseTarget", () => {
  it("parses a valid decision", async () => {
    const d = await chooseTarget("http://llm/v1/chat/completions", "m",
      INPUT, llmReturning(JSON.stringify({ action: "track", hex: "abc123", reason: "only heavy nearby" })));
    expect(d).toEqual({ action: "track", hex: "abc123", reason: "only heavy nearby" });
  });

  it("throws on HTTP error", async () => {
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning("{}", false))).rejects.toThrow(/HTTP 500/);
  });

  it("throws on malformed content", async () => {
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning("not json"))).rejects.toThrow();
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning(JSON.stringify({ action: "banana" })))).rejects.toThrow();
  });

  it("schema accepts keep/stop without a hex", () => {
    expect(DecisionSchema.parse({ action: "keep", reason: "current is good" }).action).toBe("keep");
    expect(DecisionSchema.parse({ action: "stop", reason: "nothing worth it" }).action).toBe("stop");
  });
});
