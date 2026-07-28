// MCP tools for the operator-taught travel limits (see limits-store.ts):
// teach_limit captures the CURRENT position as one of the four edges,
// get_taught_limits reports what has been taught (plus the config ceiling and
// the resulting effective range), and clear_taught_limits reverts to the
// config ceiling. Read-only-of-motion: none of these three ever command the
// rig, they only read its current telemetry or the store, so — unlike
// jog/goto_angle/etc. — there is no sun-lock or tracking-active gate here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { LimitsStore, LimitEdge, CeilingLimits, effectiveLimits } from "./limits-store.js";
import { currentUserPanTilt } from "./geo-tools.js";
import { text, errText } from "./tool-helpers.js";

const EDGE_ARG = z.enum(["pan_min", "pan_max", "tilt_min", "tilt_max"]);
type EdgeArg = z.infer<typeof EDGE_ARG>;

const EDGE_MAP: Record<EdgeArg, LimitEdge> = {
  pan_min: "panMin", pan_max: "panMax", tilt_min: "tiltMin", tilt_max: "tiltMax",
};

// A taught edge that leaves less than this much room against the OTHER edge
// on the same axis (whichever is currently effective — taught if set, else
// the config ceiling) is refused rather than persisted. Without this, an
// operator could teach panMin/panMax (or tiltMin/tiltMax) into an inverted or
// degenerate range, which checkPanTilt/reachablePanTilt would then read as
// "nothing on this axis is reachable" — a self-inflicted, silent lockout
// recoverable only via clear_taught_limits.
const MIN_SPAN_DEG = 1;

export function ceilingFrom(cfg: Config): CeilingLimits {
  return { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax };
}

export type TeachResult =
  | { value: number; clamped: boolean }
  | { error: string };

// The set_track_sector-style core: validate + persist, callable directly from
// a test without going through the MCP transport. Clamps `candidate` to the
// config ceiling on `edge`'s side (never wider than config — the whole point
// of the ceiling), then refuses (without persisting) if the result would
// leave less than MIN_SPAN_DEG against the opposite edge.
export function applyTeachLimit(
  store: LimitsStore, cfg: Config, edge: LimitEdge, candidateDeg: number,
): TeachResult {
  const ceiling = ceilingFrom(cfg);
  let value = candidateDeg;
  let clamped = false;

  if (edge === "panMin" && value < ceiling.panMin) { value = ceiling.panMin; clamped = true; }
  if (edge === "panMax" && value > ceiling.panMax) { value = ceiling.panMax; clamped = true; }
  if (edge === "tiltMin" && value < ceiling.tiltMin) { value = ceiling.tiltMin; clamped = true; }
  if (edge === "tiltMax" && value > ceiling.tiltMax) { value = ceiling.tiltMax; clamped = true; }

  const eff = effectiveLimits(ceiling, store.get());
  if (edge === "panMin" && value > eff.panMax - MIN_SPAN_DEG) {
    return { error: `refusing to teach pan_min=${value.toFixed(2)}° — it would leave less than ${MIN_SPAN_DEG}° of pan travel against the current pan_max (${eff.panMax.toFixed(2)}°)` };
  }
  if (edge === "panMax" && value < eff.panMin + MIN_SPAN_DEG) {
    return { error: `refusing to teach pan_max=${value.toFixed(2)}° — it would leave less than ${MIN_SPAN_DEG}° of pan travel against the current pan_min (${eff.panMin.toFixed(2)}°)` };
  }
  if (edge === "tiltMin" && value > eff.tiltMax - MIN_SPAN_DEG) {
    return { error: `refusing to teach tilt_min=${value.toFixed(2)}° — it would leave less than ${MIN_SPAN_DEG}° of tilt travel against the current tilt_max (${eff.tiltMax.toFixed(2)}°)` };
  }
  if (edge === "tiltMax" && value < eff.tiltMin + MIN_SPAN_DEG) {
    return { error: `refusing to teach tilt_max=${value.toFixed(2)}° — it would leave less than ${MIN_SPAN_DEG}° of tilt travel against the current tilt_min (${eff.tiltMin.toFixed(2)}°)` };
  }

  store.setEdge(edge, value);
  return { value, clamped };
}

export function registerLimitsTools(server: McpServer, device: Device, cfg: Config, store: LimitsStore): void {
  server.registerTool(
    "teach_limit",
    {
      description:
        "Capture the rig's CURRENT pan or tilt position as one edge of the operator-taught travel " +
        "limits (pan_min, pan_max, tilt_min, tilt_max). Jog carefully to where a cable just begins to " +
        "tension, then call this. A taught limit can only ever be TIGHTER than the configured pan/tilt " +
        "range, never wider — a capture beyond the config ceiling is clamped to it. Every enforcement " +
        "path (jog, goto_angle, tracking, point_at/point_at_azel) uses whichever is tighter.",
      inputSchema: { edge: EDGE_ARG.describe("which travel edge to capture from the current position") },
    },
    async ({ edge }) => {
      const { panDeg, tiltDeg, moving } = currentUserPanTilt(device, cfg);
      const key = EDGE_MAP[edge];
      const candidate = key.startsWith("pan") ? panDeg : tiltDeg;
      const result = applyTeachLimit(store, cfg, key, candidate);
      if ("error" in result) return errText(result.error);
      const moveWarn = moving ? " WARNING: the rig was still moving; position may not be settled — re-teach once stopped." : "";
      const note = result.clamped
        ? `clamped to the configured ceiling (captured position was outside the configured range).${moveWarn}`
        : `captured.${moveWarn}`;
      return text(JSON.stringify({
        edge, value_deg: Number(result.value.toFixed(3)), clamped: result.clamped, note,
      }));
    },
  );

  server.registerTool(
    "get_taught_limits",
    {
      description:
        "Report the operator-taught travel limits (null per edge if never taught), the configured " +
        "pan/tilt ceiling, and the effective range actually enforced everywhere (whichever is tighter, " +
        "per edge).",
      inputSchema: {},
    },
    async () => {
      const taught = store.get();
      const ceiling = ceilingFrom(cfg);
      const eff = effectiveLimits(ceiling, taught);
      return text(JSON.stringify({
        taught: {
          pan_min: taught.panMin ?? null, pan_max: taught.panMax ?? null,
          tilt_min: taught.tiltMin ?? null, tilt_max: taught.tiltMax ?? null,
        },
        config_ceiling: {
          pan_min: ceiling.panMin, pan_max: ceiling.panMax, tilt_min: ceiling.tiltMin, tilt_max: ceiling.tiltMax,
        },
        effective: {
          pan_min: eff.panMin, pan_max: eff.panMax, tilt_min: eff.tiltMin, tilt_max: eff.tiltMax,
        },
      }, null, 2));
    },
  );

  server.registerTool(
    "clear_taught_limits",
    {
      description: "Clear every operator-taught travel limit, reverting the effective pan/tilt range to the configured ceiling.",
      inputSchema: {},
    },
    async () => {
      store.clear();
      return text("taught limits cleared — the effective range is now the configured ceiling");
    },
  );
}
