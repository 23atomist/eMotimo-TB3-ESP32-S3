import { z } from "zod";

export const DecisionSchema = z.object({
  action: z.enum(["track", "keep", "stop"]),
  hex: z.string().nullish(),
  reason: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface AircraftBrief {
  hex: string;
  callsign: string | null;
  category: string | null;
  squawk: string | null;
  type: string | null;        // ICAO type code -- the military/size signal
  operator: string | null;    // owner/operator
  climb_fpm: number | null;   // >0 climbing; a departure is climbing AND low
  track_deg: number | null;   // heading, degrees true
  altitude_m: number | null;
  ground_speed_kt: number | null;
  azimuth_deg: number;
  elevation_deg: number;
  range_km: number;
  est_track_sec: number;
  tier: number | null;
  rule: string | null;
  canPreempt: boolean;
}

// One enabled rule's priority slot, derived by loop.ts from the tier/rule the
// daemon already annotated the current scan with (see AircraftBrief.tier/
// rule/canPreempt) -- never a second copy of the ruleset itself. Ordered
// ascending by tier (1-based position among ENABLED rules, same numbering
// evaluate() in src/policy/rules.ts uses), so this is only ever the rules
// that actually produced a live candidate THIS tick -- a rule with zero
// current matches simply doesn't appear, which is fine: the point is to
// describe the order of the list the LLM was actually handed, not to mirror
// the full ruleset.
export interface RuleOrderEntry { tier: number; rule: string; canPreempt: boolean; }

export interface ChooseInput {
  trackable: AircraftBrief[];
  current: { hex: string | null; label: string | null; state: string; pointingErrorDeg: number | null };
  ruleOrder: RuleOrderEntry[];
}

// Built fresh per call from the ruleset the daemon just evaluated (via
// ruleOrder), never hard-coded -- see this module's own history: the prompt
// used to describe the pre-2026-08-30 fixed four-tier scheme by name ("(1)
// large military ... (4) large aircraft at distance") and to single out
// "a large military aircraft" as the only thing allowed to interrupt a
// healthy pass. Both were dead the moment per-rule `canPreempt` became
// operator-editable: an operator-added "can interrupt a pass" rule got
// silently ignored (decideAction only preempts a candidate the LLM proposes
// tracking, and the old prompt forbade proposing anything but large military
// for that), and after any reorder the numbered list described an ordering
// that no longer existed. Rule-neutral now: canPreempt is read straight off
// each candidate in the list, never named here.
export function buildSystemPrompt(ruleOrder: RuleOrderEntry[]): string {
  const order = ruleOrder.length > 0
    ? ruleOrder.map((r) => `(${r.tier}) ${r.rule}`).join(", ")
    : "no operator rule currently has a live candidate";
  return (
    "You choose which aircraft a camera rig should film. The list you are given has ALREADY been " +
    "filtered by the operator's hard rules -- every aircraft in it is reachable, sun-safe, within slew " +
    "rate, and allowed. You do NOT need to re-check any of that, and you must not reject a candidate " +
    "for being the wrong direction or type; if it is in the list, it is permitted. " +
    `The list is ordered best-first by the operator's own rule priority: ${order}. ` +
    "Normally pick the FIRST aircraft in the list. Only pick a later one when it is clearly a better " +
    "film for an obvious reason -- much closer, much longer time in view (est_track_sec), or an " +
    "emergency squawk (7500/7600/7700). " +
    "If you are already tracking something, KEEP it: the rig commits to a pass and does not switch " +
    "part-way through. The ONLY exception is a candidate whose matched rule is marked as able to " +
    "interrupt a pass -- shown as canPreempt:true on that aircraft in the list; that per-candidate " +
    "flag is the sole reason to switch off a healthy target, never the aircraft's type or class. " +
    "If the list is empty, STOP. " +
    'Respond ONLY as JSON {"action":"track"|"keep"|"stop","hex"?:string,"reason":string}. ' +
    "For action \"track\", hex MUST be one of the listed hexes."
  );
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["track", "keep", "stop"] },
    hex: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["action", "hex", "reason"],
  additionalProperties: false,
};

export async function chooseTarget(
  llmUrl: string, model: string, input: ChooseInput,
  fetchFn: typeof fetch = fetch, timeoutMs = 10000,
): Promise<Decision> {
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: buildSystemPrompt(input.ruleOrder) },
      { role: "user", content: JSON.stringify(input) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "decision", schema: RESPONSE_SCHEMA, strict: true } },
  };
  const r = await fetchFn(llmUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("LLM response had no message content");
  return DecisionSchema.parse(JSON.parse(content));
}
