import { RigDirect, parseRigStatus } from "./parse.js";

const TIMEOUT_MS = 3000;

export class RigDirectClient {
  constructor(private readonly hosts: string[], private readonly fetchFn: typeof fetch = fetch) {}

  async status(): Promise<RigDirect> {
    for (const h of this.hosts) {
      try {
        const r = await this.fetchFn(`http://${h}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) continue;
        return parseRigStatus(await r.json());
      } catch { /* try next host */ }
    }
    return parseRigStatus(null);   // not connected
  }

  // Throws on failure so the e-stop fan-out reports the firmware leg as failed.
  async stop(): Promise<void> {
    let lastErr: unknown = new Error("no rig host reachable");
    for (const h of this.hosts) {
      try {
        const r = await this.fetchFn(`http://${h}/api/stop`, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.ok || r.status === 202) return;
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
