import { describe, it, expect, vi } from "vitest";
import { CameraPanel } from "../dashboard/public/camera-panel.js";

// -- fakes: DOM elements + a WhepSession stand-in, none of which need a
// browser -- this is exactly what makes CameraPanel testable: it takes these
// as injected deps instead of reaching for document/window itself. -------

function fakeClassList() {
  const set = new Set<string>();
  return {
    add: (c: string) => { set.add(c); },
    remove: (c: string) => { set.delete(c); },
    has: (c: string) => set.has(c),
  };
}

function fakeFrame() {
  return { classList: fakeClassList() };
}

function fakeVideoEl() {
  return { hidden: true, srcObject: null as unknown };
}

function fakeImgEl() {
  let src = "";
  let srcWrites = 0;
  const handlers: Record<string, Array<() => void>> = {};
  return {
    hidden: true,
    get src() { return src; },
    set src(v: string) { src = v; srcWrites++; },
    get srcWrites() { return srcWrites; },
    removeAttribute(_name: string) { src = ""; },
    addEventListener(evt: string, cb: () => void) { (handlers[evt] ??= []).push(cb); },
    fire(evt: string) { (handlers[evt] ?? []).forEach((cb) => cb()); },
  };
}

// A deferred WhepSession: connect() doesn't settle until the test resolves
// or rejects it, so tests can simulate a session that's still negotiating
// (or one whose failure arrives late, after a mode switch away from webrtc).
function fakeWhepSession() {
  let state = "idle";
  let connectCalls = 0;
  let closeCalls = 0;
  let resolveConnect: (() => void) | null = null;
  let rejectConnect: ((e: unknown) => void) | null = null;
  return {
    state: () => state,
    connect(videoEl: { srcObject: unknown }) {
      connectCalls++;
      state = "connecting";
      return new Promise<void>((resolve, reject) => {
        resolveConnect = () => { state = "connected"; videoEl.srcObject = "fake-stream"; resolve(); };
        rejectConnect = (e: unknown) => { reject(e); };
      });
    },
    close() { closeCalls++; state = "idle"; },
    get connectCalls() { return connectCalls; },
    get closeCalls() { return closeCalls; },
    settleConnect() { resolveConnect?.(); },
    failConnect(e: unknown = new Error("whep failed")) { rejectConnect?.(e); },
  };
}

function makePanel(whepFactory?: () => ReturnType<typeof fakeWhepSession>) {
  const video = fakeVideoEl();
  const img = fakeImgEl();
  const frame = fakeFrame();
  const sessions: ReturnType<typeof fakeWhepSession>[] = [];
  const makeWhepSession = vi.fn(() => {
    const s = (whepFactory ?? fakeWhepSession)();
    sessions.push(s);
    return s;
  });
  const panel = new CameraPanel({ video, img, frame, makeWhepSession });
  return { panel, video, img, frame, makeWhepSession, sessions };
}

describe("CameraPanel", () => {
  it("switching mediamtx -> mjpeg tears down the WHEP session before attaching the <img>", async () => {
    const { panel, video, img, sessions } = makePanel();

    panel.sync({ enabled: true, source: "mediamtx" });
    sessions[0].settleConnect();
    await Promise.resolve();
    expect(video.srcObject).toBe("fake-stream");

    panel.sync({ enabled: true, source: "mtplvcap" });

    expect(sessions[0].closeCalls).toBe(1);
    expect(video.srcObject).toBeNull();
    expect(img.src).toBe("/camera/stream");
  });

  it("switching mjpeg -> mediamtx clears the <img> src", () => {
    const { panel, img, makeWhepSession } = makePanel();

    panel.sync({ enabled: true, source: "mtplvcap" });
    expect(img.src).toBe("/camera/stream");

    panel.sync({ enabled: true, source: "mediamtx" });

    expect(img.src).toBe(""); // removeAttribute("src"), not "" (no page reload)
    expect(makeWhepSession).toHaveBeenCalledTimes(1);
  });

  it("a pending MJPEG retry timer that fires after a switch to webrtc does not re-attach the <img>", () => {
    vi.useFakeTimers();
    try {
      const { panel, img, frame } = makePanel();

      panel.sync({ enabled: true, source: "mtplvcap" });
      expect(img.src).toBe("/camera/stream");
      img.fire("error"); // stream drops -> camera-down + a scheduled retry
      expect(frame.classList.has("camera-down")).toBe(true);

      panel.sync({ enabled: true, source: "mediamtx" }); // switch away before the retry fires
      const writesAtSwitch = img.srcWrites;

      vi.advanceTimersByTime(10_000); // well past MJPEG_RETRY_MS

      expect(img.srcWrites).toBe(writesAtSwitch); // no further src assignment
      expect(img.src).toBe(""); // still torn down, not re-attached
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale WHEP failure arriving after a switch to mjpeg does not resurrect camera-error", async () => {
    const { panel, img, frame, sessions } = makePanel();

    panel.sync({ enabled: true, source: "mediamtx" }); // connect() left pending

    panel.sync({ enabled: true, source: "mtplvcap" }); // switch away before it settles
    expect(img.src).toBe("/camera/stream");

    sessions[0].failConnect(); // the OLD session's connect() rejects late
    await Promise.resolve();
    await Promise.resolve();

    expect(frame.classList.has("camera-error")).toBe(false);
    expect(frame.classList.has("camera-down")).toBe(false);
    expect(img.hidden).toBe(false); // mjpeg is still the live surface
  });

  it("an unchanged mjpeg source is a no-op on repeated ticks (no reattach churn)", () => {
    const { panel, img } = makePanel();

    panel.sync({ enabled: true, source: "mtplvcap" });
    panel.sync({ enabled: true, source: "mtplvcap" });
    panel.sync({ enabled: true, source: "mtplvcap" });

    expect(img.srcWrites).toBe(1); // attached exactly once, not once per tick
  });

  it("an unchanged, already-connected mediamtx source is a no-op on repeated ticks", async () => {
    const { panel, sessions } = makePanel();

    panel.sync({ enabled: true, source: "mediamtx" });
    sessions[0].settleConnect();
    await Promise.resolve();

    panel.sync({ enabled: true, source: "mediamtx" });
    panel.sync({ enabled: true, source: "mediamtx" });

    expect(sessions.length).toBe(1); // no second session created
    expect(sessions[0].connectCalls).toBe(1); // no re-connect once connected
  });

  it("defaults to mjpeg (attaching the <img>) when source is missing/degraded", () => {
    const { panel, img, video } = makePanel();

    panel.sync({ enabled: true });

    expect(img.hidden).toBe(false);
    expect(video.hidden).toBe(true);
    expect(img.src).toBe("/camera/stream");
  });
});
