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

// Constrained beyond "non-empty": id rides RAW into dashboard/public/
// policy.js's `data-rule-id="…"` attribute and into a `.policy-count[data-
// rule-id="${id}"]` querySelector string (see that module's own doc). A
// quote in id is attribute injection there; any other querySelector-illegal
// character (an unescaped `[`, `]`, whitespace, etc.) throws a SyntaxError
// out of render() on every SSE tick, silently caught by source.onmessage's
// catch -- the entire dashboard stops updating with no visible error. A
// hand-edited policy.json or a scripted set_policy is the only way in (the
// UI's own newRule() always mints a safe id), but closing it off costs
// nothing.
const RuleId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id must be 1-64 chars of [A-Za-z0-9_-]");

export const RulesetSchema = z.object({
  version: z.literal(1),
  rules: z.array(z.object({
    id: RuleId,
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
