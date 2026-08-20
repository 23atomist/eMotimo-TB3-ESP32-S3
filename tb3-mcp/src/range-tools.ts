import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RangeStore } from "./range-store.js";
import { text } from "./tool-helpers.js";

export function registerRangeTools(server: McpServer, rangeStore: RangeStore): void {
  server.registerTool(
    "get_track_range",
    { description: "Report the maximum slant range (km) an aircraft may be at to count as trackable.", inputSchema: {} },
    async () => text(JSON.stringify({ max_range_km: rangeStore.get() })),
  );
  server.registerTool(
    "set_track_range",
    {
      description:
        "Set the maximum slant range (km) for trackability. Aircraft beyond it are excluded from the trackable " +
        "list and from autonomous selection; the map still shows them.",
      inputSchema: { max_range_km: z.number().positive().max(500).describe("max slant range in km") },
    },
    async ({ max_range_km }) => {
      rangeStore.set(max_range_km);
      return text(JSON.stringify({ max_range_km: rangeStore.get() }));
    },
  );
}
