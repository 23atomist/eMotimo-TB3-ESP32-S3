import { describe, it, expect } from "vitest";
import { joinRecordings, RecordingFile } from "../src/recordings/join.js";
import { PassRecord } from "../src/capture/pass-journal.js";

const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

function pass(over: Partial<PassRecord> = {}): PassRecord {
  return {
    id: "p1", icao: "a082ac", callsign: "AAL556",
    startedAtMs: T, endedAtMs: T + 2 * MIN, snapshotFile: null,
    category: null, squawk: null, gsKt: null, maxAltitudeM: null,
    minRangeM: null, maxElevationDeg: null,
    azStartDeg: null, azEndDeg: null, azArcDeg: null,
    meanPointingErrorDeg: null, maxPointingErrorDeg: null,
    waitingMs: 0, limitHitMs: 0, samples: 0,
    ...over,
  };
}

function file(over: Partial<RecordingFile> = {}): RecordingFile {
  return {
    id: "f1", path: "/rec/a.mp4", name: "a.mp4",
    startedAtMs: T + 1000, endedAtMs: T + 2 * MIN, sizeBytes: 1000, kept: false,
    ...over,
  };
}

const opts = { graceMs: 7000, retentionMs: 168 * HOUR, nowMs: T + 10 * MIN };

describe("joinRecordings", () => {
  it("attaches a file that starts inside the pass window", () => {
    const out = joinRecordings([pass()], [file()], opts);
    expect(out).toHaveLength(1);
    expect(out[0].videoState).toBe("present");
    expect(out[0].files.map((f) => f.id)).toEqual(["f1"]);
    expect(out[0].pass!.id).toBe("p1");
  });

  it("attaches a file starting just inside the grace window after the pass ends", () => {
    const out = joinRecordings([pass()], [file({ startedAtMs: T + 2 * MIN + 6000 })], opts);
    expect(out[0].videoState).toBe("present");
  });

  it("does not attach a file starting beyond the grace window", () => {
    const out = joinRecordings([pass()], [file({ startedAtMs: T + 2 * MIN + 9000 })], opts);
    // The orphaned file starts LATER than the pass, so under the global
    // newest-first sort it can legitimately sort ahead of the pass -- select
    // the pass explicitly rather than assume it lands at out[0]. What this
    // test actually pins is "the file is not attached", not row order.
    const passListing = out.find((l) => l.pass?.id === "p1")!;
    expect(passListing.videoState).toBe("not-recorded");
    expect(out.find((l) => l.pass === null)!.files).toHaveLength(1);
  });

  it("marks a recent pass with no file as not-recorded", () => {
    const out = joinRecordings([pass()], [], opts);
    expect(out[0].videoState).toBe("not-recorded");
    expect(out[0].files).toEqual([]);
  });

  it("marks a pass older than the retention window as expired", () => {
    const old = pass({ startedAtMs: T - 200 * HOUR, endedAtMs: T - 200 * HOUR + MIN });
    const out = joinRecordings([old], [], opts);
    expect(out[0].videoState).toBe("expired");
  });

  it("attaches every file of a pass that rolled over a segment boundary", () => {
    const long = pass({ startedAtMs: T, endedAtMs: T + 90 * MIN });
    const files = [
      file({ id: "f1", startedAtMs: T + 1000 }),
      file({ id: "f2", startedAtMs: T + 60 * MIN }),
    ];
    const out = joinRecordings([long], files, opts);
    expect(out[0].files.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("reports a file matching no pass as unattributed", () => {
    const out = joinRecordings([], [file()], opts);
    expect(out).toHaveLength(1);
    expect(out[0].pass).toBeNull();
    expect(out[0].source).toBeNull();
    expect(out[0].videoState).toBe("present");
  });

  it("gives a file to the pass it started inside when windows overlap", () => {
    const a = pass({ id: "pa", startedAtMs: T, endedAtMs: T + 2 * MIN });
    const b = pass({ id: "pb", startedAtMs: T + MIN, endedAtMs: T + 3 * MIN });
    const out = joinRecordings([a, b], [file({ startedAtMs: T + 90_000 })], opts);
    const withFile = out.filter((l) => l.files.length > 0);
    expect(withFile).toHaveLength(1);
    expect(withFile[0].pass!.id).toBe("pb");   // the LATEST pass it fits
  });

  it("sorts newest first", () => {
    const a = pass({ id: "pa", startedAtMs: T });
    const b = pass({ id: "pb", startedAtMs: T + 5 * MIN, endedAtMs: T + 6 * MIN });
    const out = joinRecordings([a, b], [], opts);
    expect(out.map((l) => l.pass!.id)).toEqual(["pb", "pa"]);
  });
});
