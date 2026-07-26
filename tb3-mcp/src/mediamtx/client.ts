export interface PathInfo {
  name: string;
  ready: boolean;
  readers: number;
}

export function parsePathInfo(json: unknown): PathInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  return {
    name: o.name,
    ready: o.ready === true,
    readers: Array.isArray(o.readers) ? o.readers.length : 0,
  };
}

const DEFAULT_TIMEOUT_MS = 3000;

// Talks to MediaMTX's control API over loopback. Both the dashboard (reader
// count) and the daemon (record valve) use this; neither process calls the
// other, so MediaMTX is where they meet.
//
// NOTE: verify /v3/config/paths/patch/{name} against the pinned MediaMTX
// version at deploy time -- the route is version-dependent.
export class MediaMtxClient {
  private readonly controlUrl: string;
  private readonly path: string;
  private readonly timeoutMs: number;
  private err: string | null = null;

  constructor(opts: { controlUrl: string; path: string; timeoutMs?: number }) {
    this.controlUrl = opts.controlUrl.replace(/\/+$/, "");
    this.path = opts.path;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  lastError(): string | null { return this.err; }

  private async call(url: string, init?: RequestInit): Promise<Response> {
    const ctl = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(url, { ...init, signal: ctl });
    if (!res.ok) throw new Error(`mediamtx HTTP ${res.status}`);
    return res;
  }

  // Soft read: never throws. A missing MediaMTX must not break status polling.
  async pathInfo(): Promise<PathInfo | null> {
    try {
      const res = await this.call(`${this.controlUrl}/v3/paths/get/${encodeURIComponent(this.path)}`);
      const info = parsePathInfo(await res.json());
      this.err = info ? null : "unparseable path info";
      return info;
    } catch (e: unknown) {
      this.err = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  // Hard write: throws so the caller can log and surface it. Recording must
  // never silently not-happen.
  async setRecord(on: boolean): Promise<void> {
    try {
      await this.call(`${this.controlUrl}/v3/config/paths/patch/${encodeURIComponent(this.path)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record: on }),
      });
      this.err = null;
    } catch (e: unknown) {
      this.err = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }
}
