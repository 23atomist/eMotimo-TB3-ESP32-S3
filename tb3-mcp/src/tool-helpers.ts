// Shared MCP tool-response helpers. Extracted from tools.ts/geo-tools.ts/
// track-tools.ts/sun-tools.ts, which each defined text()/errText() (and,
// tools.ts + geo-tools.ts, an identical SUN_LOCKED_MSG) independently.

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

// The standing sun-lockout refusal message. Byte-identical to the copies it
// replaces (tools.ts, geo-tools.ts) — existing tests assert this string.
export const SUN_LOCKED_MSG = "sun guard active; blocked to protect the camera — clear it with set_sun_guard";
