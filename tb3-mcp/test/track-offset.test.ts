import { describe, it, expect } from "vitest";
import { boresightToEnu, enuToPanTiltOffset } from "../src/geo/imu-orientation.js";
import { enuToPanTilt } from "../src/geo/orientation.js";
import { normalize } from "../src/geo/vec3.js";
import type { Vec3, Mat3 } from "../src/geo/vec3.js";

const LIM = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

describe("offset model wiring", () => {
  it("with cHead=[0,1,0]/geoPanSign=+1 the mapping is the legacy one (no behavior change)", () => {
    const u = normalize([0.2, 0.9, 0.3] as Vec3);
    const legacy = enuToPanTilt(I, u);
    const off = enuToPanTiltOffset(I, [0, 1, 0], 1, u, LIM);
    expect(off.panDeg).toBeCloseTo(legacy.panDeg, 9);
    expect(off.tiltDeg).toBeCloseTo(legacy.tiltDeg, 9);
  });

  it("a non-forward cHead shifts the commanded posture (offset is actually applied)", () => {
    const cHead = normalize([-0.52, 0.735, 0.434] as Vec3);
    const u = normalize([0.2, 0.9, 0.3] as Vec3);
    const off = enuToPanTiltOffset(I, cHead, -1, u, LIM);
    const legacy = enuToPanTilt(I, u);
    expect(Math.abs(off.tiltDeg - legacy.tiltDeg)).toBeGreaterThan(5);
  });

  it("boresightToEnu with cHead=[0,1,0]/geoPanSign=+1 matches the legacy boresight forward mapping", () => {
    // Legacy: matVec(R, panTiltToMount(panDeg, tiltDeg)). Round-trip through the
    // inverse instead of importing panTiltToMount directly: enuToPanTilt's own
    // output, fed back through boresightToEnu at defaults, must land back on the
    // original unit vector -- this is exactly the invariant the tracking/sun-guard
    // wiring in control.ts/sunguard.ts leans on.
    const u = normalize([0.2, 0.9, 0.3] as Vec3);
    const legacy = enuToPanTilt(I, u);
    const bw = boresightToEnu(I, [0, 1, 0], 1, legacy.panDeg, legacy.tiltDeg);
    expect(bw[0]).toBeCloseTo(u[0], 9);
    expect(bw[1]).toBeCloseTo(u[1], 9);
    expect(bw[2]).toBeCloseTo(u[2], 9);
  });
});
