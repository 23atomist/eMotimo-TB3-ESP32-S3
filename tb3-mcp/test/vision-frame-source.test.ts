import { describe, it, expect } from "vitest";
import { MjpegPipeSource, FramePipe } from "../src/vision/frame-source.js";

function fakePipe() {
  let cb: ((j: Buffer) => void) | null = null;
  const pipe: FramePipe = { onFrame: (f) => { cb = f; }, kill: () => {} };
  return { pipe, emit: (b: Buffer) => cb?.(b) };
}

describe("MjpegPipeSource", () => {
  it("returns null before any frame arrives", () => {
    const { pipe } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1000, latencyMs: () => 200 });
    s.start();
    expect(s.latest()).toBeNull();
  });

  it("stamps exposure as arrival MINUS latency", () => {
    const { pipe, emit } = fakePipe();
    let t = 5000;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => 350 });
    s.start();
    emit(Buffer.from("abc"));
    const f = s.latest()!;
    expect(f.arrivedMs).toBe(5000);
    expect(f.exposureMs).toBe(4650);   // NOT 5000 -- the frame describes the past
  });

  it("reads latency PER FRAME so a re-measurement takes effect without a restart", () => {
    const { pipe, emit } = fakePipe();
    let t = 1000, lat = 200;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => lat });
    s.start();
    emit(Buffer.from("a"));
    expect(s.latest()!.exposureMs).toBe(800);
    lat = 900;                          // e.g. operator zoomed, latency re-measured
    t = 2000;
    emit(Buffer.from("b"));
    expect(s.latest()!.exposureMs).toBe(1100);
  });

  it("keeps only the newest frame", () => {
    const { pipe, emit } = fakePipe();
    let t = 1000;
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => t, latencyMs: () => 0 });
    s.start();
    emit(Buffer.from("old")); t = 2000; emit(Buffer.from("new"));
    expect(Buffer.from(s.latest()!.jpegBase64, "base64").toString()).toBe("new");
  });

  it("a frame buffered past stop() must NOT resurrect newest", () => {
    // ffmpeg keeps writing already-buffered stdout after kill() returns. A
    // stale closure repopulating `newest` would hand a caller who deliberately
    // stopped capture a frame from a dead pipe instead of null.
    const { pipe, emit } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1000, latencyMs: () => 0 });
    s.start();
    s.stop();
    expect(s.latest()).toBeNull();
    emit(Buffer.from("late"));
    expect(s.latest()).toBeNull();
  });

  it("base64-encodes the jpeg for the wire", () => {
    const { pipe, emit } = fakePipe();
    const s = new MjpegPipeSource({ spawnPipe: () => pipe, now: () => 1, latencyMs: () => 0 });
    s.start();
    emit(Buffer.from("hello"));
    expect(s.latest()!.jpegBase64).toBe(Buffer.from("hello").toString("base64"));
  });
});
