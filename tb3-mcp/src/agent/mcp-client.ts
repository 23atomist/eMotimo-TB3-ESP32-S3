import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { RigMcpClient } from "./loop.js";
import type { AircraftBrief } from "./llm.js";

const ScanRow = z.object({
  hex: z.string(), callsign: z.string().nullable(), category: z.string().nullable(),
  squawk: z.string().nullable(), altitude_m: z.number().nullable(),
  ground_speed_kt: z.number().nullable(), azimuth_deg: z.number(), elevation_deg: z.number(),
  range_km: z.number(), est_track_sec: z.number(),
});
const ScanBody = z.object({ aircraft: z.array(ScanRow) });
const TrackedBody = z.object({ hex: z.string().nullable() });
const StatusBody = z.object({ state: z.string(), label: z.string().nullable(), pointing_error_deg: z.number().nullable() });

// Narrow a CallToolResult to its text content, throwing on an error result so
// a daemon-reported failure (isError:true, e.g. sun-lock, not-calibrated, or a
// hex that dropped out of the trackable set between scan and track) becomes a
// real, catchable error — not a false success (which would let runOnce stamp
// lastSwitchMs for a switch that never happened) or an opaque JSON.parse crash.
export function resultText(name: string, result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const t = r.content?.find((c) => c.type === "text")?.text;
  if (typeof t !== "string") throw new Error(`${name}: tool returned no text content`);
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
}

// When the daemon restarts it mints a new MCP session, so an existing client's
// session id becomes invalid and every call then fails with "no valid session"
// (JSON-RPC -32000, HTTP 400/404) FOREVER, since the SDK doesn't renegotiate on
// its own. Matching those lets a call transparently reconnect + retry -- which
// is what stops a restart of tb3-mcp from permanently breaking downstream
// clients (frozen dashboard telemetry, a "Stop tracking" that never lands).
export function isSessionError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no valid session|session (?:not found|expired|invalid)|-32000/i.test(m);
}

export class McpRigClient implements RigMcpClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = this.newClient();
  }

  private newClient(): Client { return new Client({ name: "tb3-agent", version: "0.1.0" }); }

  private transportOpts(): { requestInit: { headers: Record<string, string> } } | undefined {
    return this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url), this.transportOpts()));
  }

  private async reconnect(): Promise<void> {
    try { await this.client.close(); } catch { /* already gone */ }
    this.client = this.newClient();
    await this.connect();
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      return resultText(name, await this.client.callTool({ name, arguments: args }));
    } catch (e) {
      if (!isSessionError(e)) throw e;
      await this.reconnect();
      return resultText(name, await this.client.callTool({ name, arguments: args }));
    }
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
