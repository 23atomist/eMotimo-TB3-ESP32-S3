# Dynamic Agent Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autonomous agent's target-eligibility rules editable data, authored from the dashboard, so a change in airport flow direction no longer requires a code edit and redeploy.

**Architecture:** A ruleset (ordered list of AND-conditions over ADS-B feed fields) is persisted as JSON and evaluated by a pure, deterministic function in the **daemon** — not in the agent process. `scan_aircraft` gains additive `tier`/`rule`/`eligible` fields plus an `only_eligible` filter, so the agent and the dashboard consume one implementation. The gate remains deterministic and upstream of the LLM.

**Tech Stack:** TypeScript (ESM, NodeNext), zod for schema validation, vitest for tests, vanilla JS for the dashboard (no build step, no new dependencies).

**Spec:** `docs/superpowers/specs/2026-08-30-dynamic-agent-policy-design.md`

## Global Constraints

- Run all commands from `tb3-mcp/`. Test runner is `npx vitest run`.
- ESM with NodeNext resolution: **every relative import must end in `.js`**, even when importing a `.ts` file.
- Null never satisfies a condition — including negative operators like `not_within`.
- A missing or corrupt `policy.json` falls back to the **shipped defaults**, never to "admit everything".
- Rules only ever *narrow* the candidate set. Reachability, sun cone, sector, floor, slew rate and telemetry freshness are independent downstream gates and must not be bypassable.
- Dashboard is vanilla JS served from `dashboard/public/`. No bundler, no framework, no new dependencies.
- Existing behaviour must not change until the operator edits a rule: the shipped defaults reproduce today's four tiers exactly.
- Commit after each task. Conventional commit format (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). No attribution trailers — this repo uses none.

## File Structure

**Created:**
- `src/policy/predicates.ts` — military predicates + ICAO type lists (moved from `src/agent/policy.ts`)
- `src/policy/rules.ts` — rule/condition types + pure evaluator + shipped defaults
- `src/policy-store.ts` — `policy.json` persistence
- `dashboard/public/policy.js` — rule editor UI (pure logic exported for tests)
- `test/policy-predicates.test.ts` — moved from `test/agent-policy.test.ts`
- `test/policy-rules.test.ts` — evaluator
- `test/policy-store.test.ts` — persistence + fallback
- `test/policy-ui.test.ts` — pure UI logic

**Modified:**
- `src/adsb-tools.ts` — `toPolicyTarget` adapter, ruleset threading, `only_eligible`, row fields
- `src/agent/loop.ts` — drop local tier map, consume daemon-supplied tiers
- `src/agent/decide.ts` — `canPreempt` from the row
- `src/agent/llm.ts` — `AircraftBrief` gains `tier`/`rule`
- `src/agent/mcp-client.ts` — pass `only_eligible`
- `src/server.ts` — construct + thread `PolicyStore`
- `src/dashboard/controls.ts`, `src/dashboard/server.ts`, `src/dashboard/state.ts`, `src/dashboard/client.ts` — `policy/set`, policy in state
- `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/cockpit.css` — panel
- `src/config.ts` — `idleParkTiltDeg`
- `src/track/supervisor.ts` — idle park

**Deleted:**
- `src/agent/policy.ts` (contents split into `src/policy/predicates.ts` and the shipped defaults in `src/policy/rules.ts`)

---

### Task 1: Move military predicates into `src/policy/`

The daemon must not import from `src/agent/` — that is backwards layering. This task is a pure move plus the `PolicyTarget` widening the evaluator needs. No behaviour change.

**Files:**
- Create: `src/policy/predicates.ts`
- Delete: `src/agent/policy.ts`
- Modify: `src/agent/decide.ts:2` (import path), `src/agent/loop.ts:3` (import path)
- Test: `test/policy-predicates.test.ts` (moved from `test/agent-policy.test.ts`)

**Interfaces:**
- Consumes: nothing
- Produces: `PolicyTarget`, `isMilitary(a: PolicyTarget): boolean`, `isLargeMilitary(a: PolicyTarget): boolean`, `LARGE_MILITARY_TYPES: Set<string>`, `OTHER_MILITARY_TYPES: Set<string>`

- [ ] **Step 1: Move the file and widen `PolicyTarget`**

```bash
mkdir -p src/policy
git mv src/agent/policy.ts src/policy/predicates.ts
git mv test/agent-policy.test.ts test/policy-predicates.test.ts
```

In `src/policy/predicates.ts`, widen the interface (the evaluator needs three more fields) and delete `Tier`, `classifyTier` and `canPreempt` — those are replaced by the rule engine in Task 2:

```ts
export interface PolicyTarget {
  category: string | null;      // ADS-B emitter category, A1..A5
  type: string | null;          // ICAO type code from the feed's `t` field
  operator: string | null;      // the feed's `ownOp`
  climb_fpm: number | null;
  track_deg: number | null;
  altitude_m: number | null;
  range_km: number;
  elevation_deg: number | null;
  ground_speed_kt: number | null;
  est_track_sec: number | null;
}
```

Keep `isLargeMilitary`, `isMilitary`, `typeOf`, `MILITARY_OPERATOR`, `LARGE_MILITARY_TYPES`, `OTHER_MILITARY_TYPES` exactly as they are. Delete `DEPARTURE_MIN_CLIMB_FPM`, `DEPARTURE_MAX_ALT_M`, `WEST_MIN_DEG`, `WEST_MAX_DEG`, `FALLBACK_MIN_KM`, `FALLBACK_MAX_KM`, `LARGE_CATEGORIES`, `isWestboundDeparture`, `isBigAndDistant`, `classifyTier`, `canPreempt` — Task 2 re-expresses all of them as the shipped default ruleset.

- [ ] **Step 2: Fix the moved test file**

In `test/policy-predicates.test.ts`, update the import to `../src/policy/predicates.js` and **delete every test that references `classifyTier` or `canPreempt`** (Task 2 re-adds equivalent coverage against the evaluator). Keep every `isMilitary` / `isLargeMilitary` test, especially the `ARMYTAGE HOLDINGS LLC` false-positive guard. Every retained `PolicyTarget` literal needs the three new fields added — set them to `null`.

- [ ] **Step 3: Run the moved tests**

Run: `npx vitest run test/policy-predicates.test.ts`
Expected: PASS.

- [ ] **Step 4: Point the two agent importers at the new path**

`src/agent/decide.ts:2` currently reads:

```ts
import { canPreempt, type Tier } from "./policy.js";
```

Replace with a local placeholder that Task 5 will remove — `decideAction` still needs to compile:

```ts
type Tier = number | null;
const canPreempt = (t: Tier): boolean => t === 1;
```

`src/agent/loop.ts:3` currently reads:

```ts
import { classifyTier, type Tier } from "./policy.js";
```

Replace with a local re-implementation that Task 5 will delete:

```ts
import { isMilitary, isLargeMilitary, type PolicyTarget } from "../policy/predicates.js";
type Tier = number | null;
function classifyTier(a: PolicyTarget): Tier {
  if (isLargeMilitary(a)) return 1;
  if (isMilitary(a)) return 2;
  if (a.climb_fpm !== null && a.climb_fpm >= 500 && a.altitude_m !== null && a.altitude_m <= 4500 && a.track_deg !== null) {
    const t = ((a.track_deg % 360) + 360) % 360;
    if (t >= 190 && t <= 350) return 3;
  }
  if (a.category !== null && ["A4", "A5"].includes(a.category.toUpperCase()) && a.range_km >= 60 && a.range_km <= 100) return 4;
  return null;
}
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.build.json --noEmit && npx vitest run`
Expected: clean typecheck, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A src/policy src/agent test
git commit -m "refactor(policy): move military predicates out of the agent module

The daemon is about to evaluate target policy, and a daemon importing from
src/agent/ is backwards layering. Pure move plus the three PolicyTarget
fields the rule evaluator needs. classifyTier is inlined into the agent
temporarily; the rule engine replaces it in the next commit."
```

---

### Task 2: Rule types, evaluator, and shipped defaults

**Files:**
- Create: `src/policy/rules.ts`
- Test: `test/policy-rules.test.ts`

**Interfaces:**
- Consumes: `PolicyTarget`, `isMilitary`, `isLargeMilitary` from `src/policy/predicates.js`; `inArc` from `src/track/sector.js`
- Produces: `Condition`, `PolicyRule`, `Ruleset`, `RuleMatch`, `evaluate(t: PolicyTarget, rs: Ruleset): RuleMatch | null`, `DEFAULT_RULESET: Ruleset`

- [ ] **Step 1: Write the failing tests**

Create `test/policy-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluate, DEFAULT_RULESET, type Ruleset, type PolicyRule } from "../src/policy/rules.js";
import type { PolicyTarget } from "../src/policy/predicates.js";

function target(over: Partial<PolicyTarget> = {}): PolicyTarget {
  return {
    category: null, type: null, operator: null,
    climb_fpm: null, track_deg: null, altitude_m: null,
    range_km: 10, elevation_deg: null, ground_speed_kt: null, est_track_sec: null,
    ...over,
  };
}
function rules(...rs: PolicyRule[]): Ruleset { return { version: 1, rules: rs }; }
function rule(over: Partial<PolicyRule> = {}): PolicyRule {
  return { id: "r1", name: "R1", enabled: true, canPreempt: false, conditions: [], ...over };
}

describe("evaluate — matching", () => {
  it("a rule with no conditions matches everything (an explicit catch-all)", () => {
    const m = evaluate(target(), rules(rule()));
    expect(m?.tier).toBe(1);
    expect(m?.ruleId).toBe("r1");
  });

  it("requires ALL conditions to pass (AND, not OR)", () => {
    const r = rule({ conditions: [
      { field: "climb_fpm", op: "gte", value: 500 },
      { field: "altitude_m", op: "lte", value: 4500 },
    ] });
    expect(evaluate(target({ climb_fpm: 900, altitude_m: 3000 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ climb_fpm: 900, altitude_m: 9000 }), rules(r))).toBeNull();
  });

  it("returns the FIRST matching rule and its 1-based position as the tier", () => {
    const a = rule({ id: "a", name: "A", conditions: [{ field: "range_km", op: "lte", value: 50 }] });
    const b = rule({ id: "b", name: "B", conditions: [] });
    const m = evaluate(target({ range_km: 10 }), rules(a, b));
    expect(m?.ruleId).toBe("a");
    expect(m?.tier).toBe(1);
  });

  it("carries canPreempt through from the matched rule", () => {
    const m = evaluate(target(), rules(rule({ canPreempt: true })));
    expect(m?.canPreempt).toBe(true);
  });

  it("returns null when nothing matches", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "gte", value: 500 }] });
    expect(evaluate(target({ range_km: 10 }), rules(r))).toBeNull();
  });

  it("returns null for an empty ruleset (legal: 'track nothing')", () => {
    expect(evaluate(target(), rules())).toBeNull();
  });
});

describe("evaluate — disabled rules", () => {
  it("skips a disabled rule entirely", () => {
    const off = rule({ id: "off", enabled: false, conditions: [] });
    expect(evaluate(target(), rules(off))).toBeNull();
  });

  it("numbers tiers over ENABLED rules only, so disabling promotes the rest", () => {
    const off = rule({ id: "off", enabled: false, conditions: [] });
    const on = rule({ id: "on", name: "On", conditions: [] });
    const m = evaluate(target(), rules(off, on));
    expect(m?.ruleId).toBe("on");
    expect(m?.tier).toBe(1);        // NOT 2 -- no gaps
  });
});

describe("evaluate — null never passes", () => {
  it("fails a numeric condition when the field is null", () => {
    const r = rule({ conditions: [{ field: "climb_fpm", op: "gte", value: 500 }] });
    expect(evaluate(target({ climb_fpm: null }), rules(r))).toBeNull();
  });

  it("fails a NEGATIVE condition when the field is null, rather than passing by absence", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "not_within", value: 50, value2: 130 }] });
    expect(evaluate(target({ track_deg: null }), rules(r))).toBeNull();
  });

  it("fails an `in` condition when the field is null", () => {
    const r = rule({ conditions: [{ field: "category", op: "in", values: ["A4"] }] });
    expect(evaluate(target({ category: null }), rules(r))).toBeNull();
  });
});

describe("evaluate — operators", () => {
  it("gte and lte are inclusive", () => {
    const gte = rule({ conditions: [{ field: "range_km", op: "gte", value: 10 }] });
    const lte = rule({ conditions: [{ field: "range_km", op: "lte", value: 10 }] });
    expect(evaluate(target({ range_km: 10 }), rules(gte))).not.toBeNull();
    expect(evaluate(target({ range_km: 10 }), rules(lte))).not.toBeNull();
  });

  it("within is inclusive on both bounds", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "within", value: 60, value2: 100 }] });
    expect(evaluate(target({ range_km: 60 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ range_km: 100 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ range_km: 59.9 }), rules(r))).toBeNull();
  });

  it("wraps track_deg across north", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "within", value: 340, value2: 20 }] });
    expect(evaluate(target({ track_deg: 350 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 10 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 180 }), rules(r))).toBeNull();
  });

  it("does NOT wrap a non-angular field", () => {
    const r = rule({ conditions: [{ field: "range_km", op: "within", value: 100, value2: 20 }] });
    expect(evaluate(target({ range_km: 50 }), rules(r))).toBeNull();
  });

  it("not_within is the exact complement of within for a present value", () => {
    const r = rule({ conditions: [{ field: "track_deg", op: "not_within", value: 340, value2: 20 }] });
    expect(evaluate(target({ track_deg: 180 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ track_deg: 10 }), rules(r))).toBeNull();
  });

  it("in matches case-insensitively and trimmed", () => {
    const r = rule({ conditions: [{ field: "type", op: "in", values: ["c17"] }] });
    expect(evaluate(target({ type: " C17 " }), rules(r))).not.toBeNull();
  });
});

describe("evaluate — predicates", () => {
  it("is_large_military matches on type", () => {
    const r = rule({ conditions: [{ predicate: "is_large_military" }] });
    expect(evaluate(target({ type: "C17" }), rules(r))).not.toBeNull();
    expect(evaluate(target({ type: "F16" }), rules(r))).toBeNull();
  });

  it("is_military combines with numeric conditions", () => {
    const r = rule({ conditions: [
      { predicate: "is_military" },
      { field: "altitude_m", op: "lte", value: 3000 },
    ] });
    expect(evaluate(target({ type: "F16", altitude_m: 2000 }), rules(r))).not.toBeNull();
    expect(evaluate(target({ type: "F16", altitude_m: 9000 }), rules(r))).toBeNull();
  });
});

// The migration proof: the shipped defaults must reproduce the pre-existing
// classifyTier exactly, so nothing changes until the operator edits a rule.
describe("DEFAULT_RULESET reproduces the original four tiers", () => {
  const tierOf = (t: PolicyTarget) => evaluate(t, DEFAULT_RULESET)?.tier ?? null;

  it("tier 1: large military", () => {
    expect(tierOf(target({ type: "C17" }))).toBe(1);
  });
  it("tier 2: other military by type", () => {
    expect(tierOf(target({ type: "F16" }))).toBe(2);
  });
  it("tier 2: military by operator string", () => {
    expect(tierOf(target({ operator: "UNITED STATES AIR FORCE" }))).toBe(2);
  });
  it("tier 3: westbound departure", () => {
    expect(tierOf(target({ climb_fpm: 1800, altitude_m: 2500, track_deg: 275 }))).toBe(3);
  });
  it("NOT tier 3: eastbound departure", () => {
    expect(tierOf(target({ climb_fpm: 3264, altitude_m: 1768, track_deg: 83 }))).toBeNull();
  });
  it("NOT tier 3: descending arrival", () => {
    expect(tierOf(target({ climb_fpm: -960, altitude_m: 785, track_deg: 275 }))).toBeNull();
  });
  it("NOT tier 3: climbing but too high", () => {
    expect(tierOf(target({ climb_fpm: 1800, altitude_m: 9000, track_deg: 275 }))).toBeNull();
  });
  it("tier 4: large category at distance", () => {
    expect(tierOf(target({ category: "A5", range_km: 80 }))).toBe(4);
  });
  it("NOT tier 4: large category too close", () => {
    expect(tierOf(target({ category: "A5", range_km: 20 }))).toBeNull();
  });
  it("only tier 1 may preempt", () => {
    expect(evaluate(target({ type: "C17" }), DEFAULT_RULESET)?.canPreempt).toBe(true);
    expect(evaluate(target({ type: "F16" }), DEFAULT_RULESET)?.canPreempt).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/policy-rules.test.ts`
Expected: FAIL — cannot resolve `../src/policy/rules.js`.

- [ ] **Step 3: Implement the evaluator**

Create `src/policy/rules.ts`:

```ts
import { inArc } from "../track/sector.js";
import { isMilitary, isLargeMilitary, type PolicyTarget } from "./predicates.js";

export type NumericField =
  | "climb_fpm" | "altitude_m" | "track_deg" | "range_km"
  | "elevation_deg" | "ground_speed_kt" | "est_track_sec";
export type SetField = "category" | "type";
export type PredicateName = "is_military" | "is_large_military";

export type Condition =
  | { field: NumericField; op: "gte" | "lte"; value: number }
  | { field: NumericField; op: "within" | "not_within"; value: number; value2: number }
  | { field: SetField; op: "in"; values: string[] }
  | { predicate: PredicateName };

export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  canPreempt: boolean;
  conditions: Condition[];
}

export interface Ruleset { version: 1; rules: PolicyRule[] }

export interface RuleMatch {
  tier: number;          // 1-based position among ENABLED rules
  ruleId: string;
  ruleName: string;
  canPreempt: boolean;
}

export const NUMERIC_FIELDS: NumericField[] = [
  "climb_fpm", "altitude_m", "track_deg", "range_km",
  "elevation_deg", "ground_speed_kt", "est_track_sec",
];
export const SET_FIELDS: SetField[] = ["category", "type"];
export const PREDICATES: PredicateName[] = ["is_military", "is_large_military"];

// Only headings wrap. range_km within 100..20 is an operator mistake, not a
// band spanning zero, and silently treating it as one would admit everything.
const ANGLE_FIELDS = new Set<NumericField>(["track_deg"]);

function numericOf(t: PolicyTarget, f: NumericField): number | null {
  const v = t[f];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function setValueOf(t: PolicyTarget, f: SetField): string | null {
  const v = t[f];
  return typeof v === "string" && v.trim() !== "" ? v.trim().toUpperCase() : null;
}

// Every branch is written so an ABSENT value fails -- including not_within,
// where "the field is not in the band" is tempting but wrong: climb_fpm is
// missing on roughly a quarter of the feed, and an unknown must never be
// admitted. Enforced here once so no future rule can reintroduce it.
function passes(t: PolicyTarget, c: Condition): boolean {
  if ("predicate" in c) {
    return c.predicate === "is_large_military" ? isLargeMilitary(t) : isMilitary(t);
  }
  if (c.op === "in") {
    const v = setValueOf(t, c.field);
    if (v === null) return false;
    return c.values.some((x) => x.trim().toUpperCase() === v);
  }
  const v = numericOf(t, c.field);
  if (v === null) return false;
  if (c.op === "gte") return v >= c.value;
  if (c.op === "lte") return v <= c.value;
  const within = ANGLE_FIELDS.has(c.field)
    ? inArc(v, { enabled: true, startDeg: c.value, endDeg: c.value2 })
    : v >= c.value && v <= c.value2;
  return c.op === "within" ? within : !within;
}

/**
 * First enabled rule whose conditions ALL pass. Tier is the 1-based position
 * among enabled rules, so toggling one off promotes the rest rather than
 * leaving a hole in the numbering.
 */
export function evaluate(t: PolicyTarget, rs: Ruleset): RuleMatch | null {
  let tier = 0;
  for (const r of rs.rules) {
    if (!r.enabled) continue;
    tier += 1;
    if (r.conditions.every((c) => passes(t, c))) {
      return { tier, ruleId: r.id, ruleName: r.name, canPreempt: r.canPreempt };
    }
  }
  return null;
}

/**
 * Reproduces the pre-2026-08-30 hard-coded classifyTier exactly, so a rig with
 * no policy.json behaves as it always has. test/policy-rules.test.ts pins the
 * equivalence; do not "tidy" these numbers.
 */
export const DEFAULT_RULESET: Ruleset = {
  version: 1,
  rules: [
    { id: "large-military", name: "Large military", enabled: true, canPreempt: true,
      conditions: [{ predicate: "is_large_military" }] },
    { id: "military", name: "Any military", enabled: true, canPreempt: false,
      conditions: [{ predicate: "is_military" }] },
    { id: "westbound-departure", name: "Westbound departure", enabled: true, canPreempt: false,
      conditions: [
        { field: "climb_fpm", op: "gte", value: 500 },
        { field: "altitude_m", op: "lte", value: 4500 },
        { field: "track_deg", op: "within", value: 190, value2: 350 },
      ] },
    { id: "big-and-distant", name: "Big & distant", enabled: true, canPreempt: false,
      conditions: [
        { field: "category", op: "in", values: ["A4", "A5"] },
        { field: "range_km", op: "within", value: 60, value2: 100 },
      ] },
  ],
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/policy-rules.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/policy/rules.ts test/policy-rules.test.ts
git commit -m "feat(policy): data-driven rule evaluator with the shipped defaults

An ordered list of AND-conditions over feed fields. First enabled rule
wins; its position among enabled rules is its tier, so toggling a rule off
promotes the rest instead of leaving a hole.

Null never satisfies a condition -- including not_within, where 'absent is
not in the band' is tempting and wrong. climb_fpm is missing on roughly a
quarter of the feed. Enforced centrally so no future rule can reintroduce
the bug the original code avoided clause by clause.

Only track_deg wraps: range_km within 100..20 is an operator mistake, not a
band spanning zero.

DEFAULT_RULESET reproduces the previous classifyTier exactly, pinned by
test, so nothing changes until a rule is edited."
```

---

### Task 3: `PolicyStore`

**Files:**
- Create: `src/policy-store.ts`
- Test: `test/policy-store.test.ts`

**Interfaces:**
- Consumes: `Ruleset`, `DEFAULT_RULESET` from `src/policy/rules.js`
- Produces: `class PolicyStore { constructor(filePath: string); load(): void; get(): Ruleset; set(rs: Ruleset): void }`, `RulesetSchema`

- [ ] **Step 1: Write the failing test**

Create `test/policy-store.test.ts`:

```ts
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

  it("get() returns a copy, so a caller cannot mutate the store's state", () => {
    const s = new PolicyStore(tmpFile());
    s.load();
    s.get().rules.pop();
    expect(s.get().rules).toHaveLength(DEFAULT_RULESET.rules.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/policy-store.test.ts`
Expected: FAIL — cannot resolve `../src/policy-store.js`.

- [ ] **Step 3: Implement the store**

Create `src/policy-store.ts`:

```ts
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Ruleset, DEFAULT_RULESET, NUMERIC_FIELDS, SET_FIELDS, PREDICATES } from "./policy/rules.js";

const NumericField = z.enum(NUMERIC_FIELDS as [string, ...string[]]);
const SetField = z.enum(SET_FIELDS as [string, ...string[]]);

const ConditionSchema = z.union([
  z.object({ field: NumericField, op: z.enum(["gte", "lte"]), value: z.number().finite() }),
  z.object({
    field: NumericField, op: z.enum(["within", "not_within"]),
    value: z.number().finite(), value2: z.number().finite(),
  }),
  z.object({ field: SetField, op: z.literal("in"), values: z.array(z.string().min(1)).min(1) }),
  z.object({ predicate: z.enum(PREDICATES as [string, ...string[]]) }),
]);

export const RulesetSchema = z.object({
  version: z.literal(1),
  rules: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    canPreempt: z.boolean(),
    conditions: z.array(ConditionSchema),
  })),
});

/**
 * Persistence for the agent's target policy.
 *
 * Deliberately NOT FloorStore's failure behaviour. Floor and sector fall back
 * to DISABLED because they are restrictions, and a broken restriction that
 * stops restricting is the safe direction. Policy inverts that: a "disabled"
 * policy admits EVERYTHING, which is the precise thing src/policy/ exists to
 * prevent. Missing or corrupt therefore means the SHIPPED DEFAULTS.
 *
 * An empty rules array is a different thing entirely -- it was chosen, it is
 * persisted, and it means "track nothing".
 */
export class PolicyStore {
  private ruleset: Ruleset = structuredClone(DEFAULT_RULESET);
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.ruleset = structuredClone(DEFAULT_RULESET); return; }
      this.ruleset = RulesetSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))) as Ruleset;
    } catch {
      this.ruleset = structuredClone(DEFAULT_RULESET);   // never throw, never "admit everything"
    }
  }

  get(): Ruleset { return structuredClone(this.ruleset); }

  set(rs: Ruleset): void {
    this.ruleset = RulesetSchema.parse(rs) as Ruleset;   // refuse to persist what we cannot load back
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.ruleset, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/policy-store.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/policy-store.ts test/policy-store.test.ts
git commit -m "feat(policy): persist the ruleset, defaulting to shipped rules on corruption

Shaped like FloorStore -- zod, atomic tmp+rename, load() never throws -- with
one deliberate divergence pinned by test: floor and sector fall back to
DISABLED, which is safe for a restriction, but a disabled POLICY admits
everything. Missing or corrupt therefore means the shipped defaults.

An empty rules array is persisted as chosen: 'track nothing' is a legal
state, distinct from 'the file is broken'."
```

---

### Task 4: Evaluate in `scan_aircraft`

**Files:**
- Modify: `src/adsb-tools.ts`
- Test: `test/adsb-tools.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `DEFAULT_RULESET`, `Ruleset` from `src/policy/rules.js`; `PolicyStore` from `src/policy-store.js`
- Produces: `toPolicyTarget(e: EnrichedAircraft, cfg: Config): PolicyTarget`; `scanAircraft(..., ruleset?: Ruleset)` 10th positional param; `ScanParams.onlyEligible?: boolean`; rows gain `tier: number | null`, `rule: string | null`, `eligible: boolean`; `registerAdsbTools(..., policyProvider?: () => Ruleset)` 11th param

- [ ] **Step 1: Write the failing test**

Append to `test/adsb-tools.test.ts`:

```ts
describe("scanAircraft — policy", () => {
  // A ruleset that admits only what is climbing hard, so a plain test aircraft
  // (no climb data) is ineligible while an explicit climber is not.
  const CLIMBERS = { version: 1 as const, rules: [
    { id: "climb", name: "Climbing", enabled: true, canPreempt: false,
      conditions: [{ field: "climb_fpm" as const, op: "gte" as const, value: 500 }] },
  ] };

  it("annotates every row with tier/rule/eligible without filtering by default", () => {
    const r = scanAircraft(snap([raw("a", 0.05)]), RIG, I, cfg, NIGHT, P, undefined, undefined, undefined, CLIMBERS);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);          // still present
    const v = viewOf(r.aircraft[0]);
    expect(v.eligible).toBe(false);              // but marked ineligible
    expect(v.tier).toBeNull();
    expect(v.rule).toBeNull();
  });

  it("filters to eligible aircraft only when only_eligible is set", () => {
    const r = scanAircraft(snap([raw("a", 0.05)]), RIG, I, cfg, NIGHT,
      { ...P, onlyEligible: true }, undefined, undefined, undefined, CLIMBERS);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
  });

  it("reports tier and rule name for an eligible aircraft", () => {
    const climbing = { ...raw("b", 0.05), geomRateFpm: 1800 };
    const r = scanAircraft(snap([climbing]), RIG, I, cfg, NIGHT, P, undefined, undefined, undefined, CLIMBERS);
    if ("error" in r) throw new Error(r.error);
    const v = viewOf(r.aircraft[0]);
    expect(v.eligible).toBe(true);
    expect(v.tier).toBe(1);
    expect(v.rule).toBe("Climbing");
  });

  // The narrowing invariant: policy may only ever REMOVE candidates.
  it("cannot admit an aircraft the trackability gate rejects", () => {
    const ADMIT_ALL = { version: 1 as const, rules: [
      { id: "all", name: "Everything", enabled: true, canPreempt: false, conditions: [] },
    ] };
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "80" });   // only near-zenith reachable
    const r = scanAircraft(snap([raw("low", 0.5, 3000)]), RIG, I, c2, NIGHT,
      { ...P, onlyEligible: true }, undefined, undefined, undefined, ADMIT_ALL);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
  });
});
```

Add this helper near the top of the file, beside the existing helpers, so the tests can read the annotated view:

```ts
import { toPolicyTarget } from "../src/adsb-tools.js";
import { evaluate, DEFAULT_RULESET, type Ruleset } from "../src/policy/rules.js";

function viewOf(e: EnrichedAircraft, rs: Ruleset = DEFAULT_RULESET) {
  const m = evaluate(toPolicyTarget(e, cfg), rs);
  return { tier: m?.tier ?? null, rule: m?.ruleName ?? null, eligible: m !== null };
}
```

Note: `viewOf` re-derives rather than reading the row, because `scanAircraft` returns `EnrichedAircraft[]` and the tier fields are attached by `view()` inside the tool handler. Task 4 Step 3 adds `tier`/`rule`/`eligible` to `EnrichedAircraft` itself so these assertions read real data — update `viewOf` to `(e) => ({ tier: e.tier, rule: e.rule, eligible: e.eligible })` once that lands, and delete the re-derivation.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/adsb-tools.test.ts`
Expected: FAIL — `toPolicyTarget` is not exported.

- [ ] **Step 3: Implement**

In `src/adsb/types.ts`, add to `EnrichedAircraft`:

```ts
  // Policy annotation, attached by scanAircraft. null tier == no rule matched.
  tier: number | null;
  rule: string | null;
  eligible: boolean;
  canPreempt: boolean;
```

In `src/adsb/enrich.ts`, initialise them in the returned object so the type is satisfied — `scanAircraft` overwrites them:

```ts
    tier: null, rule: null, eligible: false, canPreempt: false,
```

In `src/adsb-tools.ts`:

```ts
import { evaluate, DEFAULT_RULESET, type Ruleset } from "./policy/rules.js";
import type { PolicyTarget } from "./policy/predicates.js";

/**
 * EnrichedAircraft -> the flat shape the rule evaluator reads. Kept here rather
 * than in src/policy/ so the evaluator stays free of ADS-B and Config types and
 * can be tested with plain object literals.
 *
 * climb prefers the GEOMETRIC rate, matching view()'s climb_fpm: the two must
 * agree or a rule tuned against the displayed number would not be the rule that
 * runs.
 */
export function toPolicyTarget(e: EnrichedAircraft, cfg: Config): PolicyTarget {
  return {
    category: e.category,
    type: e.typeCode,
    operator: e.operator,
    climb_fpm: e.geomRateFpm ?? e.baroRateFpm,
    track_deg: e.trackDeg,
    altitude_m: aircraftAltitudeM(e, cfg.adsbAltSource),
    range_km: e.rangeM / 1000,
    elevation_deg: e.elevationDeg,
    ground_speed_kt: e.gsKt,
    est_track_sec: e.estTrackSec,
  };
}
```

Add `onlyEligible?: boolean` to `ScanParams`. Then in `scanAircraft`, add the 10th parameter and annotate **after** the trackability filter, so policy can only ever narrow:

```ts
  ruleset: Ruleset = DEFAULT_RULESET,
): { error: string } | { aircraft: EnrichedAircraft[] } {
  if (!rig) return { error: NOT_CALIBRATED };
  if ((p.onlyTrackable || p.onlyEligible) && !R) return { error: NOT_CALIBRATED };
  const maxRangeM = p.maxRangeKm * 1000;
  const enriched = snap.aircraft
    .map((a) => enrichAircraft(a, rig, R, cfg, nowMs, sector, cHead, limits))
    .filter((e): e is EnrichedAircraft => e !== null)
    .filter((e) => e.rangeM <= maxRangeM)
    .filter((e) => !p.onlyTrackable || isTrackable(e, cfg.trackMaxTargetAgeMs / 1000))
    // Policy runs AFTER trackability and only ever removes: a rule cannot make
    // an unreachable, sun-blocked or stale aircraft into a candidate.
    .map((e) => {
      const m = evaluate(toPolicyTarget(e, cfg), ruleset);
      return Object.assign(e, {
        tier: m?.tier ?? null, rule: m?.ruleName ?? null,
        eligible: m !== null, canPreempt: m?.canPreempt ?? false,
      });
    })
    .filter((e) => !p.onlyEligible || e.eligible)
    .sort((a, b) => a.rangeM - b.rangeM);
  return { aircraft: enriched.slice(0, p.limit) };
}
```

In `view()`, add the three reported fields after `in_sector`:

```ts
    tier: e.tier, rule: e.rule, eligible: e.eligible,
```

In `registerAdsbTools`, add an 11th parameter and a helper, mirroring `sectorStore`/`rangeStore`/`limitsProvider`:

```ts
  policyProvider: () => Ruleset = () => DEFAULT_RULESET,
): void {
```

```ts
  const ruleset = (): Ruleset => policyProvider();
```

Add `only_eligible` to `scan_aircraft`'s input schema:

```ts
        only_eligible: z.boolean().optional().describe("only aircraft matching an enabled policy rule (default false)"),
```

and pass it plus the ruleset at both `scanAircraft` call sites — `scan_aircraft` uses `onlyEligible: only_eligible ?? false`, and `track_aircraft` keeps `onlyEligible: false` (an operator naming a hex explicitly is not subject to the agent's policy).

- [ ] **Step 4: Simplify the test helper and run**

Replace `viewOf` with the direct read now that the fields exist:

```ts
function viewOf(e: EnrichedAircraft) {
  return { tier: e.tier, rule: e.rule, eligible: e.eligible };
}
```

Run: `npx vitest run test/adsb-tools.test.ts test/adsb-enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.build.json --noEmit && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 6: Commit**

```bash
git add src/adsb-tools.ts src/adsb/enrich.ts src/adsb/types.ts test/adsb-tools.test.ts
git commit -m "feat(adsb): evaluate target policy in scan_aircraft

Rows gain tier/rule/eligible, and only_eligible (default false) filters to
candidates. Additive, so every existing caller is unaffected.

Policy runs AFTER the trackability filter and only ever removes, pinned by a
test that a rule admitting everything still cannot produce an unreachable
candidate. That narrowing property is the whole safety argument for moving
the gate out of the agent.

track_aircraft deliberately does NOT apply policy: an operator naming a hex
is not subject to the agent's rules."
```

---

### Task 5: Agent consumes daemon-supplied tiers

**Files:**
- Modify: `src/agent/loop.ts`, `src/agent/decide.ts`, `src/agent/llm.ts`, `src/agent/mcp-client.ts`
- Test: `test/agent-loop.test.ts`, `test/agent-decide.test.ts`

**Interfaces:**
- Consumes: rows carrying `tier`/`rule`/`eligible`/`canPreempt` from Task 4
- Produces: `AircraftBrief` gains `tier: number | null`, `rule: string | null`, `canPreempt: boolean`; `DecideInput.candidateTier` replaced by `candidateCanPreempt: boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/agent-decide.test.ts`:

```ts
it("keeps the current pass when the candidate's rule may not preempt", () => {
  const a = decideAction({
    decision: { action: "track", hex: "bbb" },
    trackableHexes: new Set(["aaa", "bbb"]),
    currentHex: "aaa", currentHealthy: true,
    msSinceLastSwitch: 99_999, minDwellMs: 25_000,
    candidateCanPreempt: false,
  });
  expect(a).toEqual({ kind: "keep" });
});

it("switches mid-pass when the candidate's rule MAY preempt", () => {
  const a = decideAction({
    decision: { action: "track", hex: "bbb" },
    trackableHexes: new Set(["aaa", "bbb"]),
    currentHex: "aaa", currentHealthy: true,
    msSinceLastSwitch: 99_999, minDwellMs: 25_000,
    candidateCanPreempt: true,
  });
  expect(a).toEqual({ kind: "track", hex: "bbb" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/agent-decide.test.ts`
Expected: FAIL — `candidateCanPreempt` is not a known property.

- [ ] **Step 3: Implement**

In `src/agent/decide.ts`, delete the temporary `Tier`/`canPreempt` shim added in Task 1, replace `candidateTier: Tier | null` in `DecideInput` with `candidateCanPreempt: boolean`, and change line 39 to:

```ts
  if (inp.currentHex !== null && inp.currentHealthy && !inp.candidateCanPreempt) {
```

In `src/agent/llm.ts`, add to `AircraftBrief`:

```ts
  tier: number | null;
  rule: string | null;
  canPreempt: boolean;
```

In `src/agent/mcp-client.ts`, pass `only_eligible: true` alongside `only_trackable` in `scanAircraft`, and carry `tier`, `rule`, `canPreempt` through into the parsed brief.

In `src/agent/loop.ts`, delete the temporary `classifyTier` and the `tiers` map added in Task 1. The daemon already filtered and range-sorted, so the loop sorts by tier only:

```ts
export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  // The policy gate still runs BEFORE the model sees anything -- it now runs in
  // the daemon (only_eligible), so the dashboard and the agent share one
  // implementation instead of two that can drift.
  const scanned = await deps.client.scanAircraft({
    maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, onlyEligible: true, limit: 20,
  });
  const trackable = [...scanned].sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9));
  const tracked = await deps.client.getTracked();
  const status = await deps.client.getStatus();

  const trackableHexes = new Set(trackable.map((a) => a.hex.toLowerCase()));
  const currentHex = tracked.hex ? tracked.hex.toLowerCase() : null;
  const currentHealthy = currentHex !== null && trackableHexes.has(currentHex);

  let action: Action;
  try {
    const decision = await deps.choose({
      trackable,
      current: { hex: currentHex, label: status.label, state: status.state, pointingErrorDeg: status.pointingErrorDeg },
    });
    action = decideAction({
      decision, trackableHexes, currentHex, currentHealthy,
      msSinceLastSwitch: deps.now() - state.lastSwitchMs, minDwellMs: deps.cfg.minDwellMs,
      candidateCanPreempt:
        trackable.find((a) => a.hex.toLowerCase() === (decision.hex ?? "").toLowerCase())?.canPreempt ?? false,
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  return { action, state: { lastSwitchMs } };
}
```

Add `onlyEligible: boolean` to the `RigMcpClient.scanAircraft` parameter type.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/agent-decide.test.ts test/agent-loop.test.ts`
Expected: PASS. Update any existing fixture in those files that supplies `candidateTier` or builds an `AircraftBrief` — add `tier`, `rule`, `canPreempt`.

- [ ] **Step 5: Typecheck and full suite, then commit**

Run: `npx tsc -p tsconfig.build.json --noEmit && npx vitest run`

```bash
git add src/agent test
git commit -m "refactor(agent): consume daemon-evaluated tiers instead of classifying locally

The loop's own classifyTier map is gone; rows arrive tiered from
scan_aircraft(only_eligible). decideAction takes candidateCanPreempt off the
row rather than testing tier === 1, so preemption follows the rule the
operator marked rather than a list position that reordering silently
changes.

The 'policy gate BEFORE the model sees anything' invariant is unchanged --
the gate simply executes one process earlier."
```

---

### Task 6: Wire the store through the daemon and dashboard transport

**Files:**
- Modify: `src/server.ts`, `src/dashboard/controls.ts`, `src/dashboard/server.ts`, `src/dashboard/state.ts`, `src/dashboard/client.ts`
- Test: `test/control.test.ts`

**Interfaces:**
- Consumes: `PolicyStore` from Task 3
- Produces: `ControlDeps.setPolicy(rs: Ruleset): Promise<string>`; action `policy/set`; `DashboardState.policy: Ruleset`

- [ ] **Step 1: Write the failing test**

Append to `test/control.test.ts`, matching the file's existing `runAction` harness style:

```ts
it("policy/set forwards the ruleset to the daemon", async () => {
  let got: unknown = null;
  const deps = makeDeps({ setPolicy: async (rs: unknown) => { got = rs; return "policy saved (1 rule)"; } });
  const rs = { version: 1, rules: [
    { id: "a", name: "A", enabled: true, canPreempt: false, conditions: [] },
  ] };
  const r = await runAction(deps, "policy/set", { ruleset: rs });
  expect(r.ok).toBe(true);
  expect(got).toEqual(rs);
});

it("policy/set rejects a malformed ruleset rather than persisting it", async () => {
  const deps = makeDeps({ setPolicy: async () => { throw new Error("invalid ruleset"); } });
  const r = await runAction(deps, "policy/set", { ruleset: { version: 9, rules: "nope" } });
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/control.test.ts`
Expected: FAIL — unknown action `policy/set`.

- [ ] **Step 3: Implement**

`src/server.ts` — construct beside the other stores (near line 531 where `LimitsStore` is built):

```ts
  const policyFile = join(stateDir, "policy.json");
  const policyStore = new PolicyStore(policyFile);
  policyStore.load();
  console.error(`agent target policy file: ${policyFile} (${policyStore.get().rules.filter((r) => r.enabled).length} enabled rules)`);
```

and pass it as the 11th argument at line 445:

```ts
        registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore, rangeStore,
          () => limitsStore.get(), () => policyStore.get());
```

`src/dashboard/controls.ts` — add to `ControlDeps`:

```ts
  setPolicy(ruleset: unknown): Promise<string>;
```

and a case beside `sector/set`:

```ts
      case "policy/set":
        return { ok: true, message: await d.setPolicy(body.ruleset) };
```

`src/dashboard/server.ts` — add to the deps object beside `agentStart`:

```ts
    setPolicy: (rs: unknown) => s.client.setPolicy(rs),
```

`src/dashboard/client.ts` — call a new `set_policy` MCP tool; `src/dashboard/state.ts` — add `policy: Ruleset` to `DashboardState` and populate it from `get_policy`.

Register both tools in `src/adsb-tools.ts` beside `scan_aircraft` (they are policy tools and belong with the evaluator's owner):

```ts
  server.registerTool(
    "get_policy",
    { description: "The agent's current target-eligibility ruleset.", inputSchema: {} },
    async () => text(JSON.stringify(policyProvider(), null, 2)),
  );
```

`set_policy` takes `{ ruleset: z.unknown() }`, calls a `policySetter` callback (a 12th `registerAdsbTools` parameter defaulting to a no-op that throws `"policy is read-only"`), and returns a confirmation naming the enabled-rule count. `src/server.ts` passes `(rs) => policyStore.set(rs as Ruleset)`; `PolicyStore.set`'s `RulesetSchema.parse` is what rejects malformed input.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/control.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npx tsc -p tsconfig.build.json --noEmit && npx vitest run`

```bash
git add src test
git commit -m "feat(policy): expose the ruleset over MCP and the dashboard control API

get_policy/set_policy live beside scan_aircraft, with the evaluator's owner.
policyStore.set validates through the same zod schema load() uses, so the
daemon refuses to persist anything it could not read back."
```

---

### Task 7: The rule editor UI

**Files:**
- Create: `dashboard/public/policy.js`, `test/policy-ui.test.ts`
- Modify: `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/cockpit.css`

**Interfaces:**
- Consumes: `postControl` from `app.js`; `policy` and per-aircraft `tier`/`rule` from `/api/state`
- Produces: `validateRule(rule): string | null`, `newRule(): PolicyRule`, `moveRule(rules, index, delta): PolicyRule[]`, `countMatches(rules, aircraft): number[]`, `wirePolicyDelegates(root, { postControl, isEstopLatched })`

- [ ] **Step 1: Write the failing test**

Create `test/policy-ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateRule, newRule, moveRule, countMatches } from "../dashboard/public/policy.js";

describe("validateRule", () => {
  it("accepts a complete rule", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "climb_fpm", op: "gte", value: 500 }] })).toBeNull();
  });

  it("rejects an empty name, which would render as a blank row", () => {
    expect(validateRule({ id: "a", name: "  ", enabled: true, canPreempt: false, conditions: [] }))
      .toMatch(/name/i);
  });

  it("rejects a condition with a missing value, so a half-typed rule cannot be saved", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "climb_fpm", op: "gte", value: null }] })).toMatch(/value/i);
  });

  it("rejects a within condition missing its upper bound", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "track_deg", op: "within", value: 190, value2: null }] })).toMatch(/value/i);
  });

  it("rejects an `in` condition with no values selected", () => {
    expect(validateRule({ id: "a", name: "A", enabled: true, canPreempt: false,
      conditions: [{ field: "category", op: "in", values: [] }] })).toMatch(/at least one/i);
  });

  it("accepts a rule with no conditions -- an explicit catch-all", () => {
    expect(validateRule({ id: "a", name: "Everything", enabled: true, canPreempt: false, conditions: [] }))
      .toBeNull();
  });
});

describe("newRule", () => {
  it("mints a unique id each time so reordering stays non-destructive", () => {
    expect(newRule().id).not.toBe(newRule().id);
  });
  it("defaults canPreempt to false -- interrupting a pass is opt-in", () => {
    expect(newRule().canPreempt).toBe(false);
  });
});

describe("moveRule", () => {
  const rs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves a rule up", () => {
    expect(moveRule(rs, 1, -1).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
  it("moves a rule down", () => {
    expect(moveRule(rs, 1, 1).map((r) => r.id)).toEqual(["a", "c", "b"]);
  });
  it("is a no-op at the top edge", () => {
    expect(moveRule(rs, 0, -1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("is a no-op at the bottom edge", () => {
    expect(moveRule(rs, 2, 1).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("does not mutate the input array", () => {
    moveRule(rs, 1, -1);
    expect(rs.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("countMatches", () => {
  it("counts aircraft per rule using the tier the daemon reported", () => {
    const rules = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    const aircraft = [{ rule: "A" }, { rule: "A" }, { rule: "B" }, { rule: null }];
    expect(countMatches(rules, aircraft)).toEqual([2, 1]);
  });
  it("returns zeroes when nothing matches", () => {
    expect(countMatches([{ id: "a", name: "A" }], [{ rule: null }])).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/policy-ui.test.ts`
Expected: FAIL — cannot resolve `../dashboard/public/policy.js`.

- [ ] **Step 3: Implement the pure logic**

Create `dashboard/public/policy.js`. Pure functions first, exported for tests — the DOM wiring stays thin below them, following `stick-hold.js` and `aircraft-select.js`:

```js
// Rule editor for the agent's target policy. The pure functions below are
// unit-tested (test/policy-ui.test.ts); the DOM wiring under them is not.
// That split exists because the tilt_dps ReferenceError (90a7ae6) shipped from
// an untested app.js path -- pure logic in a testable module is the cheap half
// of the defence.

export function newRule() {
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return { id, name: "New rule", enabled: true, canPreempt: false, conditions: [] };
}

export function validateRule(rule) {
  if (!rule.name || rule.name.trim() === "") return "Rule needs a name";
  for (const c of rule.conditions) {
    if (c.predicate) continue;
    if (c.op === "in") {
      if (!Array.isArray(c.values) || c.values.length === 0) return `${c.field}: pick at least one value`;
      continue;
    }
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) return `${c.field}: needs a value`;
    if ((c.op === "within" || c.op === "not_within") &&
        (typeof c.value2 !== "number" || !Number.isFinite(c.value2))) {
      return `${c.field}: needs a second value`;
    }
  }
  return null;
}

// Immutable: returns a new array. A no-op at either edge rather than wrapping,
// because a rule silently jumping from top to bottom would change which rules
// preempt without the operator meaning it.
export function moveRule(rules, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= rules.length) return [...rules];
  const out = [...rules];
  const [x] = out.splice(index, 1);
  out.splice(to, 0, x);
  return out;
}

// Counts per rule using the daemon's own annotation, so the number shown is
// produced by the evaluator that actually runs -- never a second copy of the
// matching logic in the browser.
export function countMatches(rules, aircraft) {
  return rules.map((r) => aircraft.filter((a) => a.rule === r.name).length);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/policy-ui.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Add the DOM layer**

Append to `dashboard/public/policy.js` a `renderPolicyPanel(root, state)` that draws the rule list (name, on/off checkbox, tier number, live match count from `countMatches`, `▲ ▼ edit delete` buttons) and the expanded editor (name input, `can interrupt a pass` checkbox, condition rows built from the field/operator vocabulary), plus `wirePolicyDelegates(root, { postControl, isEstopLatched })` using a single delegated `click`/`change` listener on `root` — the pattern `sector.js` uses.

Save posts the whole ruleset, debounced 400 ms, exactly as `sector.js:242-252` does:

```js
postControl("policy/set", { ruleset: { version: 1, rules } });
```

Disable the Save control while `validateRule` returns non-null for any rule, and render the returned message beside the offending row.

In `index.html` add the panel container inside the setup drawer beside the sector panel; in `app.js` import and call `policy.wirePolicyDelegates(el.drawerBody, { postControl, isEstopLatched: () => estop.isLatched() })` beside the existing `sector.wireSectorDelegates` call at line 923; in `cockpit.css` add rules for `.policy-row`, `.policy-editor`, `.policy-count` reusing the existing drawer variables.

Add a **tier column** to the aircraft strip rendering, showing `a.rule ?? "—"`.

- [ ] **Step 6: Manual check, then commit**

Run: `npx vitest run && npx tsc -p tsconfig.build.json --noEmit`

Load the dashboard, open the setup drawer, confirm: rules list with live counts; ▲▼ reorder; add/delete; Save disabled on an incomplete condition; a reload shows the persisted rules.

```bash
git add dashboard/public test/policy-ui.test.ts
git commit -m "feat(dashboard): rule editor for the agent target policy

Live per-rule match counts against the current aircraft list, so editing a
threshold shows its effect immediately -- on 2026-08-30 answering 'why is it
not tracking' cost a Python script and a raw-feed dump.

Counts come from the daemon's own tier annotation rather than a second copy
of the matching logic in the browser.

Reorder is buttons, not drag: HTML5 drag is unreliable under touch and this
is used on a roof. Pure logic is exported and unit-tested; the DOM wiring is
thin."
```

---

### Task 8: Idle park and the elevation floor

**Files:**
- Modify: `src/config.ts`, `src/track/supervisor.ts`, `src/agent/loop.ts`
- Test: `test/supervisor.test.ts`

**Interfaces:**
- Consumes: `SunSupervisor`'s existing park machinery
- Produces: `cfg.idleParkTiltDeg` (default 45); `SunSupervisor.parkIdle(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `test/supervisor.test.ts`:

```ts
describe("idle park", () => {
  it("parks up at idleParkTiltDeg when the agent has nothing to track", async () => {
    const { sup, device } = harness({ TB3_IDLE_PARK_TILT_DEG: "45" });
    await sup.parkIdle();
    expect(device.lastGoto?.tiltDeg).toBeCloseTo(45, 1);
  });

  // The sun park points DOWN at -20 to get the lens off the sun; the idle park
  // points UP to get it off the neighbours. They must never be confused.
  it("refuses to idle-park while sun-locked, leaving the sun park in force", async () => {
    const { sup, device } = harness();
    sup.forceSunLockForTest();
    device.lastGoto = null;
    await sup.parkIdle();
    expect(device.lastGoto).toBeNull();
  });

  it("refuses to idle-park while a tracking session is active", async () => {
    const { sup, device, session } = harness();
    session.setActiveForTest(true);
    device.lastGoto = null;
    await sup.parkIdle();
    expect(device.lastGoto).toBeNull();
  });

  it("does not re-issue a park it has already completed", async () => {
    const { sup, device } = harness();
    await sup.parkIdle();
    const first = device.gotoCount;
    await sup.parkIdle();
    expect(device.gotoCount).toBe(first);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/supervisor.test.ts`
Expected: FAIL — `parkIdle` is not a function.

- [ ] **Step 3: Implement**

`src/config.ts` — beside `parkTiltDeg` (line 72):

```ts
    idleParkTiltDeg: z.number().default(45),
```

and in the env block beside line 256:

```ts
  set("idleParkTiltDeg", num(env.TB3_IDLE_PARK_TILT_DEG));
```

`src/track/supervisor.ts` — add `parkIdle()`, reusing the existing park plan machinery but with the idle posture and its own guards:

```ts
  /**
   * Point the rig UP between passes so an idle autonomous rig does not rest on
   * the horizon -- which is where the neighbours' windows are.
   *
   * Deliberately NOT inside TrackingSession.stop(): that method is on the
   * E-STOP and sun-lock paths, and "stop moving" must never become "now execute
   * a slew".
   *
   * Note this is the OPPOSITE direction from the sun park (parkTiltDeg -20,
   * which points down and away from the sun). They share the machinery, not the
   * posture, and the sun always wins.
   */
  async parkIdle(): Promise<void> {
    if (this.state === "parking" || this.state === "parked" || this.state === "fault") return;
    if (this.session.isActive()) return;
    if (this.idleParked) return;                       // dwell: do not re-issue
    await this.gotoWithinLimits(this.idleParkTiltDeg);
    this.idleParked = true;
  }
```

Clear `idleParked = false` wherever a track begins, so the next idle re-parks.

`src/agent/loop.ts` — after the action is applied, park when the agent has nothing:

```ts
  if (action.kind === "stop" || (action.kind === "keep" && currentHex === null && trackable.length === 0)) {
    await deps.client.parkIdle();
  }
```

Add `parkIdle(): Promise<void>` to `RigMcpClient`, backed by a new `park_idle` MCP tool that calls `supervisor.parkIdle()`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/supervisor.test.ts test/agent-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: DO NOT enable the elevation floor** (corrected after final review)

The original step wrote `floor.json` to the rig. Do not. `isTrackable` does not
include the floor, so enabling it makes the agent latch on below-floor targets
that `TrackingSession` then refuses, which suppresses idle park entirely and
freezes the rig where the last pass ended — the exact symptom this plan exists
to fix. See the spec's "Floor — DO NOT ENABLE YET" section. The floor ships
separately, after `isTrackable` learns about it.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npx tsc -p tsconfig.build.json --noEmit && npx vitest run`

```bash
git add src test
git commit -m "feat(track): park the rig up when autonomous mode has nothing to track

A pass ending near the horizon left the rig resting on the neighbours'
houses through multi-minute idle gaps -- the reported symptom on 2026-08-30,
when reverse operations starved the agent to 2 eligible aircraft out of 14.

Reuses SunSupervisor's park machinery but not its posture: parkTiltDeg is
-20 and points DOWN away from the sun, which is exactly where the houses
are. idleParkTiltDeg defaults to 45 and points up. The sun park always wins.

Deliberately not inside TrackingSession.stop(), which is on the E-STOP and
sun-lock paths, where 'stop moving' must never become 'now execute a slew'."
```

---

### Task 9: Deploy and verify on the rig

**Files:** none (operational)

- [ ] **Step 1: Build and deploy**

```bash
ssh atomist@192.168.4.71 'cd ~/TB3-ESP32 && git pull && cd tb3-mcp && npm run build'
ssh atomist@192.168.4.71 'sudo systemctl restart tb3-mcp tb3-agent'
```

- [ ] **Step 2: Verify the defaults loaded and nothing changed**

```bash
ssh atomist@192.168.4.71 'sudo journalctl -u tb3-mcp -n 20 --no-pager | grep -i "policy\|floor"'
```
Expected: `agent target policy file: ... (4 enabled rules)`. The floor stays
disabled — see Task 8 Step 5.

- [ ] **Step 3: Confirm the tier annotation is live**

```bash
curl -s http://192.168.4.71:8788/api/state | python3 -c "
import sys,json; d=json.load(sys.stdin)
for a in d['adsb']['aircraft'][:10]:
    print('%-7s %-9s tier=%-5s rule=%s'%(a['hex'],str(a.get('callsign')),str(a.get('tier')),str(a.get('rule'))))"
```
Expected: real tier/rule values; the counts must match what the agent tracks.

- [ ] **Step 4: Add an east-flow arrival rule from the UI and watch it take effect**

In the dashboard: add a rule `East-flow arrival` with `climb_fpm lte -500`, `altitude_m lte 4500`, `track_deg within 50..130`. Save. Confirm without any restart that the live match count is non-zero and the agent begins selecting arrivals.

- [ ] **Step 5: Commit nothing; record the outcome**

Report measured before/after eligible counts.

---

## Self-Review

**Spec coverage:** rule model → Task 2; tier numbering over enabled rules → Task 2 Step 1; predicates → Tasks 1–2; angle wrap via `inArc` → Task 2; null-never-passes → Task 2; placement in daemon → Task 4; `scan_aircraft` additive fields + `only_eligible` → Task 4; agent changes → Task 5; per-rule preemption → Task 5; persistence + defaults-on-corruption → Task 3; empty ruleset legal → Task 3; narrowing invariant → Task 4 Step 1; UI + live counts + ▲▼ → Task 7; tier column → Task 7 Step 5; park-on-idle + precedence → Task 8; floor → Task 8 Step 5; testing → throughout.

**Deliberately deferred, with reasons in the spec:** OR-groups, undo/history, `explain: true`. The sun-park/taught-limit interaction (`parkTiltDeg` −20° vs taught `tiltMin` −2.33°) is flagged in the spec as out of scope — verify separately rather than fold a safety-path change into a feature.

**Known smell, not addressed:** `scanAircraft` reaches 10 positional parameters at Task 4. Converting to an options object would touch every call site and test in the same commit as a behaviour change, which is the wrong trade. Worth a follow-up refactor once this settles.
