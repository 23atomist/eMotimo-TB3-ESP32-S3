import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { RigMcpClient } from "./loop.js";
import { AircraftBrief } from "./llm.js";

const ScanRow = z.object({
  hex: z.string(), callsign: z.string().nullable(), category: z.string().nullable(),
  squawk: z.string().nullable(), altitude_m: z.number().nullable(),
  ground_speed_kt: z.number().nullable(), azimuth_deg: z.number(), elevation_deg: z.number(),
  range_km: z.number(), est_track_sec: z.number(),
});
const ScanBody = z.object({ aircraft: z.array(ScanRow) });
const TrackedBody = z.object({ hex: z.string().nullable() });
const StatusBody = z.object({ state: z.string(), label: z.string().nullable(), pointing_error_deg: z.number().nullable() });

function textOf(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  const t = r.content?.find((c) => c.type === "text")?.text;
  if (typeof t !== "string") throw new Error("tool returned no text content");
  return t;
}

export class McpRigClient implements RigMcpClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = new Client({ name: "tb3-agent", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const opts = this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), opts);
    await this.client.connect(transport);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    return textOf(await this.client.callTool({ name, arguments: args }));
  }

  async scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]> {
    const body = ScanBody.parse(JSON.parse(
      await this.call("scan_aircraft", { max_range_km: p.maxRangeKm, only_trackable: p.onlyTrackable, limit: p.limit })));
    return body.aircraft;
  }
  async getTracked(): Promise<{ hex: string | null }> {
    return { hex: TrackedBody.parse(JSON.parse(await this.call("get_tracked_aircraft", {}))).hex };
  }
  async getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }> {
    const b = StatusBody.parse(JSON.parse(await this.call("get_tracking_status", {})));
    return { state: b.state, label: b.label, pointingErrorDeg: b.pointing_error_deg };
  }
  async track(hex: string): Promise<void> { await this.call("track_aircraft", { hex }); }
  async stop(): Promise<void> { await this.call("stop_tracking", {}); }
}
