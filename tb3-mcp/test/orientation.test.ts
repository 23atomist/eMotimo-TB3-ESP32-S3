import { describe, it, expect } from "vitest";
import { solveOrientation, enuToPanTilt, separationDeg, resolvePanInRange } from "../src/geo/orientation.js";
import { panTiltToMount } from "../src/geo/boresight.js";
import { Vec3, Mat3, matVec, normalize } from "../src/geo/vec3.js";

// A known mount->ENU rotation to generate synthetic ground truth: yaw by `head`
// about Up, so a mount vector [x,y,z] maps to ENU. We build it by rotating the
// mount-forward (+Y) to point at ENU azimuth `head`.
function yawMountToEnu(headDeg: number): Mat3 {
  const h = (headDeg * Math.PI) / 180;
  // ENU images of mount basis: mount +X(right)->[cos h, -sin h,0]? Derive so
  // that mount-forward +Y maps to azimuth head: E=sin h, N=cos h.
  // columns = images of mount X, Y, Z in ENU
  const colX: Vec3 = [Math.cos(h), -Math.sin(h), 0]; // mount-right
  const colY: Vec3 = [Math.sin(h), Math.cos(h), 0];  // mount-forward -> azimuth head
  const colZ: Vec3 = [0, 0, 1];                      // mount-up -> Up
  return [
    [colX[0], colY[0], colZ[0]],
    [colX[1], colY[1], colZ[1]],
    [colX[2], colY[2], colZ[2]],
  ];
}

describe("orientation TRIAD solve", () => {
  it("recovers a pure-yaw rotation from two synthetic sightings", () => {
    const Rtrue = yawMountToEnu(37); // heading 37°
    // Two landmarks: aim the mount at pan/tilt, project through Rtrue to get ENU.
    const mA = panTiltToMount(10, 5);
    const mB = panTiltToMount(-70, 20);
    const eA = normalize(matVec(Rtrue, mA));
    const eB = normalize(matVec(Rtrue, mB));

    const R = solveOrientation(mA, eA, mB, eB);
    // R must reproduce both ENU directions from the mount aims.
    const backA = normalize(matVec(R, mA));
    const backB = normalize(matVec(R, mB));
    for (let i = 0; i < 3; i++) {
      expect(backA[i]).toBeCloseTo(eA[i], 9);
      expect(backB[i]).toBeCloseTo(eB[i], 9);
    }
  });

  it("end-to-end: a third target's ENU maps back to the pan/tilt we would have aimed", () => {
    const Rtrue = yawMountToEnu(210);
    const mA = panTiltToMount(0, 0);
    const mB = panTiltToMount(90, 15);
    const eA = normalize(matVec(Rtrue, mA));
    const eB = normalize(matVec(Rtrue, mB));
    const R = solveOrientation(mA, eA, mB, eB);

    // A third target we "know" should be at pan=45,tilt=8 in the mount frame:
    const mC = panTiltToMount(45, 8);
    const eC = normalize(matVec(Rtrue, mC)); // its true ENU direction
    const { panDeg, tiltDeg } = enuToPanTilt(R, eC);
    expect(panDeg).toBeCloseTo(45, 6);
    expect(tiltDeg).toBeCloseTo(8, 6);
  });

  it("separationDeg reports the angle between two landmark directions", () => {
    expect(separationDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 6);
    expect(separationDeg([1, 0, 0], [1, 0.02, 0])).toBeLessThan(2);
  });

  it("resolvePanInRange picks the in-range equivalent or null", () => {
    expect(resolvePanInRange(200, -180, 180)).toBeCloseTo(-160, 9); // 200-360
    expect(resolvePanInRange(-200, -180, 180)).toBeCloseTo(160, 9); // -200+360
    expect(resolvePanInRange(45, -180, 180)).toBe(45);
    // 135 is unreachable in [-90,90]: 135 out, 135-360=-225 out, 135+360=495 out.
    expect(resolvePanInRange(135, -90, 90)).toBeNull();
  });
});
