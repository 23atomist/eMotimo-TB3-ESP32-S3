import { describe, it, expect, vi } from "vitest";
import { whepUrl, sdpLooksValid, attachTrack, extractVideoSample, WhepSession } from "../dashboard/public/whep.js";

describe("whepUrl", () => {
  it("appends the whep path to a bare base", () => {
    expect(whepUrl("")).toBe("/camera/whep");
  });
  it("preserves an auth token query so the gate still applies", () => {
    expect(whepUrl("?token=abc")).toBe("/camera/whep?token=abc");
  });
});

describe("sdpLooksValid", () => {
  it("accepts an SDP answer", () => {
    expect(sdpLooksValid("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n")).toBe(true);
  });
  it("rejects empty or non-SDP bodies", () => {
    expect(sdpLooksValid("")).toBe(false);
    expect(sdpLooksValid("WHEP proxy failed")).toBe(false);
  });
});

// -- attachTrack ------------------------------------------------------------
//
// This is where both known "negotiation succeeded, picture still black"
// failure modes live: (1) MediaMTX's SDP answer may leave a track event with
// no associated MediaStream, and (2) Safari can refuse to autoplay a
// MediaStream assigned to a <video> that was `hidden` at the moment
// `srcObject` was set, `autoplay` attribute notwithstanding. Exercised here
// with a fake <video> and a fake RTCTrackEvent -- no real WebRTC required.

// vitest runs under plain Node, which has no MediaStream constructor; stub a
// minimal one so the ev.streams-absent fallback path can be exercised and
// asserted on.
class FakeMediaStream {
  tracks: unknown[];
  constructor(tracks: unknown[]) { this.tracks = tracks; }
}
(globalThis as unknown as { MediaStream: typeof FakeMediaStream }).MediaStream = FakeMediaStream;

function fakeVideoEl(play: () => Promise<void>) {
  let srcObject: unknown = null;
  return {
    get srcObject() { return srcObject; },
    set srcObject(v: unknown) { srcObject = v; },
    play: vi.fn(play),
  };
}

describe("attachTrack", () => {
  it("assigns ev.streams[0] to srcObject when present", async () => {
    const video = fakeVideoEl(() => Promise.resolve());
    const stream = { id: "real-stream" };
    const result = await attachTrack(video, { streams: [stream], track: {} });
    expect(video.srcObject).toBe(stream);
    expect(result).toEqual({ ok: true });
  });

  it("falls back to a MediaStream built from ev.track when ev.streams is empty", async () => {
    const video = fakeVideoEl(() => Promise.resolve());
    const track = { id: "bare-track" };
    await attachTrack(video, { streams: [], track });
    expect(video.srcObject).toBeInstanceOf(FakeMediaStream);
    expect((video.srcObject as FakeMediaStream).tracks).toEqual([track]);
  });

  it("falls back to a MediaStream built from ev.track when ev.streams is absent entirely", async () => {
    const video = fakeVideoEl(() => Promise.resolve());
    const track = { id: "bare-track-2" };
    await attachTrack(video, { track });
    expect(video.srcObject).toBeInstanceOf(FakeMediaStream);
    expect((video.srcObject as FakeMediaStream).tracks).toEqual([track]);
  });

  it("calls play() and resolves { ok: true } when playback succeeds", async () => {
    const video = fakeVideoEl(() => Promise.resolve());
    const result = await attachTrack(video, { streams: [{}], track: {} });
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("does not throw, and resolves { ok: false, error } when play() rejects (autoplay block)", async () => {
    const playError = new Error("NotAllowedError: play() failed because the user didn't interact");
    const video = fakeVideoEl(() => Promise.reject(playError));
    await expect(attachTrack(video, { streams: [{}], track: {} })).resolves.toEqual({
      ok: false,
      error: playError,
    });
  });

  it("a rejected play() never produces an unhandled promise rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const video = fakeVideoEl(() => Promise.reject(new Error("blocked")));
      void attachTrack(video, { streams: [{}], track: {} }); // deliberately not awaited
      // Give the microtask queue -- and the macrotask turn where Node
      // actually reports unhandled rejections -- a chance to run.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

// -- extractVideoSample -------------------------------------------------------
//
// RTCStatsReport is Map-like (iterable via .values()) but not itself a real
// Map -- stub it with a plain Map of report objects, which is all this
// function actually depends on.

describe("extractVideoSample", () => {
  it("returns null for a null/undefined report", () => {
    expect(extractVideoSample(null)).toBeNull();
    expect(extractVideoSample(undefined)).toBeNull();
  });

  it("returns null when no inbound-rtp/video entry is present", () => {
    const report = new Map([
      ["cand1", { type: "candidate-pair", state: "succeeded" }],
      ["out1", { type: "outbound-rtp", kind: "video", bytesSent: 100 }],
    ]);
    expect(extractVideoSample(report)).toBeNull();
  });

  it("extracts timestamp/bytesReceived/framesDecoded/frameWidth/frameHeight from the matching report", () => {
    const report = new Map([
      ["audio-in", { type: "inbound-rtp", kind: "audio", bytesReceived: 999 }],
      [
        "video-in",
        {
          type: "inbound-rtp",
          kind: "video",
          timestamp: 12345.6,
          bytesReceived: 500_000,
          framesDecoded: 150,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ],
    ]);
    expect(extractVideoSample(report)).toEqual({
      timestamp: 12345.6,
      bytesReceived: 500_000,
      framesDecoded: 150,
      frameWidth: 1920,
      frameHeight: 1080,
    });
  });

  it("defaults missing numeric fields to 0 rather than undefined", () => {
    const report = new Map([["video-in", { type: "inbound-rtp", kind: "video", timestamp: 1 }]]);
    expect(extractVideoSample(report)).toEqual({
      timestamp: 1,
      bytesReceived: 0,
      framesDecoded: 0,
      frameWidth: 0,
      frameHeight: 0,
    });
  });
});

// -- WhepSession.stats() -------------------------------------------------------
//
// A thin wrapper around pc.getStats() + extractVideoSample(); faked here with
// a stub pc so it's covered without a real RTCPeerConnection.

describe("WhepSession.stats", () => {
  it("returns null when there is no live peer connection", async () => {
    const session = new WhepSession();
    expect(await session.stats()).toBeNull();
  });

  it("delegates to pc.getStats() + extractVideoSample when a pc is present", async () => {
    const session = new WhepSession();
    const report = new Map([
      ["video-in", { type: "inbound-rtp", kind: "video", timestamp: 42, bytesReceived: 10, framesDecoded: 2, frameWidth: 640, frameHeight: 480 }],
    ]);
    (session as unknown as { pc: { getStats: () => Promise<Map<string, unknown>> } }).pc = {
      getStats: () => Promise.resolve(report),
    };
    expect(await session.stats()).toEqual({
      timestamp: 42,
      bytesReceived: 10,
      framesDecoded: 2,
      frameWidth: 640,
      frameHeight: 480,
    });
  });
});
