import { describe, it, expect } from "vitest";
import { snapshotArgs, snapshotPath } from "../src/capture/snapshot.js";
import { loadConfig } from "../src/config.js";

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
