import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.js";
import { Device } from "./device.js";
import { registerTools } from "./tools.js";

export function buildApp(device: Device, cfg: Config): Express {
  const app = express();
  app.use(express.json());

  // Optional bearer-token gate.
  app.use("/mcp", (req: Request, res: Response, next) => {
    if (!cfg.mcpToken) return next();
    const auth = req.header("authorization") ?? "";
    if (auth === `Bearer ${cfg.mcpToken}`) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;

    if (!transport && !sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport!; },
      });
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
      const server = new McpServer({ name: "tb3-mcp", version: "0.1.0" });
      registerTools(server, device, cfg);
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session" }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionStream = async (req: Request, res: Response) => {
    const sid = req.header("mcp-session-id");
    const transport = sid ? transports[sid] : undefined;
    if (!transport) { res.status(400).send("no valid session"); return; }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", sessionStream);
  app.delete("/mcp", sessionStream);

  return app;
}

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");
  const device = new Device(cfg);
  device.start();
  const app = buildApp(device, cfg);
  app.listen(cfg.mcpPort, () => {
    console.log(`[tb3-mcp] MCP streamable HTTP on :${cfg.mcpPort}/mcp → device ${cfg.deviceHost}` +
      (cfg.mcpToken ? " (token required)" : ""));
    console.log(`[tb3-mcp] limits pan[${cfg.panMin},${cfg.panMax}] tilt[${cfg.tiltMin},${cfg.tiltMax}] maxSpeed ${cfg.maxSpeedDps}°/s`);
  });
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
