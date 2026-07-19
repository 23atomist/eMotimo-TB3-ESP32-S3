import { describe, it, expect } from "vitest";
import { computeImuStats, type ImuBurst } from "../src/imu-stats.js";

// Two samples 5000µs apart → 200 Hz. Accel z alternates 1.00/1.02 (mean 1.01,
// nonzero std); gyro x is a constant 0.5 bias; mag on sample 2 is null (a failed
// read) so validCount must be 1 and mag stats ignore the null.
const burst: ImuBurst = {
  info: { present: true, mpu_who: "0x71", mag_who: "0x48", bmp_id: "0x58", accel_fs_g: 4, gyro_fs_dps: 500 },
  n: 2, span_us: 5000, read_errors: 0,
  samples: [
    [0,     0, 0, 1.00, 0.5, 0, 0, 20, 0, -40, 25.0, 1013.0],
    [5000,  0, 0, 1.02, 0.5, 0, 0, 22, 0, -38, 25.2, 1013.2],
  ],
};

describe("computeImuStats", () => {
  it("computes rate, per-axis mean/std, magnitudes, and skips null mag samples", () => {
    const s = computeImuStats(burst);
    expect(s.sampleCount).toBe(2);
    expect(s.rateHz).toBeCloseTo(200, 1);          // 1 / 5000µs
    expect(s.accel.z.mean).toBeCloseTo(1.01, 6);
    expect(s.accel.z.std).toBeGreaterThan(0);
    expect(s.accel.magMean).toBeCloseTo(1.01, 2);  // |[0,0,~1.01]|
    expect(s.gyro.x.mean).toBeCloseTo(0.5, 6);     // constant bias
    expect(s.gyro.x.std).toBeCloseTo(0, 6);
    expect(s.mag.validCount).toBe(2);
    expect(s.readErrors).toBe(0);
  });

  it("counts null mag rows as invalid and computes mag stats over the rest", () => {
    const b: ImuBurst = { ...burst, samples: [
      [0,    0,0,1, 0,0,0, 20,0,-40, 25,1013],
      [5000, 0,0,1, 0,0,0, null,null,null, 25,1013],  // failed mag read
    ]};
    const s = computeImuStats(b);
    expect(s.mag.validCount).toBe(1);
    expect(s.mag.x.mean).toBeCloseTo(20, 6);
  });
});
