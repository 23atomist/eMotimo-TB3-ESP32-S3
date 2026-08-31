import { describe, it, expect, afterEach } from "vitest";
import { PolicyStore } from "../src/policy-store.js";
import { DEFAULT_RULESET } from "../src/policy/rules.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3pol-"));
  return join(dir, "sub", "policy.json");   // nested dir must be created on save
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

describe("PolicyStore", () => {
  it("falls back to the SHIPPED DEFAULTS when the file is missing", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    expect(s.get()).toEqual(DEFAULT_RULESET);
  });

  // The load-bearing divergence from FloorStore/SectorStore, which fall back to
  // DISABLED. A "disabled" policy admits everything -- the opposite of safe.
  it("falls back to the SHIPPED DEFAULTS on a corrupt file, never to 'admit everything'", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{ this is not json");
    const s = new PolicyStore(f);
    s.load();
    expect(s.get()).toEqual(DEFAULT_RULESET);
    expect(s.get().rules.length).toBeGreaterThan(0);
  });

  it("falls back to the shipped defaults when the file is schema-invalid", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ version: 1, rules: [{ id: "x" }] }));
    const s = new PolicyStore(f);
    s.load();
    expect(s.get()).toEqual(DEFAULT_RULESET);
  });

  it("round-trips a saved ruleset through a fresh instance", () => {
    const f = tmpFile();
    const a = new PolicyStore(f);
    a.load();
    a.set({ version: 1, rules: [
      { id: "arr", name: "East-flow arrival", enabled: true, canPreempt: false,
        conditions: [{ field: "climb_fpm", op: "lte", value: -500 }] },
    ] });

    const b = new PolicyStore(f);
    b.load();
    expect(b.get().rules).toHaveLength(1);
    expect(b.get().rules[0].name).toBe("East-flow arrival");
  });

  it("persists an EMPTY rule list -- 'track nothing' is a legal state", () => {
    const f = tmpFile();
    const a = new PolicyStore(f);
    a.load();
    a.set({ version: 1, rules: [] });

    const b = new PolicyStore(f);
    b.load();
    expect(b.get().rules).toEqual([]);   // NOT the defaults: this was chosen
  });

  // M-3: rule.id rides raw into dashboard/public/policy.js's data-rule-id
  // attribute and into a querySelector string -- an id with a quote is
  // attribute injection, and any other querySelector-illegal character
  // throws a SyntaxError out of render() on every tick, silently swallowed
  // by source.onmessage's catch, freezing the whole dashboard. Only a
  // hand-edited policy.json or a scripted set_policy can produce one (the
  // UI's own newRule() always mints a safe id) -- closing it off at the
  // schema means neither path can ever reach the browser.
  it("set() refuses a rule id containing a quote (attribute-injection risk)", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    expect(() => s.set({ version: 1, rules: [
      { id: 'x"onerror=alert(1)', name: "Bad id", enabled: true, canPreempt: false, conditions: [] },
    ] })).toThrow();
  });

  it("set() refuses a rule id containing a querySelector-illegal character", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    expect(() => s.set({ version: 1, rules: [
      { id: "a[b]", name: "Bad id", enabled: true, canPreempt: false, conditions: [] },
    ] })).toThrow();
  });

  it("falls back to the shipped defaults when a persisted file has a malformed rule id", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ version: 1, rules: [
      { id: 'x"y', name: "Bad id", enabled: true, canPreempt: false, conditions: [] },
    ] }));
    const s = new PolicyStore(f);
    s.load();
    expect(s.get()).toEqual(DEFAULT_RULESET);
  });

  it("set() accepts an id made only of letters, digits, underscore and hyphen", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    expect(() => s.set({ version: 1, rules: [
      { id: "east-flow_1", name: "Fine id", enabled: true, canPreempt: false, conditions: [] },
    ] })).not.toThrow();
  });

  it("get() returns a copy, so a caller cannot mutate the store's state", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    s.get().rules.pop();
    expect(s.get().rules).toHaveLength(DEFAULT_RULESET.rules.length);
  });
});
