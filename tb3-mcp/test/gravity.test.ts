import { afterEach, describe, it, expect, vi } from "vitest";
import { gravityFromBurst } from "../src/geo/gravity.js";
import { sanitizeTickJson, Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import type { ImuBurst } from "../src/imu-stats.js";

// Shared across the direction-check tests below: two accel samples averaging
// to [0.11, 0.61, 0.91], so the expected unit direction is fixed once here.
const RAW_IMU_JSON =
  '{"info":{"present":true,"mpu_who":"0x68","mag_who":"0x00","bmp_id":"0x00","accel_fs_g":4,"gyro_fs_dps":500},' +
  '"n":2,"span_us":1000,"read_errors":0,' +
  '"samples":[[0,0.10,0.60,0.90,0,0,0,null,null,null,nan,nan],' +
  '[1000,0.12,0.62,0.92,0,0,0,null,null,null,nan,nan]]}';

function expectMeanGravityDirection(g: readonly [number, number, number]): void {
  expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
  const n = Math.hypot(0.11, 0.61, 0.91);
  expect(g[0]).toBeCloseTo(0.11 / n, 6);
  expect(g[2]).toBeCloseTo(0.91 / n, 6);
}

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
    expectMeanGravityDirection(g);
  });

  // Pins the PURE-HELPER path only (gravityFromBurst on an already-parsed
  // burst) — it does not exercise Device.getGravity's fetch/sanitize wiring.
  // Composition mirrors production exactly: sanitizeTickJson(raw) runs FIRST
  // (fixing any colon-prefixed `:nan`/`:inf` object-form values), THEN
  // .replace(/\bnan\b/gi, "null") runs SECOND (catching the remaining bare
  // `nan` tokens inside the sample ARRAYS, which sanitizeTickJson's
  // colon-anchored regex does not touch). See the "Device.getGravity" describe
  // block below for a test that exercises the real fetch-mocked path.
  it("survives bare-nan baro columns via the production sanitize order (pure-helper path)", () => {
    const burst = JSON.parse(
      sanitizeTickJson(RAW_IMU_JSON).replace(/\bnan\b/gi, "null"),
    ) as ImuBurst;
    const g = gravityFromBurst(burst);
    expectMeanGravityDirection(g);
  });
});

describe("Device.getGravity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Exercises the REAL production path end to end: fetch -> res.text() ->
  // sanitizeTickJson(raw).replace(/\bnan\b/gi, "null") -> JSON.parse ->
  // info.present check -> gravityFromBurst. RAW_IMU_JSON is exactly the
  // invalid-JSON shape the firmware emits (bare `nan` in the sample array's
  // baro columns), which is the same bug class that caused the field
  // telemetry-freeze -- this is the regression guard for that class in the
  // getGravity path specifically.
  it("fetches /api/imu, sanitizes bare-nan array-form JSON, and returns normalized gravity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response(RAW_IMU_JSON, { status: 200 })),
    );
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: "127.0.0.1:1" });
    const device = new Device(cfg);

    const g = await device.getGravity(2);

    expectMeanGravityDirection(g);
  });

  // Regression: the array-form sanitize used to be /\bnan\b/gi, which turns
  // `-nan` into `-null` -- still invalid JSON (a bare minus can't precede the
  // `null` literal) -- so a negative-nan baro reading dropped the WHOLE tick,
  // same failure class as the un-sanitized bare `nan` this path exists to
  // fix. The regex must consume the leading `-` too.
  it("also sanitizes bare -nan (negative-nan) array-form tokens", async () => {
    const rawNegNan = RAW_IMU_JSON.replace(/nan,nan/g, "-nan,-nan");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response(rawNegNan, { status: 200 })),
    );
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: "127.0.0.1:1" });
    const device = new Device(cfg);

    const g = await device.getGravity(2);

    expectMeanGravityDirection(g);
  });
});
