import { describe, it, expect } from "vitest";
import { emergencyStop, runAction, type ControlDeps } from "../src/dashboard/controls.js";

function deps(over: Partial<ControlDeps> = {}): { d: ControlDeps; calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => async (...a: unknown[]) => { calls.push(`${n}:${JSON.stringify(a)}`); };
  const d: ControlDeps = {
    track: rec("track"), stopTracking: rec("stopTracking"),
    jog: rec("jog"), nudgeAimOffset: rec("nudgeAimOffset"),
    setRigLocation: rec("setRigLocation"), sightLandmark: rec("sightLandmark"),
    sightAircraft: async (hex: string) => { calls.push(`sightAircraft:${JSON.stringify([hex])}`); return `slot 1/2 sighted ${hex}`; },
    solveCalibration: async () => { calls.push("solve"); return "heading 71"; }, clearCalibration: rec("clearCalibration"),
    getTrackSector: async () => { calls.push("getTrackSector:[]"); return { enabled: false, startDeg: 0, endDeg: 360 }; },
    setTrackSector: rec("setTrackSector"),
    setSunGuard: rec("setSunGuard"),
    firmwareStop: rec("firmwareStop"), agentStop: rec("agentStop"), agentStart: rec("agentStart"),
    cameraStart: () => { calls.push("cameraStart:[]"); },
    cameraStop: () => { calls.push("cameraStop:[]"); },
    // Previously-unreachable tools (2026-07-28 dashboard-redesign plumbing) --
    // fakes return a message string, same convention as sightAircraft/
    // solveCalibration above (rec() returns void, which doesn't fit these).
    characterizeImu: async () => { calls.push("characterizeImu:[]"); return "rms 0.9"; },
    setNorthZero: async () => { calls.push("setNorthZero:[]"); return "north zero set"; },
    teachLimit: async (edge: string) => { calls.push(`teachLimit:${JSON.stringify([edge])}`); return `taught ${edge}`; },
    clearTaughtLimits: async () => { calls.push("clearTaughtLimits:[]"); return "taught limits cleared"; },
    setHome: async () => { calls.push("setHome:[]"); return "home set"; },
    captureSnapshot: async (icao?: string) => { calls.push(`captureSnapshot:${JSON.stringify([icao])}`); return "snapshot written"; },
    startRecording: async () => { calls.push("startRecording:[]"); return "recording started"; },
    stopRecording: async () => { calls.push("stopRecording:[]"); return "recording stopped"; },
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
  it("routes nudge-aim-offset", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "nudge-aim-offset", { delta_pan_deg: 0.5, delta_tilt_deg: -0.2 });
    expect(r.ok).toBe(true);
    expect(calls).toContain("nudgeAimOffset:[0.5,-0.2]");
  });
  it("routes calibrate/sight-aircraft", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "calibrate/sight-aircraft", { hex: "A1B2C3" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/sighted a1b2c3/i);
    expect(calls).toContain('sightAircraft:["A1B2C3"]');
  });
  it("calibrate/sight-aircraft without a hex → {ok:false}", async () => {
    const { d } = deps();
    const r = await runAction(d, "calibrate/sight-aircraft", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hex/i);
  });
  it("routes camera start/stop", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "camera/start", {})).ok).toBe(true);
    await runAction(d, "camera/stop", {});
    expect(calls).toContain("cameraStart:[]");
    expect(calls).toContain("cameraStop:[]");
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
  it("routes sun-guard/set with a boolean enabled", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "sun-guard/set", { enabled: true })).ok).toBe(true);
    await runAction(d, "sun-guard/set", { enabled: false });
    await runAction(d, "sun-guard/set", {}); // missing → false
    expect(calls).toContain("setSunGuard:[true]");
    expect(calls).toContain("setSunGuard:[false]");
    expect(calls.filter((c) => c === "setSunGuard:[false]").length).toBe(2);
  });

  // Previously the dashboard had no transport at all for these tools (the
  // operator asked how to trigger teach_limit/set_home from the UI and the
  // answer was "you can't") -- this pins that every one of them is now a
  // real ControlDeps method AND routed through runAction.
  it("exposes a control for every tool the redesign needs", () => {
    const { d } = deps();
    for (const k of ["characterizeImu", "setNorthZero", "teachLimit", "clearTaughtLimits",
                     "setHome", "captureSnapshot", "startRecording", "stopRecording"]) {
      expect(typeof (d as unknown as Record<string, unknown>)[k]).toBe("function");
    }
  });

  it("teachLimit passes the edge through unchanged", async () => {
    const seen: string[] = [];
    const { d } = deps({ teachLimit: async (e: string) => { seen.push(e); return "ok"; } });
    await d.teachLimit("pan_max");
    expect(seen).toEqual(["pan_max"]);
  });

  it("routes calibrate/characterize-imu, calibrate/set-north-zero", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "calibrate/characterize-imu", {})).message).toMatch(/rms/);
    expect((await runAction(d, "calibrate/set-north-zero", {})).message).toMatch(/north zero/);
    expect(calls).toContain("characterizeImu:[]");
    expect(calls).toContain("setNorthZero:[]");
  });

  it("routes limits/teach with an edge, and limits/clear-taught", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "limits/teach", { edge: "pan_max" });
    expect(r.ok).toBe(true);
    expect(calls).toContain('teachLimit:["pan_max"]');
    await runAction(d, "limits/clear-taught", {});
    expect(calls).toContain("clearTaughtLimits:[]");
  });

  it("limits/teach without an edge → {ok:false}", async () => {
    const { d } = deps();
    const r = await runAction(d, "limits/teach", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/edge/i);
  });

  it("routes home/set", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "home/set", {});
    expect(r.ok).toBe(true);
    expect(calls).toContain("setHome:[]");
  });

  it("routes capture/snapshot (with and without an icao), capture/start-recording, capture/stop-recording", async () => {
    const { d, calls } = deps();
    await runAction(d, "capture/snapshot", { icao: "A1B2C3" });
    await runAction(d, "capture/snapshot", {});
    await runAction(d, "capture/start-recording", {});
    await runAction(d, "capture/stop-recording", {});
    expect(calls).toContain('captureSnapshot:["A1B2C3"]');
    expect(calls).toContain("captureSnapshot:[null]"); // no icao -> JSON.stringify([undefined]) === "[null]"
    expect(calls).toContain("startRecording:[]");
    expect(calls).toContain("stopRecording:[]");
  });
});
