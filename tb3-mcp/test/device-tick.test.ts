import { describe, it, expect } from "vitest";
import { sanitizeTickJson } from "../src/device.js";

describe("sanitizeTickJson", () => {
  it("coerces bare nan sensor values to null so a real MPU-6050 tick still parses", () => {
    // Actual tick captured off the rig: a 6-axis MPU-6050 has no barometer, so
    // tempC/pressHpa come through as the bare token `nan`, which is invalid JSON.
    const raw = '{"type":"tick","pos":[-43951,-9706,0],"moving":0,"batt":13.24,"imu":{"ok":true,"pitch":4.00,"roll":4.35,"tempC":nan,"pressHpa":nan}}';
    expect(() => JSON.parse(raw)).toThrow();       // the raw firmware tick is invalid JSON...
    const d = JSON.parse(sanitizeTickJson(raw));   // ...but survives after sanitizing
    expect(d.type).toBe("tick");
    expect(d.pos).toEqual([-43951, -9706, 0]);     // position preserved (the whole point)
    expect(d.batt).toBe(13.24);
    expect(d.imu.pitch).toBe(4.0);
    expect(d.imu.tempC).toBeNull();
    expect(d.imu.pressHpa).toBeNull();
  });

  it("leaves a clean tick (real numbers) untouched", () => {
    const raw = '{"type":"tick","pos":[1,2,0],"imu":{"tempC":25.5,"pressHpa":1008.2}}';
    const d = JSON.parse(sanitizeTickJson(raw));
    expect(d.imu.tempC).toBe(25.5);
    expect(d.imu.pressHpa).toBe(1008.2);
  });

  it("also coerces -nan, inf and Infinity", () => {
    const d = JSON.parse(sanitizeTickJson('{"a":-nan,"b":Infinity,"c":-inf,"d":5}'));
    expect(d.a).toBeNull();
    expect(d.b).toBeNull();
    expect(d.c).toBeNull();
    expect(d.d).toBe(5);
  });
});
