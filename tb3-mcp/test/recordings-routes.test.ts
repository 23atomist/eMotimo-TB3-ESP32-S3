import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "node:http";
import { registerRecordingsRoutes, RecordingsDeps } from "../src/dashboard/recordings-routes.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "tb3routes-"));
  const rec = join(dir, "recordings"), keep = join(dir, "keep"), snap = join(dir, "snapshots");
  for (const d of [rec, keep, snap]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rec, "2026-08-16_19-16-12-734710.mp4"), "0123456789");
  const deps: RecordingsDeps = {
    recordingsDir: rec, keepDir: keep, snapshotsDir: snap,
    journalFile: join(dir, "passes.jsonl"),
    graceMs: 7000, retentionMs: 168 * 3_600_000, now: () => Date.now(),
  };
  const app = express();
  app.use(express.json());
  registerRecordingsRoutes(app, deps);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { deps, server, port };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers as Record<string, unknown> }));
    }).on("error", reject);
  });
}

function call(port: number, method: "POST" | "DELETE", path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request.request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("recordings routes", () => {
  it("lists the scanned recordings", async () => {
    const { server, port } = setup();
    const r = await get(port, "/api/passes");
    server.close();
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.listings).toHaveLength(1);
    expect(body.listings[0].files[0].name).toBe("2026-08-16_19-16-12-734710.mp4");
    expect(body.keepUsage).toBeDefined();
  });

  it("streams a video by its issued id", async () => {
    const { server, port } = setup();
    const list = JSON.parse((await get(port, "/api/passes")).body);
    const id = list.listings[0].files[0].id;
    const r = await get(port, `/api/recordings/${id}/video`);
    server.close();
    expect(r.status).toBe(200);
    expect(r.body).toBe("0123456789");
  });

  it("honours a range request with 206 and Content-Range", async () => {
    const { server, port } = setup();
    const list = JSON.parse((await get(port, "/api/passes")).body);
    const id = list.listings[0].files[0].id;
    const r = await get(port, `/api/recordings/${id}/video`, { Range: "bytes=2-5" });
    server.close();
    expect(r.status).toBe(206);
    expect(r.body).toBe("2345");
    expect(String(r.headers["content-range"])).toBe("bytes 2-5/10");
  });

  it("404s every traversal attempt instead of resolving a path", async () => {
    const { server, port } = setup();
    for (const bad of [
      "..%2F..%2Fetc%2Fpasswd",
      "%2Fetc%2Fpasswd",
      "2026-08-16_19-16-12-734710.mp4",   // a real basename is NOT an id
      "0000000000000000",
    ]) {
      const r = await get(port, `/api/recordings/${bad}/video`);
      expect(r.status).toBe(404);
    }
    server.close();
  });

  // unkeepRecording's own unit tests already pin its two guards (file.kept,
  // and the path-containment check). This is the ROUTE-level guard: nothing
  // else in the diff would notice if a future edit swapped deps.keepDir for
  // deps.recordingsDir in the DELETE handler -- that swap still compiles,
  // and unkeepRecording's `!file.kept` check alone can't catch it because it
  // fires before the containment check ever runs. The three tests below are
  // the safety net for that class of regression.
  it("refuses to delete a recording that was never kept, and leaves it on disk", async () => {
    const { server, port, deps } = setup();
    const list = JSON.parse((await get(port, "/api/passes")).body);
    const id = list.listings[0].files[0].id;
    const originalPath = join(deps.recordingsDir, "2026-08-16_19-16-12-734710.mp4");

    const r = await call(port, "DELETE", `/api/recordings/${id}/keep`);
    server.close();

    expect(r.status).toBe(400);
    expect(existsSync(originalPath)).toBe(true);
  });

  it("404s a DELETE on an id no scan can resolve", async () => {
    const { server, port } = setup();
    const r = await call(port, "DELETE", "/api/recordings/0000000000000000/keep");
    server.close();
    expect(r.status).toBe(404);
  });

  it("keeps then un-keeps a recording over HTTP: the keep link goes, the original survives", async () => {
    const { server, port, deps } = setup();
    const originalPath = join(deps.recordingsDir, "2026-08-16_19-16-12-734710.mp4");
    const list0 = JSON.parse((await get(port, "/api/passes")).body);
    const id = list0.listings[0].files[0].id;

    const postR = await call(port, "POST", `/api/recordings/${id}/keep`);
    expect(postR.status).toBe(200);
    const posted = JSON.parse(postR.body);
    expect(posted.kept).toBe(true);
    expect(typeof posted.path).toBe("string");
    // The kept link genuinely lives under keepDir, which is what makes the
    // DELETE below a real test of the isInsideDir(keepDir, ...) check rather
    // than a same-outcome no-op: this file's containment result would flip
    // if the route passed the wrong directory.
    expect(existsSync(posted.path)).toBe(true);

    const list1 = JSON.parse((await get(port, "/api/passes")).body);
    const keptFile = list1.listings.flatMap((l: { files: { id: string; kept: boolean }[] }) => l.files)
      .find((f: { id: string; kept: boolean }) => f.kept);
    expect(keptFile).toBeDefined();

    const delR = await call(port, "DELETE", `/api/recordings/${keptFile.id}/keep`);
    server.close();

    expect(delR.status).toBe(200);
    expect(JSON.parse(delR.body)).toEqual({ kept: false });
    expect(existsSync(posted.path)).toBe(false);   // the keep link is gone
    expect(existsSync(originalPath)).toBe(true);   // MediaMTX's original survives
  });
});
