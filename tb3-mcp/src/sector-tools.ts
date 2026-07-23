import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SectorStore } from "./sector-store.js";
import { TrackSector } from "./track/sector.js";
import { text } from "./tool-helpers.js";

const bearing = z.number().min(0).max(360);

// Validated set: bearings in [0,360]; throws (no persist) otherwise. A bearing
// of exactly 360 is allowed and normalized by inArc; the store keeps it as-is.
export function applySectorUpdate(
  store: SectorStore, args: { startDeg: number; endDeg: number; enabled: boolean },
): TrackSector {
  const parsed = z.object({ startDeg: bearing, endDeg: bearing, enabled: z.boolean() }).parse(args);
  const sector: TrackSector = { enabled: parsed.enabled, startDeg: parsed.startDeg, endDeg: parsed.endDeg };
  store.set(sector);
  return store.get();
}

const wire = (s: TrackSector) => ({ enabled: s.enabled, start_deg: s.startDeg, end_deg: s.endDeg });

export function registerSectorTools(server: McpServer, sectorStore: SectorStore): void {
  server.registerTool(
    "get_track_sector",
    { description: "Report the tracking azimuth sector (open arc of bearings tracking is restricted to). enabled=false means no restriction.", inputSchema: {} },
    async () => text(JSON.stringify(wire(sectorStore.get()))),
  );
  server.registerTool(
    "set_track_sector",
    {
      description: "Set the tracking azimuth sector — the OPEN arc (clockwise from start_deg to end_deg, true-north bearings) that tracking is restricted to. enabled=false disables the restriction. Planes outside the arc become untrackable; a track that leaves the arc holds.",
      inputSchema: {
        start_deg: bearing.describe("open-arc start bearing, degrees true north [0,360]"),
        end_deg: bearing.describe("open-arc end bearing, degrees (arc sweeps clockwise start->end; may wrap north)"),
        enabled: z.boolean().describe("false = no azimuth restriction"),
      },
    },
    async ({ start_deg, end_deg, enabled }) => {
      const s = applySectorUpdate(sectorStore, { startDeg: start_deg, endDeg: end_deg, enabled });
      return text(JSON.stringify({ ...wire(s), note: enabled ? "tracking restricted to the open arc" : "azimuth restriction off" }));
    },
  );
}
