import { describe, it, expect } from "vitest";
import { computeVideoStats, formatBandwidth, formatVideoStats } from "../dashboard/public/video-stats.js";

// -- computeVideoStats -------------------------------------------------------
//
// framesDecoded/bytesReceived from RTCPeerConnection.getStats() are
// CUMULATIVE totals; a rate only exists as the diff between two samples over
// their timestamp delta. Every case here exists because a wrong-but-
// plausible-looking number is worse than none: it would make the "receiving
// but not decoding" bug (the reason this readout exists at all) invisible
// again, just with different cosmetics.

describe("computeVideoStats", () => {
  it("computes fps and bitrate from two normal samples one second apart", () => {
    const prev = { timestamp: 1000, bytesReceived: 100_000, framesDecoded: 30, frameWidth: 1920, frameHeight: 1080 };
    const curr = { timestamp: 2000, bytesReceived: 150_000, framesDecoded: 60, frameWidth: 1920, frameHeight: 1080 };
    expect(computeVideoStats(prev, curr)).toEqual({
      fps: 30,
      bitrate: 400_000, // (150000-100000) bytes * 8 bits / 1s
      width: 1920,
      height: 1080,
    });
  });

  // The whole reason this component exists: bytes are flowing (bitrate > 0)
  // but framesDecoded hasn't moved at all (fps === 0). This must be exactly
  // representable -- not clamped, not treated as an error, not merged with
  // either the healthy or the fully-dead case.
  it("reports nonzero bandwidth with exactly zero fps when bytes flow but no frames decode", () => {
    const prev = { timestamp: 1000, bytesReceived: 100_000, framesDecoded: 30, frameWidth: 1920, frameHeight: 1080 };
    const curr = { timestamp: 2000, bytesReceived: 150_000, framesDecoded: 30, frameWidth: 1920, frameHeight: 1080 };
    const result = computeVideoStats(prev, curr);
    expect(result.fps).toBe(0);
    expect(result.bitrate).toBeGreaterThan(0);
    expect(result.bitrate).toBe(400_000);
  });

  it("a first sample with no predecessor reports zero rates, not NaN/Infinity, but still reports resolution", () => {
    const curr = { timestamp: 1000, bytesReceived: 500_000, framesDecoded: 120, frameWidth: 1280, frameHeight: 720 };
    const result = computeVideoStats(null, curr);
    expect(result.fps).toBe(0);
    expect(result.bitrate).toBe(0);
    expect(Number.isFinite(result.fps)).toBe(true);
    expect(Number.isFinite(result.bitrate)).toBe(true);
    // Resolution is a direct read, not a rate -- it's known even with no
    // predecessor to diff against.
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
  });

  it("a zero timestamp delta yields zero rates without dividing by zero", () => {
    const prev = { timestamp: 5000, bytesReceived: 100_000, framesDecoded: 30, frameWidth: 1920, frameHeight: 1080 };
    const curr = { timestamp: 5000, bytesReceived: 150_000, framesDecoded: 45, frameWidth: 1920, frameHeight: 1080 };
    const result = computeVideoStats(prev, curr);
    expect(result.fps).toBe(0);
    expect(result.bitrate).toBe(0);
    expect(Number.isFinite(result.fps)).toBe(true);
    expect(Number.isFinite(result.bitrate)).toBe(true);
  });

  it("a negative timestamp delta (clock quirk / out-of-order sample) yields zero rates, not a negative one", () => {
    const prev = { timestamp: 5000, bytesReceived: 100_000, framesDecoded: 30, frameWidth: 1920, frameHeight: 1080 };
    const curr = { timestamp: 4500, bytesReceived: 150_000, framesDecoded: 45, frameWidth: 1920, frameHeight: 1080 };
    const result = computeVideoStats(prev, curr);
    expect(result.fps).toBe(0);
    expect(result.bitrate).toBe(0);
  });

  // A WHEP reconnect creates a brand-new RTCPeerConnection whose cumulative
  // counters restart near zero. If the caller ever diffs that first
  // post-reconnect sample against the OLD connection's last known totals
  // (rather than resetting prev to null), the deltas go negative -- this
  // must not surface as a negative fps/bitrate.
  it("counters that go backwards (reconnect) yield zero rates, never negative ones", () => {
    const prev = { timestamp: 9000, bytesReceived: 9_000_000, framesDecoded: 3000, frameWidth: 1920, frameHeight: 1080 };
    const curr = { timestamp: 10_000, bytesReceived: 5_000, framesDecoded: 10, frameWidth: 1920, frameHeight: 1080 };
    const result = computeVideoStats(prev, curr);
    expect(result.fps).toBe(0);
    expect(result.bitrate).toBe(0);
    expect(result.fps).toBeGreaterThanOrEqual(0);
    expect(result.bitrate).toBeGreaterThanOrEqual(0);
  });

  it("a curr sample with no resolution yet (before the decoder has produced a frame) reports 0x0, not NaN", () => {
    const curr = { timestamp: 1000, bytesReceived: 0, framesDecoded: 0, frameWidth: undefined, frameHeight: undefined };
    const result = computeVideoStats(null, curr);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

// -- formatBandwidth ----------------------------------------------------------

describe("formatBandwidth", () => {
  it("formats zero/negative bandwidth as 0 kbps", () => {
    expect(formatBandwidth(0)).toBe("0 kbps");
    expect(formatBandwidth(-100)).toBe("0 kbps");
  });

  it("formats sub-Mbps bandwidth in kbps", () => {
    expect(formatBandwidth(400_000)).toBe("400 kbps");
    expect(formatBandwidth(999_000)).toBe("999 kbps");
  });

  it("formats Mbps-scale bandwidth with one decimal", () => {
    expect(formatBandwidth(1_200_000)).toBe("1.2 Mbps");
    expect(formatBandwidth(4_000_000)).toBe("4.0 Mbps");
  });
});

// -- formatVideoStats ----------------------------------------------------------
//
// The property the whole feature is graded on: the three states below must
// be visually distinguishable (three different `cls` values). If any two of
// these ever collapse onto the same class, the readout has failed at the one
// thing it exists to do.

describe("formatVideoStats", () => {
  it("healthy: receiving and decoding -> video-stats-ok", () => {
    const result = formatVideoStats({ fps: 30, bitrate: 4_000_000, width: 1920, height: 1080 });
    expect(result.cls).toBe("video-stats-ok");
    expect(result.text).toBe("30 fps · 4.0 Mbps · 1920x1080");
  });

  it("receiving but not decoding (the bug this exists to catch) -> video-stats-stall", () => {
    const result = formatVideoStats({ fps: 0, bitrate: 4_000_000, width: 1920, height: 1080 });
    expect(result.cls).toBe("video-stats-stall");
    expect(result.text).toContain("0 fps");
    expect(result.text).toContain("4.0 Mbps");
  });

  it("not receiving -> video-stats-down", () => {
    const result = formatVideoStats({ fps: 0, bitrate: 0, width: 0, height: 0 });
    expect(result.cls).toBe("video-stats-down");
  });

  it("all three states render distinct classes -- the middle row must never match a neighbour", () => {
    const healthy = formatVideoStats({ fps: 30, bitrate: 4_000_000, width: 1920, height: 1080 });
    const stalled = formatVideoStats({ fps: 0, bitrate: 4_000_000, width: 1920, height: 1080 });
    const down = formatVideoStats({ fps: 0, bitrate: 0, width: 0, height: 0 });
    expect(new Set([healthy.cls, stalled.cls, down.cls]).size).toBe(3);
  });

  it("omits the resolution segment when width/height are unknown", () => {
    const result = formatVideoStats({ fps: 0, bitrate: 0, width: 0, height: 0 });
    expect(result.text).toBe("0 fps · 0 kbps");
  });

  it("treats a null/undefined stats object as the down state rather than throwing", () => {
    expect(formatVideoStats(null).cls).toBe("video-stats-down");
    expect(formatVideoStats(undefined).cls).toBe("video-stats-down");
  });
});
