import { describe, it, expect } from "vitest";
import { moveToUserAngle } from "../src/move.js";
import { loadConfig } from "../src/config.js";
import { Device } from "../src/device.js";

describe("moveToUserAngle", () => {
  it("prefixes device rejections with 'device rejected goto:'", async () => {
    const cfg = loadConfig(undefined, {});
    const fakeDevice = {
      gotoAngle: async () => {
        throw new Error("busy - program engaged");
      },
    } as unknown as Device;
    await expect(moveToUserAngle(fakeDevice, cfg, 0, 0)).rejects.toThrow(
      /device rejected goto:/,
    );
  });
});
