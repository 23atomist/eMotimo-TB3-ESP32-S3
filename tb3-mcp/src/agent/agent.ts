import { loadConfig } from "../config.js";
import { realScheduler } from "../track/session.js";
import { McpRigClient } from "./mcp-client.js";
import { chooseTarget } from "./llm.js";
import { runOnce, type LoopState } from "./loop.js";

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");
  const client = new McpRigClient(cfg.agentMcpUrl, cfg.mcpToken);
  await client.connect();
  console.log(`[tb3-agent] connected to ${cfg.agentMcpUrl}; LLM ${cfg.llmUrl} (${cfg.llmModel})`);

  let state: LoopState = { lastSwitchMs: 0 };
  let running = false;
  const tickMs = Math.max(1000, Math.round(cfg.agentTickSec * 1000));
  realScheduler.every(tickMs, () => {
    if (running) return;   // never overlap a tick
    running = true;
    void runOnce({
      client,
      choose: (input) => chooseTarget(cfg.llmUrl, cfg.llmModel, input),
      cfg: { maxRangeKm: cfg.adsbMaxRangeKm, minDwellMs: cfg.agentMinDwellSec * 1000 },
      now: Date.now,
    }, state)
      .then((r) => { state = r.state; if (r.action.kind !== "keep") console.log(`[tb3-agent] ${JSON.stringify(r.action)}`); })
      .catch((e: unknown) => console.error("[tb3-agent] tick error:", e))
      .finally(() => { running = false; });
  });
  console.log(`[tb3-agent] deciding every ${cfg.agentTickSec}s (min-dwell ${cfg.agentMinDwellSec}s)`);
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
