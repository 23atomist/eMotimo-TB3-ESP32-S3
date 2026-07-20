import { describe, it, expect } from "vitest";
import { RigDirectClient } from "../src/dashboard/rig.js";

const BODY = { pos: { pan: 4444, tilt: 0, aux: 0 }, moving: 0, battery_v: 12, imu: { ok: true, pitch: 1, roll: 2, tempC: 25, pressHpa: 1008 } };
const fetchOk = (async () => ({ ok: true, json: async () => BODY })) as unknown as typeof fetch;

describe("RigDirectClient", () => {
  it("status parses /api/status", async () => {
    const r = await new RigDirectClient(["1.2.3.4"], fetchOk).status();
    expect(r.connected).toBe(true);
    expect(r.imu?.ok).toBe(true);
  });
  it("status on fetch failure → not connected (never throws)", async () => {
    const bad = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const r = await new RigDirectClient(["1.2.3.4"], bad).status();
    expect(r.connected).toBe(false);
  });
  it("stop POSTs and throws on non-ok (so the e-stop reports failure)", async () => {
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(new RigDirectClient(["1.2.3.4"], bad).stop()).rejects.toThrow();
  });
});
