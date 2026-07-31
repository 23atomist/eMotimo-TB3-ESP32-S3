// PURE: turn a daemon tool's raw text payload into something worth showing an
// operator in a toast.
//
// Several tools (teach_limit, nudge_aim_offset, sight_aircraft, solve_
// calibration, the capture tools) return a JSON DOCUMENT as their text, and
// runAction relays that verbatim as ActionResult.message. Dumping it into a
// toast shows a wall of braces and quotes -- reported from the field on
// 2026-07-30 as "now i'm getting json errors", which is precisely what it
// looks like from the outside. Nothing was broken; the presentation was.
//
// Kept out of app.js because app.js touches `document` at module load and so
// cannot be imported by a test -- the same reason every other pure bit of
// this dashboard lives in its own file.

export function humanizeToolMessage(message) {
  if (typeof message !== "string") return message ?? null;
  const t = message.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return message;

  let doc;
  try { doc = JSON.parse(t); } catch { return message; }
  // Malformed or non-object JSON is returned untouched: hiding something we
  // failed to parse is how a real error becomes invisible.
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return message;

  // A tool that already wrote prose for the operator has done this job better
  // than any generic formatter can.
  if (typeof doc.note === "string" && doc.note.trim()) return doc.note.trim();
  if (typeof doc.message === "string" && doc.message.trim()) return doc.message.trim();

  const parts = [];
  for (const [k, v] of Object.entries(doc)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;        // nested detail is not toast material
    if (v === false) continue;                  // "clamped: false" every 200ms is noise
    parts.push(`${k.replace(/_/g, " ")}: ${v}`);
  }
  return parts.length ? parts.join(", ") : message;
}
