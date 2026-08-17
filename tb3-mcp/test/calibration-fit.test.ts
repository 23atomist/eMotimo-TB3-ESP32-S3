import { describe, it, expect } from "vitest";
import { fitCalibration, FitSighting, DEFAULT_SIGHTING_SIGMA_DEG } from "../src/geo/calibration-fit.js";
import { boresightToEnu, rotAlign } from "../src/geo/imu-orientation.js";
import { Vec3, Mat3, normalize, rotZ, matMul, deg2rad, rad2deg, angleBetweenDeg } from "../src/geo/vec3.js";
import { enuDirection } from "../src/geo/wgs84.js";

const GP = -1;
// A base leaning ~1.2° north, matching the real rig.
const D_BASE: Vec3 = normalize([0.0214, -0.0010, -0.9998]);

function cHeadOf(sideDeg: number, upDeg: number): Vec3 {
  const a = deg2rad(sideDeg), e = deg2rad(upDeg);
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

// Build a synthetic sighting: given truth (R, cHead) and a posture, the ENU
// direction the camera actually looks at IS the truth direction.
function synth(R: Mat3, c: Vec3, panDeg: number, tiltDeg: number, sigmaDeg = 0.5): FitSighting {
  return { panDeg, tiltDeg, enuUnit: normalize(boresightToEnu(R, c, GP, panDeg, tiltDeg)), sigmaDeg };
}

describe("fitCalibration", () => {
  it("recovers a known heading and camera offset from well-spread sightings", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [
      [40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30],
    ];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("full");
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
    expect(fit.rmsDeg).toBeLessThan(0.1);
    expect(fit.usedCount).toBe(6);
  });
});

describe("fitCalibration conditioning gate", () => {
  it("refuses the camera offset when two sightings barely span any tilt", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const s = [synth(truthR, truthC, 24, 10), synth(truthR, truthC, -23, 18)];

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
    expect(fit.cHeadSigmaDeg).toBeNull();
  });

  it("never returns a camera offset beyond the physical bound", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    // A genuinely absurd camera mounting; the physical guard must reject it
    // even though the data supports it perfectly.
    const truthC = cHeadOf(43, 4);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t, 0.2));

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.stage).toBe("heading-only");
  });
});

describe("fitCalibration outlier rejection", () => {
  it("rejects one gross outlier and recovers the true fit", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const truthC = cHeadOf(4, -3);
    const postures: [number, number][] = [[40, 5], [10, 20], [-20, 38], [-55, 12], [25, 50], [-5, 30]];
    const s = postures.map(([p, t]) => synth(truthR, truthC, p, t));
    // Corrupt one sighting's recorded posture by 15° — an operator who
    // centred the wrong aircraft.
    s[2] = { ...s[2], panDeg: s[2].panDeg + 15 };

    const fit = fitCalibration(D_BASE, s, GP);

    expect(fit.rejected[2]).toBe(true);
    expect(fit.rejected.filter(Boolean)).toHaveLength(1);
    expect(fit.usedCount).toBe(5);
    expect(angleBetweenDeg(fit.cHead, truthC)).toBeLessThan(1);
  });

  it("retains every sighting when there are too few to judge an outlier", () => {
    const R0 = rotAlign([-D_BASE[0], -D_BASE[1], -D_BASE[2]], [0, 0, 1] as Vec3);
    const truthR = matMul(rotZ(deg2rad(37)), R0);
    const s = [
      synth(truthR, cHeadOf(4, -3), 40, 5),
      synth(truthR, cHeadOf(4, -3), -20, 38),
      synth(truthR, cHeadOf(4, -3), 10, 20),
    ];
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.rejected).toEqual([false, false, false]);
  });
});

describe("fitCalibration against the 2026-08-16 field profile", () => {
  // The exact rig position and the two sightings that produced the 43.4°
  // cHead in ~/.tb3-mcp/calibration.json. This must never solve to a
  // sideways camera again.
  const rig = { lat: 33.38317744521082, lon: -112.14130929961672, height: 341 };
  const field = [
    { lat: 33.48862875499936, lon: -112.19274762587969, height: 2590.9658112, panDeg: 23.92202392202392, tiltDeg: 10.22176022176022 },
    { lat: 33.410182683296966, lon: -112.12529990150021, height: 1322.22678912, panDeg: -22.58102258102258, tiltDeg: 18.474768474768474 },
  ];
  const s: FitSighting[] = field.map((f) => ({
    panDeg: f.panDeg, tiltDeg: f.tiltDeg,
    enuUnit: enuDirection(rig, { lat: f.lat, lon: f.lon, height: f.height }).unit,
    sigmaDeg: DEFAULT_SIGHTING_SIGMA_DEG,
  }));

  it("falls back to heading-only instead of a 43° camera offset", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.stage).toBe("heading-only");
    expect(fit.cHead).toEqual([0, 1, 0]);
  });

  it("keeps every sighting within a few degrees", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    for (const r of fit.residualsDeg) expect(r).toBeLessThan(3);
  });

  it("reports the short tilt baseline that caused the problem", () => {
    const fit = fitCalibration(D_BASE, s, GP);
    expect(fit.tiltSpreadDeg).toBeGreaterThan(8);
    expect(fit.tiltSpreadDeg).toBeLessThan(9);
  });
});
