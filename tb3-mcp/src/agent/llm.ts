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
  "You choose which aircraft a camera rig should track. You are given a list of aircraft that are " +
  "ALL already reachable, sun-safe, and within the rig's slew rate — you only need to judge which is " +
  "MOST INTERESTING to film. Prefer, roughly in order: emergency squawks (7500 hijack, 7600 radio " +
  "failure, 7700 general emergency); military or state aircraft (odd hex ranges, no callsign, unusual " +
  "categories); heavies and rare types (A388, B748, A345, warbirds); then anything unusual (odd " +
  "callsign, very low/very high, loitering). If you are already tracking a good target, KEEP it unless " +
  "a clearly more interesting one appears — do not thrash. If nothing is worth filming, STOP. " +
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
