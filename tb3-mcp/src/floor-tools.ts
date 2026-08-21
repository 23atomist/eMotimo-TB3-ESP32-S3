import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FloorStore } from "./floor-store.js";
import { TrackFloor } from "./track/floor.js";
import { text } from "./tool-helpers.js";

// A floor above the horizon is the point of the feature, but negative values
// stay legal: an operator on a hilltop or a tall roof may genuinely want to
// film below level, and -90..90 is simply the range an elevation can take.
const elevation = z.number().min(-90).max(90);

// Validated set: elevation in [-90,90]; throws (no persist) otherwise.
export function applyFloorUpdate(
  store: FloorStore, args: { minElevationDeg: number; enabled: boolean },
): TrackFloor {
  const parsed = z.object({ minElevationDeg: elevation, enabled: z.boolean() }).parse(args);
  const floor: TrackFloor = { enabled: parsed.enabled, minElevationDeg: parsed.minElevationDeg };
  store.set(floor);
  return store.get();
}

const wire = (f: TrackFloor) => ({ enabled: f.enabled, min_elevation_deg: f.minElevationDeg });

export function registerFloorTools(server: McpServer, floorStore: FloorStore): void {
  server.registerTool(
    "get_min_track_elevation",
    {
      description:
        "Report the minimum tracking elevation (the floor below which tracking will not aim). enabled=false means no restriction.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(wire(floorStore.get()))),
  );
  server.registerTool(
    "set_min_track_elevation",
    {
      description:
        "Set the minimum tracking elevation — tracking refuses any target below this many degrees above the horizon, and a track that descends past it holds. Use this to stop the camera aiming at nearby ground, buildings or windows. This gates TRACKING ONLY: manual jog, goto and the levelling workflow can still drive the rig below it, so setting a floor does not cost you the ability to level. enabled=false disables the restriction.",
      inputSchema: {
        min_elevation_deg: elevation.describe("minimum elevation above the horizon, degrees [-90,90]"),
        enabled: z.boolean().describe("false = no elevation restriction"),
      },
    },
    async ({ min_elevation_deg, enabled }) => {
      const f = applyFloorUpdate(floorStore, { minElevationDeg: min_elevation_deg, enabled });
      return text(JSON.stringify({
        ...wire(f),
        note: enabled
          ? `tracking will hold below ${f.minElevationDeg}deg elevation (jog/goto unaffected)`
          : "elevation restriction off",
      }));
    },
  );
}
