import { describe, it, expect, vi } from "vitest";
import { CameraPanel } from "../dashboard/public/camera-panel.js";

// -- fakes: DOM elements + a WhepSession stand-in, none of which need a
// browser -- this is exactly what makes CameraPanel testable: it takes these
// as injected deps instead of reaching for document/window itself. -------
//
// All three fakes below can push labels into ONE shared `order` array (see
// makePanel) so a test can assert relative ordering, not just end state --
// asserting only `closeCalls === 1 && img.src === "..."` would pass even if
// the panel attached the new surface BEFORE tearing down the old one, since
// nothing async separates the two operations today. The order assertions
// below are what actually pin "teardown precedes attach".

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

function fakeVideoEl(order: string[]) {
  let srcObject: unknown = null;
  return {
    hidden: true,
    get srcObject() { return srcObject; },
    set srcObject(v: unknown) {
      srcObject = v;
      order.push(v === null ? "video.srcObject=null" : "video.srcObject=set");
    },
  };
}

function fakeImgEl(order: string[]) {
  let src = "";
  let srcWrites = 0;
  const handlers: Record<string, Array<() => void>> = {};
  return {
    hidden: true,
    get src() { return src; },
    set src(v: string) { src = v; srcWrites++; order.push("img.src=" + v); },
    get srcWrites() { return srcWrites; },
    removeAttribute(_name: string) { src = ""; order.push("img.removeAttribute(src)"); },
    addEventListener(evt: string, cb: () => void) { (handlers[evt] ??= []).push(cb); },
    fire(evt: string) { (handlers[evt] ?? []).forEach((cb) => cb()); },
  };
}

// A deferred WhepSession: connect() doesn't settle until the test resolves
// or rejects it, so tests can simulate a session that's still negotiating
// (or one whose failure arrives late, after a mode switch away from webrtc).
// connect()/close() push into `order` synchronously, at CALL time (not at
// settle time), since "attach" for WHEP means "negotiation started", not
// "negotiation finished" -- exactly what a mode-switch race needs to prove.
function fakeWhepSession(order: string[]) {
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
      order.push("whep.connect");
      return new Promise<void>((resolve, reject) => {
        resolveConnect = () => { state = "connected"; videoEl.srcObject = "fake-stream"; resolve(); };
        rejectConnect = (e: unknown) => { reject(e); };
      });
    },
    close() { closeCalls++; state = "idle"; order.push("whep.close"); },
    get connectCalls() { return connectCalls; },
    get closeCalls() { return closeCalls; },
    settleConnect() { resolveConnect?.(); },
    failConnect(e: unknown = new Error("whep failed")) { rejectConnect?.(e); },
  };
}

function makePanel() {
  const order: string[] = [];
  const video = fakeVideoEl(order);
  const img = fakeImgEl(order);
  const frame = fakeFrame();
  const sessions: ReturnType<typeof fakeWhepSession>[] = [];
  const makeWhepSession = vi.fn(() => {
    const s = fakeWhepSession(order);
    sessions.push(s);
    return s;
  });
  const panel = new CameraPanel({ video, img, frame, makeWhepSession });
  return { panel, video, img, frame, makeWhepSession, sessions, order };
}

describe("CameraPanel", () => {
  it("switching mediamtx -> mjpeg tears down the WHEP session (closed, srcObject cleared) BEFORE attaching the <img>", async () => {
    const { panel, video, img, sessions, order } = makePanel();

    panel.sync({ enabled: true, source: "mediamtx" });
    sessions[0].settleConnect();
    await Promise.resolve();
    expect(video.srcObject).toBe("fake-stream");
    order.length = 0; // only the switch itself matters for ordering below

    panel.sync({ enabled: true, source: "mtplvcap" });

    // End state (would pass even with the wrong order, since nothing async
    // separates the two operations today -- kept as a basic sanity check).
    expect(sessions[0].closeCalls).toBe(1);
    expect(video.srcObject).toBeNull();
    expect(img.src).toBe("/camera/stream");

    // Order (what actually pins "before"): the whep teardown must be fully
    // recorded ahead of the mjpeg attach. Moot today because everything here
    // is synchronous -- but the moment teardown becomes async (e.g. awaiting
    // a real RTCPeerConnection.close()), attach-before-teardown means two
    // live consumers fighting over one panel, which is the exact bug this
    // dual-pipeline design exists to prevent.
    const closeIdx = order.indexOf("whep.close");
    const clearIdx = order.indexOf("video.srcObject=null");
    const attachIdx = order.indexOf("img.src=/camera/stream");
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(attachIdx);
    expect(clearIdx).toBeLessThan(attachIdx);
  });

  it("switching mjpeg -> mediamtx clears the <img> src BEFORE the WHEP session attaches", () => {
    const { panel, img, makeWhepSession, order } = makePanel();

    panel.sync({ enabled: true, source: "mtplvcap" });
    expect(img.src).toBe("/camera/stream");
    order.length = 0; // only the switch itself matters for ordering below

    panel.sync({ enabled: true, source: "mediamtx" });

    // End state.
    expect(img.src).toBe(""); // removeAttribute("src"), not "" (no page reload)
    expect(makeWhepSession).toHaveBeenCalledTimes(1);

    // Order: the <img> must be released before the WHEP session starts
    // negotiating, for the same reason as the reverse direction above.
    const clearIdx = order.indexOf("img.removeAttribute(src)");
    const connectIdx = order.indexOf("whep.connect");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeLessThan(connectIdx);
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
