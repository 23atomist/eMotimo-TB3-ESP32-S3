import { describe, it, expect } from "vitest";
import { gravityFromBurst } from "../src/geo/gravity.js";
import { sanitizeTickJson } from "../src/device.js";
import type { ImuBurst } from "../src/imu-stats.js";

describe("gravityFromBurst", () => {
  it("returns the normalized mean accel direction", () => {
    const burst: ImuBurst = {
      info: { present: true, mpu_who: "0x68", mag_who: "0x00", bmp_id: "0x00", accel_fs_g: 4, gyro_fs_dps: 500 },
      n: 2, span_us: 200000, read_errors: 0,
      samples: [
        [0, 0.10, 0.60, 0.90, 0, 0, 0, null, null, null, null, null],
        [1000, 0.12, 0.62, 0.92, 0, 0, 0, null, null, null, null, null],
      ],
    };
    const g = gravityFromBurst(burst);
    expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
    // direction of mean [0.11, 0.61, 0.91]
    const n = Math.hypot(0.11, 0.61, 0.91);
    expect(g[0]).toBeCloseTo(0.11 / n, 6);
    expect(g[2]).toBeCloseTo(0.91 / n, 6);
  });

  it("survives bare-nan baro columns after sanitize (the field JSON shape)", () => {
    const raw = '{"info":{"present":true,"mpu_who":"0x68","mag_who":"0x00","bmp_id":"0x00","accel_fs_g":4,"gyro_fs_dps":500},"n":1,"span_us":1000,"read_errors":0,"samples":[[0,0.1,0.6,0.9,0,0,0,null,null,null,nan,nan]]}';
    const burst = JSON.parse(sanitizeTickJson(raw.replace(/nan/gi, "null"))) as ImuBurst;
    const g = gravityFromBurst(burst);
    expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
  });
});
