import { describe, it, expect } from "vitest";
import { emergencyStop, runAction, type ControlDeps } from "../src/dashboard/controls.js";

function deps(over: Partial<ControlDeps> = {}): { d: ControlDeps; calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => async (...a: unknown[]) => { calls.push(`${n}:${JSON.stringify(a)}`); };
  const d: ControlDeps = {
    track: rec("track"), stopTracking: rec("stopTracking"),
    jog: rec("jog"), setRigLocation: rec("setRigLocation"), sightLandmark: rec("sightLandmark"),
    solveCalibration: async () => { calls.push("solve"); return "heading 71"; }, clearCalibration: rec("clearCalibration"),
    firmwareStop: rec("firmwareStop"), agentStop: rec("agentStop"), agentStart: rec("agentStart"),
    cameraStart: (source: string) => { calls.push(`cameraStart:${JSON.stringify([source])}`); },
    cameraStop: () => { calls.push("cameraStop:[]"); },
    ...over,
  };
  return { d, calls };
}

describe("emergencyStop", () => {
  it("fires all three in parallel and reports allOk", async () => {
    const { d, calls } = deps();
    const r = await emergencyStop(d);
    expect(calls.sort()).toEqual(["agentStop:[]", "firmwareStop:[]", "stopTracking:[]"]);
    expect(r.allOk).toBe(true);
    expect(r.firmware.ok).toBe(true);
  });
  it("one failure does NOT abort the others", async () => {
    const { d, calls } = deps({ firmwareStop: async () => { throw new Error("rig unreachable"); } });
    const r = await emergencyStop(d);
    expect(r.firmware.ok).toBe(false);
    expect(r.firmware.message).toMatch(/rig unreachable/);
    expect(r.tracking.ok).toBe(true);            // still fired
    expect(r.agent.ok).toBe(true);
    expect(r.allOk).toBe(false);
    expect(calls).toContain("stopTracking:[]");
    expect(calls).toContain("agentStop:[]");
  });
});

describe("runAction", () => {
  it("routes track/stop/agent/jog/calibration", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "track", { hex: "abc" })).ok).toBe(true);
    await runAction(d, "stop", {});
    await runAction(d, "agent", { on: true });
    await runAction(d, "jog", { pan_dps: 5, tilt_dps: 0, duration_ms: 300 });
    await runAction(d, "calibrate/set-location", { lat: 1, lon: 2, height_m: 3 });
    await runAction(d, "calibrate/sight", { lat: 1, lon: 2, height_m: 3, label: "A" });
    const solved = await runAction(d, "calibrate/solve", {});
    expect(solved.message).toMatch(/heading/);
    expect(calls).toContain('track:["abc"]');
    expect(calls).toContain("agentStart:[]");
    expect(calls).toContain("jog:[5,0,300]");
  });
  it("routes camera start/stop with source validation", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "camera/start", { source: "v4l2" })).ok).toBe(true);
    expect((await runAction(d, "camera/start", { source: "gphoto2" })).ok).toBe(true);
    await runAction(d, "camera/stop", {});
    expect(calls).toContain('cameraStart:["v4l2"]');
    expect(calls).toContain('cameraStart:["gphoto2"]');
    expect(calls).toContain("cameraStop:[]");
  });
  it("rejects a camera start with a bad or missing source, without invoking the dep", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "camera/start", { source: "webcam" })).ok).toBe(false);
    expect((await runAction(d, "camera/start", {})).ok).toBe(false);
    expect(calls.some((c) => c.startsWith("cameraStart"))).toBe(false);
  });
  it("unknown action → {ok:false}", async () => {
    const { d } = deps();
    expect((await runAction(d, "explode", {})).ok).toBe(false);
  });
  it("a throwing dep → {ok:false, message}", async () => {
    const { d } = deps({ track: async () => { throw new Error("sun locked"); } });
    const r = await runAction(d, "track", { hex: "x" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sun locked/);
  });
});
