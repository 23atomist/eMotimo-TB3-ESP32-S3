import { describe, it, expect, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { DetectorClient } from "../src/vision/detector-client.js";

let server: Server | null = null;
function serve(handler: (body: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const r = handler(raw);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${a.port}/detect`);
    });
  });
}
afterEach(() => { server?.close(); server = null; });

describe("DetectorClient", () => {
  it("parses a well-formed response", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({
      detections: [{ dxPx: 112, dyPx: -38.5, conf: 0.87 }], widthPx: 1920, heightPx: 1080, inferMs: 3.1,
    })}));
    const r = await new DetectorClient(url, 2000).detect("Zm9v", 0.25);
    expect(r?.detections).toEqual([{ dxPx: 112, dyPx: -38.5, conf: 0.87 }]);
    expect(r?.widthPx).toBe(1920);
  });

  it("sends the image and threshold in the documented shape", async () => {
    let seen = "";
    const url = await serve((body) => { seen = body; return { status: 200, body: JSON.stringify({
      detections: [], widthPx: 1920, heightPx: 1080, inferMs: 1,
    })}; });
    await new DetectorClient(url, 2000).detect("Zm9v", 0.4);
    expect(JSON.parse(seen)).toEqual({ image_b64: "Zm9v", min_conf: 0.4 });
  });

  it("returns null on a non-200 rather than throwing", async () => {
    const url = await serve(() => ({ status: 500, body: "boom" }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on a malformed body rather than throwing", async () => {
    const url = await serve(() => ({ status: 200, body: "{not json" }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on a body that parses but fails the schema", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ detections: "nope" }) }));
    await expect(new DetectorClient(url, 2000).detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null when the detector is unreachable", async () => {
    const c = new DetectorClient("http://127.0.0.1:1/detect", 500);
    await expect(c.detect("Zm9v", 0.25)).resolves.toBeNull();
  });

  it("returns null on timeout rather than hanging the loop", async () => {
    const url = await new Promise<string>((resolve) => {
      server = createServer(() => { /* never responds */ });
      server.listen(0, "127.0.0.1", () => {
        const a = server!.address() as { port: number };
        resolve(`http://127.0.0.1:${a.port}/detect`);
      });
    });
    await expect(new DetectorClient(url, 300).detect("Zm9v", 0.25)).resolves.toBeNull();
  });
});
