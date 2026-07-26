import { describe, it, expect, vi } from "vitest";
import { CaptureController, type CaptureDeps } from "../src/capture/controller.js";

function ctl(over: Partial<CaptureDeps> = {}) {
  const calls = { record: [] as boolean[], snaps: [] as string[] };
  const d: CaptureDeps = {
    setRecord: async (on) => { calls.record.push(on); },
    snapshot: async (i) => { calls.snaps.push(i); return `/s/${i}.jpg`; },
    isArmed: async () => true,
    now: () => 0,
    nowIso: () => "2026-07-26T00:00:00.000Z",
    ...over,
  };
  return { c: new CaptureController(d, { debounceMs: 5000, autoEnabled: true }), calls };
}

describe("capture tool surface", () => {
  it("get_capture_status reports the full shape", () => {
    const { c } = ctl();
    expect(c.status()).toEqual({
      autoEnabled: true, recording: false, passIcao: null,
      lastSnapshot: null, lastError: null, lastSkipReason: null,
    });
  });

  it("set_capture_mode(false) disables auto capture and closes the valve", async () => {
    const { c, calls } = ctl();
    await c.setRecording(true);
    c.setAuto(false);
    await vi.waitFor(() => expect(calls.record).toEqual([true, false]));
    expect(c.status().autoEnabled).toBe(false);
  });

  it("capture_snapshot works independently of tracking", async () => {
    const { c, calls } = ctl();
    const p = await c.manualSnapshot("XYZ789");
    expect(p).toBe("/s/XYZ789.jpg");
    expect(calls.snaps).toEqual(["XYZ789"]);
    expect(c.status().lastSnapshot).toBe("/s/XYZ789.jpg");
  });

  it("start/stop_recording override the valve manually", async () => {
    const { c, calls } = ctl();
    await c.setRecording(true);
    expect(c.status().recording).toBe(true);
    await c.setRecording(false);
    expect(calls.record).toEqual([true, false]);
  });

  it("a failing manual snapshot rejects so the tool reports the error", async () => {
    const { c } = ctl({ snapshot: async () => { throw new Error("ffmpeg timeout"); } });
    await expect(c.manualSnapshot("ABC")).rejects.toThrow(/ffmpeg timeout/);
  });
});
