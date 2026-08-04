import { describe, it, expect, vi } from "vitest";
import { snapshotArgs, snapshotExecOptions, snapshotPath } from "../src/capture/snapshot.js";
import { loadConfig } from "../src/config.js";
import { TuningStore } from "../src/tuning-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Records every execFile call's options so takeSnapshot's END-TO-END wiring
// (not just the pure snapshotExecOptions helper above) can be proven to read
// captureTimeoutMs live. A resolveTuning/snapshotExecOptions unit test alone
// would not catch a takeSnapshot that forgot to forward its tuningStore
// argument through.
const execFileCalls: { options: { timeout?: number } }[] = [];
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string, _args: string[], options: { timeout?: number }, cb: (err: null, r: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push({ options });
    cb(null, { stdout: "", stderr: "" });
  },
}));

const cfg = (over: Record<string, string> = {}) =>
  loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx", ...over });

describe("snapshotPath", () => {
  it("names files <hex>-<iso>.jpg with colons stripped when there is no callsign", () => {
    expect(snapshotPath("/var/lib/tb3/snapshots", "ABC123", null, "2026-07-26T18:04:05.000Z"))
      .toBe("/var/lib/tb3/snapshots/ABC123-2026-07-26T18-04-05.000Z.jpg");
  });

  it("strips unsafe characters from the hex", () => {
    expect(snapshotPath("/s", "../etc/passwd", null, "2026-07-26T00:00:00.000Z"))
      .toBe("/s/etcpasswd-2026-07-26T00-00-00.000Z.jpg");
  });

  it("includes both hex and callsign when a callsign is present", () => {
    expect(snapshotPath("/s", "A1B2C3", "UAL123", "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-UAL123-2026-07-26T18-04-05.000Z.jpg");
  });

  it("omits the callsign segment when it is null", () => {
    expect(snapshotPath("/s", "A1B2C3", null, "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-2026-07-26T18-04-05.000Z.jpg");
  });

  it("omits the callsign segment when it is blank", () => {
    expect(snapshotPath("/s", "A1B2C3", "   ", "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-2026-07-26T18-04-05.000Z.jpg");
  });

  it("omits the callsign segment when it equals the hex (no callsign was ever broadcast)", () => {
    // Mirrors AdsbFollower's `ac.callsign ?? ac.hex` fallback: when no
    // callsign exists, the label passed around IS the hex. Must not
    // produce a redundant A1B2C3-A1B2C3-... filename.
    expect(snapshotPath("/s", "A1B2C3", "A1B2C3", "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-2026-07-26T18-04-05.000Z.jpg");
  });

  it("omits the callsign segment when it equals the hex case-insensitively", () => {
    expect(snapshotPath("/s", "A1B2C3", "a1b2c3", "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-2026-07-26T18-04-05.000Z.jpg");
  });

  it("sanitizes unsafe characters out of the callsign too", () => {
    expect(snapshotPath("/s", "A1B2C3", "../UAL 123!", "2026-07-26T18:04:05.000Z"))
      .toBe("/s/A1B2C3-UAL123-2026-07-26T18-04-05.000Z.jpg");
  });
});

describe("snapshotArgs", () => {
  it("pulls ONE frame from the RTSP stream, not the v4l2 device", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a).toContain("rtsp://127.0.0.1:8554/tb3");
    // A second /dev/video consumer would contend with the publisher for the
    // camera, which is exactly what has wedged this hardware before.
    expect(a.join(" ")).not.toContain("/dev/video");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("uses TCP transport and overwrites the target", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a).toContain("-rtsp_transport");
    expect(a).toContain("tcp");
    expect(a).toContain("-y");
    expect(a[a.length - 1]).toBe("/tmp/x.jpg");
  });

  it("puts -rtsp_transport BEFORE -i or ffmpeg ignores it", () => {
    const a = snapshotArgs(cfg(), "/tmp/x.jpg");
    expect(a.indexOf("-rtsp_transport")).toBeLessThan(a.indexOf("-i"));
  });
});

describe("snapshotExecOptions", () => {
  it("falls through to cfg.captureTimeoutMs when nothing is tuned", () => {
    const tuning = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-snap-")), "tuning.json"));
    tuning.load();
    expect(snapshotExecOptions(tuning, cfg())).toEqual({ timeout: 4000, killSignal: "SIGKILL" });
  });

  it("a tuning change is read on the VERY NEXT call — no takeSnapshot caller is reconstructed", () => {
    // Mirrors how takeSnapshot() actually calls this: cfg and the TuningStore
    // instance are both held once (in server.ts, across the life of the
    // process) and re-resolved on every capture, not captured into a field
    // at startup.
    const tuning = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-snap-")), "tuning.json"));
    tuning.load();
    const c = cfg();
    expect(snapshotExecOptions(tuning, c).timeout).toBe(4000);

    tuning.set({ captureTimeoutMs: 9000 });
    expect(snapshotExecOptions(tuning, c).timeout).toBe(9000);

    tuning.clear("captureTimeoutMs");
    expect(snapshotExecOptions(tuning, c).timeout).toBe(4000);
  });

  it("tolerates an absent store (tuning not wired) and returns cfg's value", () => {
    expect(snapshotExecOptions(undefined, cfg()).timeout).toBe(4000);
  });

  it("always kills with SIGKILL — a wedged ffmpeg must never outlive the tracking tick that triggered it", () => {
    const tuning = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-snap-")), "tuning.json"));
    tuning.load();
    expect(snapshotExecOptions(tuning, cfg()).killSignal).toBe("SIGKILL");
  });
});

describe("takeSnapshot — the actual capture-timeout call site", () => {
  it("forwards a live tuning change into the ffmpeg subprocess's timeout, same `cfg`/tuningStore instances both calls", async () => {
    const { takeSnapshot } = await import("../src/capture/snapshot.js");
    const tuning = new TuningStore(join(mkdtempSync(join(tmpdir(), "tb3-snap-")), "tuning.json"));
    tuning.load();
    const c = cfg();
    execFileCalls.length = 0;

    await takeSnapshot(c, "a1b2c3", null, "2026-08-04T00:00:00.000Z", tuning);
    expect(execFileCalls[0].options.timeout).toBe(4000); // cfg's captureTimeoutMs default

    tuning.set({ captureTimeoutMs: 15000 });
    await takeSnapshot(c, "a1b2c3", null, "2026-08-04T00:00:01.000Z", tuning);
    expect(execFileCalls[1].options.timeout).toBe(15000); // no takeSnapshot caller rebuilt
  });
});
