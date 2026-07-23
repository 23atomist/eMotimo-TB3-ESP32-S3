import { Vec3, normalize } from "./vec3.js";
import { ImuBurst, computeImuStats } from "../imu-stats.js";

// Normalized gravity direction in the SENSOR frame from a burst's mean accel.
// Magnitude is irrelevant (the accel is uncalibrated ~16% high); only direction
// matters for gravity-anchoring, so we normalize.
export function gravityFromBurst(burst: ImuBurst): Vec3 {
  const s = computeImuStats(burst);
  const g: Vec3 = [s.accel.x.mean, s.accel.y.mean, s.accel.z.mean];
  if (!Number.isFinite(g[0]) || !Number.isFinite(g[1]) || !Number.isFinite(g[2])) {
    throw new Error("gravityFromBurst: non-finite mean accel (empty or bad burst)");
  }
  return normalize(g);
}
