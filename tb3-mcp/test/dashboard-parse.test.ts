import { describe, it, expect } from "vitest";
import { parseRigStatus, parseServiceState } from "../src/dashboard/parse.js";

const SAMPLE = {
  pos: { pan: 44444, tilt: -8888, aux: 0 }, moving: 1, joy_latched: false,
  program_engaged: false, battery_v: 12.3, uptime_ms: 5000, heap: 170000,
  wifi: { ap_ip: "10.31.31.1", sta_ip: "192.168.4.56", clients: 1 },
  imu: { ok: true, pitch: 1.5, roll: -2.0, tempC: 25.0, pressHpa: 1008.0 },
};

describe("parseRigStatus", () => {
  it("parses full telemetry (steps kept raw, imu present)", () => {
    const r = parseRigStatus(SAMPLE);
    expect(r.connected).toBe(true);
    expect(r.moving).toBe(true);           // 1 → true
    expect(r.batteryV).toBe(12.3);
    expect(r.panSteps).toBe(44444);
    expect(r.tiltSteps).toBe(-8888);
    expect(r.imu?.ok).toBe(true);
    expect(r.imu?.pitchDeg).toBe(1.5);
    expect(r.joyLatched).toBe(false);
  });
  it("imu absent → imu null, still connected", () => {
    const r = parseRigStatus({ pos: { pan: 0, tilt: 0, aux: 0 }, moving: 0, battery_v: 12 });
    expect(r.connected).toBe(true);
    expect(r.moving).toBe(false);
    expect(r.imu).toBeNull();
  });
  it("garbage → not connected, all null, never throws", () => {
    expect(parseRigStatus(null).connected).toBe(false);
    expect(parseRigStatus("nope").panSteps).toBeNull();
    expect(parseRigStatus({}).connected).toBe(false);   // no pos → not a real status
  });
});

describe("parseServiceState", () => {
  it("maps systemctl is-active output", () => {
    expect(parseServiceState("active\n")).toBe("active");
    expect(parseServiceState("inactive")).toBe("inactive");
    expect(parseServiceState("failed")).toBe("failed");
    expect(parseServiceState("activating")).toBe("inactive");
    expect(parseServiceState("")).toBe("unknown");
    expect(parseServiceState("weird")).toBe("unknown");
  });
});
