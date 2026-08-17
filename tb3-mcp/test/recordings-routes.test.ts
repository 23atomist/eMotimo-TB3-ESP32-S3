import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "node:http";
import { registerRecordingsRoutes, RecordingsDeps } from "../src/dashboard/recordings-routes.js";
import { PassJournal, PassRecord } from "../src/capture/pass-journal.js";
import { parseRecordingName } from "../src/recordings/names.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let dir: string | null = null;
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

const FIXTURE_MP4 = "2026-08-16_19-16-12-734710.mp4";

function setup() {
  dir = mkdtempSync(join(tmpdir(), "tb3routes-"));
  const rec = join(dir, "recordings"), keep = join(dir, "keep"), snap = join(dir, "snapshots");
  for (const d of [rec, keep, snap]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rec, FIXTURE_MP4), "0123456789");
  const journalFile = join(dir, "passes.jsonl");

  // A real journal line whose pass window brackets the fixture mp4, mirroring
  // the real ordering: CaptureController.beginPass() awaits isArmed() (an
  // HTTP round trip) before setRecord(true), so a pass always starts BEFORE
  // its recording file does. Without this, PassJournal.list() returns []
  // and no pass is ever joined -- the POST/DELETE keep round trip below
  // would then pass whether or not the kept file actually reattached to its
  // pass, which is exactly the blind spot that let C1 through.
  const fileStartedAtMs = parseRecordingName(FIXTURE_MP4)!;
  const pass: PassRecord = {
    id: "pass-1", icao: "a082ac", callsign: "AAL556",
    startedAtMs: fileStartedAtMs - 300, endedAtMs: fileStartedAtMs + 2000,
    snapshotFile: null,
    category: null, squawk: null, gsKt: null, maxAltitudeM: null,
    minRangeM: null, maxElevationDeg: null,
    azStartDeg: null, azEndDeg: null, azArcDeg: null,
    meanPointingErrorDeg: null, maxPointingErrorDeg: null,
    waitingMs: 0, limitHitMs: 0, samples: 0,
  };
  new PassJournal(journalFile).append(pass);

  const deps: RecordingsDeps = {
    recordingsDir: rec, keepDir: keep, snapshotsDir: snap,
    journalFile,
    graceMs: 7000, retentionMs: 168 * 3_600_000, now: () => Date.now(),
  };
  const app = express();
  app.use(express.json());
  registerRecordingsRoutes(app, deps);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { deps, server, port, pass };
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

  it("keeps then un-keeps a recording over HTTP: the keep link goes, the original survives, and stays attached to its pass", async () => {
    const { server, port, deps, pass } = setup();
    const originalPath = join(deps.recordingsDir, "2026-08-16_19-16-12-734710.mp4");
    const list0 = JSON.parse((await get(port, "/api/passes")).body);
    // Sanity on the fixture itself: the file must already be attached to
    // pass-1 before we touch keep at all.
    const listing0 = list0.listings.find((l: { pass: { id: string } | null }) => l.pass?.id === pass.id);
    expect(listing0).toBeDefined();
    const id = listing0.files[0].id;

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

    // THE regression check for C1: the kept file must land in the SAME
    // pass's files[], not merely appear somewhere in the response. Scanning
    // all rows for `kept === true` (the old assertion) passes whether or not
    // the kept file actually reattached to pass-1 -- it would just as
    // happily find it sitting in an "unattributed" row instead.
    const list1 = JSON.parse((await get(port, "/api/passes")).body);
    const listing1 = list1.listings.find((l: { pass: { id: string } | null }) => l.pass?.id === pass.id);
    expect(listing1).toBeDefined();
    const keptFile = listing1.files.find((f: { id: string; kept: boolean }) => f.kept);
    expect(keptFile).toBeDefined();

    const delR = await call(port, "DELETE", `/api/recordings/${keptFile.id}/keep`);
    server.close();

    expect(delR.status).toBe(200);
    expect(JSON.parse(delR.body)).toEqual({ kept: false });
    expect(existsSync(posted.path)).toBe(false);   // the keep link is gone
    expect(existsSync(originalPath)).toBe(true);   // MediaMTX's original survives
  });
});

// D1: registerRecordingsRoutes must refuse to wire up at all when
// captureRecordingsDir and captureKeepDir are not genuinely distinct,
// non-nested directories -- otherwise MediaMTX's own recordings scan as
// `kept: true` and become DELETE-able through the keep routes.
describe("registerRecordingsRoutes directory disjointness guard", () => {
  function depsFor(recordingsDir: string, keepDir: string): RecordingsDeps {
    return {
      recordingsDir, keepDir, snapshotsDir: join(dir!, "snapshots"),
      journalFile: join(dir!, "passes.jsonl"),
      graceMs: 7000, retentionMs: 168 * 3_600_000, now: () => Date.now(),
    };
  }

  it("throws at startup when the two directories are identical", () => {
    dir = mkdtempSync(join(tmpdir(), "tb3routes-guard-"));
    const same = join(dir, "media");
    mkdirSync(same, { recursive: true });
    const app = express();
    expect(() => registerRecordingsRoutes(app, depsFor(same, same))).toThrow(/distinct/i);
  });

  it("throws at startup when keepDir is nested inside recordingsDir", () => {
    dir = mkdtempSync(join(tmpdir(), "tb3routes-guard-"));
    const rec = join(dir, "recordings");
    const keep = join(rec, "keep");
    mkdirSync(keep, { recursive: true });
    const app = express();
    expect(() => registerRecordingsRoutes(app, depsFor(rec, keep))).toThrow(/distinct/i);
  });

  it("throws at startup when recordingsDir is nested inside keepDir", () => {
    dir = mkdtempSync(join(tmpdir(), "tb3routes-guard-"));
    const keep = join(dir, "keep");
    const rec = join(keep, "recordings");
    mkdirSync(rec, { recursive: true });
    const app = express();
    expect(() => registerRecordingsRoutes(app, depsFor(rec, keep))).toThrow(/distinct/i);
  });

  it("does not throw for genuinely separate directories", () => {
    dir = mkdtempSync(join(tmpdir(), "tb3routes-guard-"));
    const rec = join(dir, "recordings"), keep = join(dir, "keep");
    mkdirSync(rec, { recursive: true });
    mkdirSync(keep, { recursive: true });
    const app = express();
    expect(() => registerRecordingsRoutes(app, depsFor(rec, keep))).not.toThrow();
  });

  it("rejects a keep dir that merely shares a textual prefix, not a real nesting", () => {
    // Mirrors unkeepRecording's own "keep-evil" trap: recordingsDir =
    // ".../recordings-evil" must NOT be treated as nested under keepDir =
    // ".../recordings" by a naive startsWith check.
    dir = mkdtempSync(join(tmpdir(), "tb3routes-guard-"));
    const keep = join(dir, "recordings");
    const rec = join(dir, "recordings-evil");
    mkdirSync(keep, { recursive: true });
    mkdirSync(rec, { recursive: true });
    const app = express();
    expect(() => registerRecordingsRoutes(app, depsFor(rec, keep))).not.toThrow();
  });
});
