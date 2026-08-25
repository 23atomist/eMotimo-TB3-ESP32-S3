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
}

export interface ChooseInput {
  trackable: AircraftBrief[];
  current: { hex: string | null; label: string | null; state: string; pointingErrorDeg: number | null };
}

export const SYSTEM_PROMPT =
  "You choose which aircraft a camera rig should film. The list you are given has ALREADY been " +
  "filtered by the operator's hard rules -- every aircraft in it is reachable, sun-safe, within slew " +
  "rate, and allowed. You do NOT need to re-check any of that, and you must not reject a candidate " +
  "for being the wrong direction or type; if it is in the list, it is permitted. " +
  "The list is ordered best-first by the operator's priority: (1) large military aircraft, " +
  "(2) any other military, (3) aircraft taking off westbound, (4) large aircraft at distance. " +
  "Normally pick the FIRST aircraft in the list. Only pick a later one when it is clearly a better " +
  "film for an obvious reason -- much closer, much longer time in view (est_track_sec), or an " +
  "emergency squawk (7500/7600/7700). " +
  "If you are already tracking something, KEEP it: the rig commits to a pass and does not switch " +
  "part-way through. The only reason to switch off a healthy target is a large military aircraft. " +
  "If the list is empty, STOP. " +
  'Respond ONLY as JSON {"action":"track"|"keep"|"stop","hex"?:string,"reason":string}. ' +
  "For action \"track\", hex MUST be one of the listed hexes.";

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
      { role: "system", content: SYSTEM_PROMPT },
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
