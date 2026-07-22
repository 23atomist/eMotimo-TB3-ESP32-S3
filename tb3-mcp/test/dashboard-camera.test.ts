import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ServerResponse } from "node:http";
import { CameraStreamer, JpegFrameParser, type Spawner } from "../src/dashboard/camera.js";

// A fake Spawner that records lifecycle calls and hands back the onFrame/onExit
// callbacks CameraStreamer registered, so a test can drive them directly
// without a real mtplvcap subprocess.
function fakeSpawnerFactory(): {
  makeSpawner: () => Spawner;
  starts: number;
  kills: number;
  lastOnFrame: ((jpeg: Buffer) => void) | null;
  lastOnExit: ((code: number | null) => void) | null;
} {
  const state = {
    starts: 0,
    kills: 0,
    lastOnFrame: null as ((jpeg: Buffer) => void) | null,
    lastOnExit: null as ((code: number | null) => void) | null,
  };
  const makeSpawner = (): Spawner => ({
    start(onFrame, onExit) {
      state.starts += 1;
      state.lastOnFrame = onFrame;
      state.lastOnExit = onExit;
      return { kill: () => { state.kills += 1; } };
    },
  });
  return { makeSpawner, get starts() { return state.starts; }, get kills() { return state.kills; },
    get lastOnFrame() { return state.lastOnFrame; }, get lastOnExit() { return state.lastOnExit; } };
}

// A recording fake ServerResponse: write()/writeHead()/end() are vi.fn()s, and
// on("close", cb) captures the close callback so a test can simulate a viewer
// disconnecting by invoking it directly.
function fakeRes(): { res: ServerResponse; triggerClose: () => void; writtenBuffers: Buffer[] } {
  const closeHandlers: (() => void)[] = [];
  const writtenBuffers: Buffer[] = [];
  const res = {
    write: vi.fn((chunk: unknown) => {
      writtenBuffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }),
    writeHead: vi.fn(),
    end: vi.fn(),
    on(evt: string, cb: () => void) {
      if (evt === "close") closeHandlers.push(cb);
      return res;
    },
  } as unknown as ServerResponse;
  return { res, writtenBuffers, triggerClose: () => { for (const cb of closeHandlers) cb(); } };
}

describe("CameraStreamer refcount lifecycle", () => {
  it("does not start a spawner until the first attach", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    expect(f.starts).toBe(0);
    expect(cam.viewerCount()).toBe(0);

    const { res } = fakeRes();
    cam.attach(res);
    expect(f.starts).toBe(1);
    expect(cam.viewerCount()).toBe(1);
  });

  it("starts the spawner exactly once for N viewers, not per-viewer", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    const b = fakeRes();
    const c = fakeRes();
    cam.attach(a.res);
    cam.attach(b.res);
    cam.attach(c.res);

    expect(f.starts).toBe(1);
    expect(cam.viewerCount()).toBe(3);
  });

  it("stops the spawner (kill) only when the last viewer detaches", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    const b = fakeRes();
    cam.attach(a.res);
    cam.attach(b.res);
    expect(cam.viewerCount()).toBe(2);

    a.triggerClose();
    expect(f.kills).toBe(0);          // one viewer remains -> pipeline stays up
    expect(cam.viewerCount()).toBe(1);

    b.triggerClose();
    expect(f.kills).toBe(1);          // last viewer gone -> pipeline torn down
    expect(cam.viewerCount()).toBe(0);
  });

  it("re-attaching after a full drain starts a fresh spawner", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    a.triggerClose();
    expect(f.kills).toBe(1);

    const b = fakeRes();
    cam.attach(b.res);
    expect(f.starts).toBe(2);
    expect(cam.viewerCount()).toBe(1);
  });

  it("a frame pushed via the spawner's onFrame is written to EVERY attached response", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    const b = fakeRes();
    cam.attach(a.res);
    cam.attach(b.res);

    const jpeg = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xcc, 0xff, 0xd9]);
    expect(f.lastOnFrame).not.toBeNull();
    f.lastOnFrame!(jpeg);

    expect(a.res.write).toHaveBeenCalled();
    expect(b.res.write).toHaveBeenCalled();
    expect(a.writtenBuffers.some((buf) => buf.includes(jpeg))).toBe(true);
    expect(b.writtenBuffers.some((buf) => buf.includes(jpeg))).toBe(true);
  });

  it("a late-attaching viewer immediately gets the latest known frame, not a blank wait", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    f.lastOnFrame!(jpeg);

    const b = fakeRes();
    cam.attach(b.res);
    expect(b.writtenBuffers.some((buf) => buf.includes(jpeg))).toBe(true);
  });

  it("a viewer attaching before any frame ever arrives gets a placeholder frame, not nothing", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    expect(a.res.write).toHaveBeenCalled();
    const [chunk] = a.writtenBuffers;
    expect(chunk.includes(Buffer.from([0xff, 0xd8]))).toBe(true); // JPEG SOI marker present
  });
});

describe("CameraStreamer manual start (off by default)", () => {
  it("off by default: attaching a viewer does NOT start a pipeline, only shows a placeholder", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500 }); // no enabled -> off
    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(0);          // nothing grabs the camera on connect
    expect(cam.viewerCount()).toBe(1);
    expect(a.writtenBuffers.some((b) => b.includes(Buffer.from([0xff, 0xd8])))).toBe(true); // placeholder JPEG
    expect(cam.status().enabled).toBe(false);
    expect(cam.status().streaming).toBe(false);
  });

  it("enable() with a viewer already attached starts the pipeline", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500 });
    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(0);
    cam.enable();
    expect(f.starts).toBe(1);
    expect(cam.status()).toMatchObject({ enabled: true, streaming: false, viewers: 1 }); // spawned, no frame yet
    f.lastOnFrame!(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    expect(cam.status()).toMatchObject({ enabled: true, streaming: true, viewers: 1 });
  });

  it("enable before any viewer defers the pipeline until the first attach", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500 });
    cam.enable();
    expect(f.starts).toBe(0);          // nobody watching yet
    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(1);
  });

  it("disable() kills the pipeline and broadcasts a placeholder to attached viewers", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(1);
    f.lastOnFrame!(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])); // a real frame first
    a.writtenBuffers.length = 0;
    cam.disable();
    expect(f.kills).toBe(1);
    expect(cam.status().enabled).toBe(false);
    expect(cam.status().streaming).toBe(false);
    expect(cam.viewerCount()).toBe(1);  // viewer stays attached...
    expect(a.writtenBuffers.some((b) => b.includes(Buffer.from([0xff, 0xd8])))).toBe(true); // ...now on placeholder
  });

  it("re-enabling while already streaming does not needlessly restart", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(1);
    cam.enable();                      // already streaming
    expect(f.starts).toBe(1);          // no restart
    expect(f.kills).toBe(0);
  });

  it("ignores a late frame from a killed pipeline after disable() (no stale resurrection)", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    const a = fakeRes();
    cam.attach(a.res);
    const staleOnFrame = f.lastOnFrame!;
    cam.disable();
    a.writtenBuffers.length = 0;       // drop disable()'s placeholder broadcast
    const stale = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    staleOnFrame(stale);               // a frame buffered before the kill fires now
    expect(a.writtenBuffers.length).toBe(0);         // not broadcast to the existing viewer
    const b = fakeRes();
    cam.attach(b.res);                 // a fresh viewer must see the placeholder...
    expect(b.writtenBuffers.some((buf) => buf.includes(stale))).toBe(false); // ...not the stale frame
    expect(cam.status().streaming).toBe(false);
  });

  it("streaming is false until the pipeline produces its first frame (STARTING vs ON)", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500 });
    const a = fakeRes();
    cam.attach(a.res);
    cam.enable();
    expect(cam.status().streaming).toBe(false);      // spawned, no frame yet -> STARTING
    f.lastOnFrame!(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    expect(cam.status().streaming).toBe(true);       // frames flowing -> ON
  });

  it("a disabled streamer does not restart when its (killed) pipeline reports exit late", () => {
    vi.useFakeTimers();
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });
    const a = fakeRes();
    cam.attach(a.res);
    const onExit = f.lastOnExit!;
    cam.disable();
    onExit(1);                          // the killed pipeline's exit callback fires after disable
    vi.advanceTimersByTime(10_000);
    expect(f.starts).toBe(1);          // no zombie restart while disabled
    vi.useRealTimers();
  });
});

describe("CameraStreamer bounded auto-restart", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("restarts the spawner after fallbackMs when it exits while viewers remain attached", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(1);

    f.lastOnExit!(1); // pipeline died unexpectedly
    expect(f.starts).toBe(1); // not immediate -- bounded/backed-off
    vi.advanceTimersByTime(1500);
    expect(f.starts).toBe(2);
  });

  it("does NOT restart once every viewer has already detached", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    a.triggerClose();
    expect(f.kills).toBe(1);

    f.lastOnExit!(0);
    vi.advanceTimersByTime(10_000);
    expect(f.starts).toBe(1); // no zombie restart with nobody watching
  });
});

describe("CameraStreamer.stop", () => {
  it("tears down the pipeline and clears viewers", () => {
    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs: 1500, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    cam.stop();

    expect(f.kills).toBe(1);
    expect(cam.viewerCount()).toBe(0);
  });
});

// JpegFrameParser splits a raw MJPEG byte stream on SOI (0xFFD8) and EOI
// (0xFFD9) markers. mtplvcap serves multipart/x-mixed-replace, and either
// marker can land split across two read chunks -- both must still recover the
// frame, and the multipart headers between frames (which contain no SOI/EOI)
// must be skipped.
describe("JpegFrameParser", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);

  it("control: a complete JPEG delivered in a single chunk yields exactly one frame", () => {
    const parser = new JpegFrameParser();
    const frames = parser.push(jpeg);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(jpeg);
  });

  it("recovers a frame whose SOI marker (0xFF 0xD8) is split across two chunks", () => {
    const parser = new JpegFrameParser();
    const framesA = parser.push(Buffer.from([0xff]));
    const framesB = parser.push(Buffer.from([0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]));
    expect(framesA).toEqual([]);
    expect(framesB.length).toBe(1);
    expect(framesB[0]).toEqual(jpeg);
  });

  it("recovers a frame whose EOI marker (0xFF 0xD9) is split across two chunks", () => {
    const parser = new JpegFrameParser();
    const framesA = parser.push(Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff]));
    const framesB = parser.push(Buffer.from([0xd9]));
    expect(framesA).toEqual([]);
    expect(framesB.length).toBe(1);
    expect(framesB[0]).toEqual(jpeg);
  });

  it("skips multipart headers between frames (mtplvcap's MJPEG body)", () => {
    const parser = new JpegFrameParser();
    const boundary = Buffer.from("\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 7\r\n\r\n", "utf8");
    const stream = Buffer.concat([jpeg, boundary, jpeg]);
    const frames = parser.push(stream);
    expect(frames.length).toBe(2);
    expect(frames[0]).toEqual(jpeg);
    expect(frames[1]).toEqual(jpeg);
  });
});

describe("CameraStreamer bounded-restart cap", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops restarting once the restart budget is exhausted, and broadcasts the placeholder frame instead", () => {
    // Mirrors camera.ts's private MAX_RESTARTS constant -- not exported, so
    // pinned here. If that constant changes, this expected start count must too.
    const MAX_RESTARTS = 5;
    const fallbackMs = 1000;

    const f = fakeSpawnerFactory();
    const cam = new CameraStreamer(f.makeSpawner, { fallbackMs, enabled: true });

    const a = fakeRes();
    cam.attach(a.res);
    expect(f.starts).toBe(1);
    a.writtenBuffers.length = 0; // drop the initial placeholder write from attach()

    for (let i = 0; i < MAX_RESTARTS; i++) {
      f.lastOnExit!(1);
      vi.advanceTimersByTime(fallbackMs);
    }
    expect(f.starts).toBe(1 + MAX_RESTARTS); // initial start + one per allowed restart

    f.lastOnExit!(1);
    vi.advanceTimersByTime(fallbackMs * 10);
    expect(f.starts).toBe(1 + MAX_RESTARTS); // still bounded -- no zombie restart loop

    expect(a.writtenBuffers.length).toBeGreaterThan(0);
    expect(a.writtenBuffers.some((buf) => buf.includes(Buffer.from([0xff, 0xd8])))).toBe(true);
  });
});
