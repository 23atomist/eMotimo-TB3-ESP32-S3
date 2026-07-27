import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { main } from "../src/dashboard/server.js";

// Route-level coverage for POST /camera/whep (see src/dashboard/server.ts).
//
// Follows test/dashboard-camera-error.test.ts's pattern: env-var-driven
// main() + a real app.listen(PORT) + real fetch() against it, then
// handle.close() in afterEach -- no supertest, no extra dependency. The only
// addition here is a throwaway node:http server standing in for MediaMTX's
// WHEP endpoint, since main() always talks to a real upstream URL.
//
// --- 2026-07-26 bring-up bug this guards against ---
// MediaMTX rejected a malformed SDP offer with HTTP 400 (a browser/client
// problem); the proxy collapsed it into a 502 and discarded MediaMTX's body,
// which sent the operator to debug MediaMTX for a fault that was actually in
// the offer. 4xx must relay as 4xx with the upstream body; only a genuine
// upstream failure (5xx, or transport/timeout) should read as 502.

const DASHBOARD_PORT = 8950;
const MCP_PORT = 8951;     // nothing listens here -- tolerated (see main())
const DEVICE_PORT = 8952;  // nothing listens here either
const MEDIAMTX_PORT = 8953;

const BASE_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

type WhepHandler = (req: IncomingMessage, res: ServerResponse) => void;

// A throwaway stand-in for MediaMTX's WHEP endpoint. Each test installs its
// own handler so the proxy can be driven through every upstream outcome
// (2xx / 4xx / 5xx / unreachable) without a real MediaMTX.
function startMediamtxStub(handler: WhepHandler): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(MEDIAMTX_PORT, "127.0.0.1", () => resolve(server));
  });
}

function stopServer(server: HttpServer | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

function postOffer(): Promise<Response> {
  return fetch(`${BASE_URL}/camera/whep`, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n",
  });
}

describe("POST /camera/whep proxy", () => {
  let handle: { close(): void } | null = null;
  let mediamtx: HttpServer | null = null;
  const touchedEnvKeys = [
    "TB3_CONFIG", "TB3_DASHBOARD_PORT", "TB3_MCP_PORT", "TB3_DEVICE_HOST",
    "TB3_CAMERA_SOURCE", "TB3_CAMERA_MEDIAMTX_HTTP_URL",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  // Mirrors dashboard-camera-error.test.ts: pure env-var overrides (empty
  // TB3_CONFIG so a dev machine's config.json can never leak in), restored
  // in afterEach.
  function setEnv(overrides: Record<string, string>): void {
    for (const k of touchedEnvKeys) savedEnv[k] = process.env[k];
    process.env.TB3_CONFIG = "";
    process.env.TB3_DASHBOARD_PORT = String(DASHBOARD_PORT);
    process.env.TB3_MCP_PORT = String(MCP_PORT);
    process.env.TB3_DEVICE_HOST = `127.0.0.1:${DEVICE_PORT}`;
    process.env.TB3_CAMERA_SOURCE = "mediamtx";
    process.env.TB3_CAMERA_MEDIAMTX_HTTP_URL = `http://127.0.0.1:${MEDIAMTX_PORT}`;
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  }

  afterEach(async () => {
    handle?.close();
    handle = null;
    await stopServer(mediamtx);
    mediamtx = null;
    for (const k of touchedEnvKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  it("relays an upstream 400 as 400, with MediaMTX's body intact (not collapsed to 502)", async () => {
    mediamtx = await startMediamtxStub((_req, res) => {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid SDP offer: missing m= line");
    });
    setEnv({});
    handle = await main();

    const res = await postOffer();

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid SDP offer: missing m= line");
  });

  it("returns 502 for an upstream 500, with the upstream status and body folded into the message", async () => {
    mediamtx = await startMediamtxStub((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal encoder failure");
    });
    setEnv({});
    handle = await main();

    const res = await postOffer();

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("500");
    expect(body).toContain("internal encoder failure");
  });

  it("returns 502 when MediaMTX is unreachable (transport failure)", async () => {
    // No stub server started -- nothing listens on MEDIAMTX_PORT, so the
    // proxy's fetch() throws and hits the catch branch.
    setEnv({});
    handle = await main();

    const res = await postOffer();

    expect(res.status).toBe(502);
  });

  it("on success, relays 201, the SDP answer body, and the Location header", async () => {
    mediamtx = await startMediamtxStub((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/sdp", "Location": "/tb3/whep/abc123" });
      res.end("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n");
    });
    setEnv({});
    handle = await main();

    const res = await postOffer();

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n");
    expect(res.headers.get("location")).toBe("/tb3/whep/abc123");
  });

  it("returns 404 when cameraSource is not mediamtx", async () => {
    setEnv({ TB3_CAMERA_SOURCE: "mtplvcap" });
    handle = await main();

    const res = await postOffer();

    expect(res.status).toBe(404);
  });
});
