import { describe, it, expect, vi, afterEach } from "vitest";
import { MediaMtxClient, parsePathInfo } from "../src/mediamtx/client.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("parsePathInfo", () => {
  it("reads name, ready and reader count", () => {
    expect(parsePathInfo({ name: "tb3", ready: true, readers: [{}, {}] }))
      .toEqual({ name: "tb3", ready: true, readers: 2 });
  });

  it("treats a missing readers array as zero", () => {
    expect(parsePathInfo({ name: "tb3", ready: false })).toEqual({ name: "tb3", ready: false, readers: 0 });
  });

  it("returns null for junk", () => {
    expect(parsePathInfo(null)).toBeNull();
    expect(parsePathInfo({ nope: 1 })).toBeNull();
  });
});

describe("MediaMtxClient", () => {
  const mk = () => new MediaMtxClient({ controlUrl: "http://127.0.0.1:9997", path: "tb3", timeoutMs: 500 });

  it("returns parsed path info on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ name: "tb3", ready: true, readers: [{}] }), { status: 200 })));
    expect(await mk().pathInfo()).toEqual({ name: "tb3", ready: true, readers: 1 });
  });

  it("returns null and records the error on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const c = mk();
    expect(await c.pathInfo()).toBeNull();
    expect(c.lastError()).toContain("404");
  });

  it("returns null and records the error when the socket is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const c = mk();
    expect(await c.pathInfo()).toBeNull();
    expect(c.lastError()).toContain("ECONNREFUSED");
  });

  it("setRecord PATCHes the record flag", async () => {
    const f = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mk().setRecord(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v3/config/paths/patch/tb3");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ record: true });
  });

  it("setRecord rejects on failure so callers can surface it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(mk().setRecord(false)).rejects.toThrow(/500/);
  });
});
