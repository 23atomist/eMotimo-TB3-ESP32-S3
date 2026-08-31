import { describe, it, expect } from "vitest";
import { chooseTarget, DecisionSchema, buildSystemPrompt, type ChooseInput } from "../src/agent/llm.js";

const INPUT: ChooseInput = {
  trackable: [
    { hex: "abc123", callsign: "UAL1", category: "A3", squawk: "1200", altitude_m: 9000,
      type: null, operator: null, climb_fpm: null, track_deg: null,
      ground_speed_kt: 420, azimuth_deg: 90, elevation_deg: 30, range_km: 40, est_track_sec: 60,
      tier: null, rule: null, canPreempt: false },
  ],
  current: { hex: null, label: null, state: "stopped", pointingErrorDeg: null },
  ruleOrder: [],
};

function llmReturning(content: string, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) })) as unknown as typeof fetch;
}

// Captures the request body chooseTarget actually sent, so a test can assert
// on the generated system prompt without duplicating buildSystemPrompt's own
// wording.
function capturingFetch(content: string): { fetchFn: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(init?.body ? JSON.parse(init.body) : null);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
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

  it("schema accepts an explicit null hex (strict-schema conformant backends)", () => {
    const d = DecisionSchema.parse({ action: "keep", hex: null, reason: "x" });
    expect(d.hex).toBeNull();
  });

  // I-2: the system prompt sent to the LLM must reflect the operator's ACTUAL
  // ruleset for this call, not the pre-2026-08-30 hard-coded four-tier
  // scheme -- see buildSystemPrompt's own doc for the failure this fixes
  // (an operator's custom canPreempt rule silently did nothing, and the
  // prompt's numbered list described an ordering that no longer existed
  // after any reorder).
  it("sends a system prompt built from this call's ruleOrder, not the retired hard-coded tiers", async () => {
    const { fetchFn, bodies } = capturingFetch(JSON.stringify({ action: "keep", reason: "x" }));
    const customInput: ChooseInput = {
      ...INPUT,
      ruleOrder: [
        { tier: 1, rule: "Neighbourhood departures", canPreempt: false },
        { tier: 2, rule: "Weekend airshow traffic", canPreempt: true },
      ],
    };
    await chooseTarget("http://llm", "m", customInput, fetchFn);
    const sent = bodies[0] as { messages: { role: string; content: string }[] };
    const system = sent.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("Neighbourhood departures");
    expect(system).toContain("Weekend airshow traffic");
    expect(system).not.toMatch(/large military/i);
    expect(system).not.toMatch(/westbound/i);
  });
});

describe("buildSystemPrompt", () => {
  it("lists the operator's own rules, in tier order, when the ruleset has live candidates", () => {
    const p = buildSystemPrompt([
      { tier: 1, rule: "East-flow arrivals", canPreempt: false },
      { tier: 3, rule: "Airshow special", canPreempt: true },
    ]);
    expect(p).toContain("(1) East-flow arrivals");
    expect(p).toContain("(3) Airshow special");
  });

  it("names no specific rule and states nothing is currently live when ruleOrder is empty", () => {
    const p = buildSystemPrompt([]);
    expect(p).toMatch(/no operator rule currently has a live candidate/);
  });

  it("never mentions the retired hard-coded tiering, regardless of ruleset", () => {
    const p = buildSystemPrompt([{ tier: 1, rule: "Custom rule", canPreempt: true }]);
    expect(p).not.toMatch(/large military/i);
    expect(p).not.toMatch(/big.*distant/i);
  });

  it("ties the preempt exception to the candidate's own canPreempt flag, not an aircraft class", () => {
    const p = buildSystemPrompt([{ tier: 1, rule: "Custom rule", canPreempt: true }]);
    expect(p).toMatch(/canPreempt/);
  });
});
