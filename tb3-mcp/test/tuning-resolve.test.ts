import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuningStore } from "../src/tuning-store.js";
import { resolveTuning } from "../src/tuning-resolve.js";

const cfg = { maxAimOffsetDeg: 20, calibVideoLatencyMs: 300, trackLeadMs: 150, captureTimeoutMs: 10000 } as never;

function newStore(): TuningStore {
  const s = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-")), "t.json"));
  s.load();
  return s;
}

describe("resolveTuning", () => {
  it("falls through to config when nothing is tuned", () => {
    const s = newStore();
    expect(resolveTuning(s, cfg)).toEqual({
      maxAimOffsetDeg: 20, calibVideoLatencyMs: 300, trackLeadMs: 150, captureTimeoutMs: 10000,
    });
  });

  it("a tuned value overrides config, others still fall through", () => {
    const s = newStore();
    s.set({ maxAimOffsetDeg: 35 });
    const r = resolveTuning(s, cfg);
    expect(r.maxAimOffsetDeg).toBe(35);
    expect(r.trackLeadMs).toBe(150);
  });

  it("a later change is visible WITHOUT rebuilding anything — this is the whole feature", () => {
    const s = newStore();
    expect(resolveTuning(s, cfg).maxAimOffsetDeg).toBe(20);
    s.set({ maxAimOffsetDeg: 35 });
    expect(resolveTuning(s, cfg).maxAimOffsetDeg).toBe(35);
  });

  it("tolerates an absent store (tuning not wired) and returns config", () => {
    expect(resolveTuning(undefined, cfg).trackLeadMs).toBe(150);
  });
});
