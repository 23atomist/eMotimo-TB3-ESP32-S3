import { describe, it, expect } from "vitest";
import { parseRecordingName, parseSnapshotName, keepFileName, parseKeepName } from "../src/recordings/names.js";

describe("parseRecordingName", () => {
  it("parses MediaMTX's %Y-%m-%d_%H-%M-%S-%f as LOCAL time", () => {
    const ms = parseRecordingName("2026-08-16_19-16-12-734710.mp4");
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);        // August
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(19);       // LOCAL hours, not UTC
    expect(d.getMinutes()).toBe(16);
    expect(d.getSeconds()).toBe(12);
  });

  it("includes the microsecond field as milliseconds", () => {
    const ms = parseRecordingName("2026-08-16_19-16-12-734710.mp4");
    expect(new Date(ms!).getMilliseconds()).toBe(734);
  });

  it("rejects anything that is not a recording name", () => {
    expect(parseRecordingName("notes.txt")).toBeNull();
    expect(parseRecordingName("2026-08-16.mp4")).toBeNull();
    expect(parseRecordingName("../../etc/passwd")).toBeNull();
  });
});

describe("parseSnapshotName", () => {
  it("parses the hex-CALLSIGN-iso form as UTC", () => {
    const got = parseSnapshotName("a082ac-AAL556-2026-08-17T02-09-37.664Z.jpg");
    expect(got).not.toBeNull();
    expect(got!.icao).toBe("a082ac");
    expect(got!.callsign).toBe("AAL556");
    expect(got!.atMs).toBe(Date.parse("2026-08-17T02:09:37.664Z"));
  });

  it("parses the hex-iso form, where no callsign was broadcast", () => {
    const got = parseSnapshotName("ab627c-2026-08-17T02-09-37.664Z.jpg");
    expect(got).not.toBeNull();
    expect(got!.icao).toBe("ab627c");
    expect(got!.callsign).toBeNull();
  });

  it("does not confuse the date's dashes with the field separators", () => {
    // The ISO segment itself contains dashes; a naive split on "-" breaks here.
    const got = parseSnapshotName("0d1139-AMX792-2026-08-16T00-41-44.768Z.jpg");
    expect(got!.icao).toBe("0d1139");
    expect(got!.callsign).toBe("AMX792");
    expect(got!.atMs).toBe(Date.parse("2026-08-16T00:41:44.768Z"));
  });

  it("rejects non-snapshot names", () => {
    expect(parseSnapshotName("manual.jpg")).toBeNull();
    expect(parseSnapshotName("2026-08-16_19-16-12-734710.mp4")).toBeNull();
  });
});

describe("local/UTC asymmetry", () => {
  it("treats identical clock text differently for the two schemes", () => {
    // Same wall-clock text; recording names are LOCAL, snapshots are UTC, so
    // these must NOT be equal unless the host runs UTC.
    const rec = parseRecordingName("2026-08-16_12-00-00-000000.mp4")!;
    const snap = parseSnapshotName("aaa111-2026-08-16T12-00-00.000Z.jpg")!.atMs;
    const offsetMs = new Date(2026, 7, 16, 12).getTimezoneOffset() * 60_000;
    expect(snap - rec).toBe(-offsetMs);
  });
});

describe("keepFileName", () => {
  it("builds a sortable, self-describing name", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, "AAL556", "a082ac")).toBe("2026-08-16T19-16-12_AAL556_a082ac.mp4");
  });

  it("omits the callsign when there is none", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, null, "a082ac")).toBe("2026-08-16T19-16-12_a082ac.mp4");
  });

  it("sanitises identity segments so they cannot escape the directory", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    expect(keepFileName(ms, "../../etc", "a/b")).toBe("2026-08-16T19-16-12_etc_ab.mp4");
  });
});

describe("parseKeepName", () => {
  it("round-trips keepFileName, recovering the ORIGINAL start time", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const got = parseKeepName(keepFileName(ms, "AAL556", "a082ac"));
    expect(got).not.toBeNull();
    expect(got!.atMs).toBe(ms);
    expect(got!.callsign).toBe("AAL556");
    expect(got!.icao).toBe("a082ac");
  });

  it("round-trips the no-callsign form", () => {
    const ms = new Date(2026, 7, 16, 19, 16, 12).getTime();
    const got = parseKeepName(keepFileName(ms, null, "a082ac"));
    expect(got!.callsign).toBeNull();
    expect(got!.icao).toBe("a082ac");
    expect(got!.atMs).toBe(ms);
  });

  it("rejects a MediaMTX name and anything else", () => {
    expect(parseKeepName("2026-08-16_19-16-12-734710.mp4")).toBeNull();
    expect(parseKeepName("whatever.mp4")).toBeNull();
  });
});
