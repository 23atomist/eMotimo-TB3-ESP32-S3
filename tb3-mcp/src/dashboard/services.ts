import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceState, parseServiceState } from "./parse.js";
import { ServicesState } from "./state.js";

const pexec = promisify(execFile);

export interface Systemctl {
  isActive(unit: string): Promise<ServiceState>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
}

export class RealSystemctl implements Systemctl {
  // `systemctl is-active` exits non-zero for inactive/failed but still prints the
  // state on stdout — so read stdout regardless of exit code.
  async isActive(unit: string): Promise<ServiceState> {
    try {
      const { stdout } = await pexec("systemctl", ["is-active", unit], { timeout: 5000 });
      return parseServiceState(stdout);
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return typeof out === "string" ? parseServiceState(out) : "unknown";
    }
  }
  async start(unit: string): Promise<void> { await pexec("systemctl", ["start", unit], { timeout: 5000 }); }
  async stop(unit: string): Promise<void> { await pexec("systemctl", ["stop", unit], { timeout: 5000 }); }
}

const UNITS: Record<keyof ServicesState, string> = {
  readsb: "readsb", tb3mcp: "tb3-mcp", tb3agent: "tb3-agent", llama: "llama-server",
};

export async function readServices(sc: Systemctl): Promise<ServicesState> {
  const entries = await Promise.all(
    (Object.keys(UNITS) as (keyof ServicesState)[]).map(async (key) => {
      try { return [key, await sc.isActive(UNITS[key])] as const; }
      catch { return [key, "unknown" as ServiceState] as const; }
    }),
  );
  return Object.fromEntries(entries) as unknown as ServicesState;
}
