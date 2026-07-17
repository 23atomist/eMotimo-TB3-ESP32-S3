import { describe, it, expect } from "vitest";
import { sunAzEl, sunEnu } from "../src/geo/sun.js";
import { norm } from "../src/geo/vec3.js";

// Instant helper: build a UTC epoch-ms from calendar fields (months are 1-based here).
const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s);

describe("sunAzEl — implementation-independent identities", () => {
  // At the June solstice the sun is ~overhead at the Tropic of Cancer near local
  // apparent noon; EoT is small (~-1.7 min) that week, so 12:00 UTC at lon 0 is
  // within a couple arcmin of apparent noon.
  it("is nearly overhead at the Tropic of Cancer on the June solstice", () => {
    const { elDeg } = sunAzEl({ lat: 23.44, lon: 0, height: 0 }, utc(2025, 6, 21, 12, 0));
    expect(elDeg).toBeGreaterThan(89.0);
  });

  // Equinox local apparent noon: elevation ≈ 90 - |lat|, sun due south (north
  // hemisphere). EoT ~-7 min near the March equinox, so at 12:00 UTC lon 0 the
  // sun sits a couple degrees east of due south and a hair below the noon peak.
  it("has noon elevation ≈ 90 - lat and is roughly due south at the equinox", () => {
    const { azDeg, elDeg } = sunAzEl({ lat: 40, lon: 0, height: 0 }, utc(2025, 3, 20, 12, 0));
    expect(elDeg).toBeGreaterThan(48.5);
    expect(elDeg).toBeLessThan(50.1);
    expect(azDeg).toBeGreaterThan(170);
    expect(azDeg).toBeLessThan(182);
  });

  it("is below the horizon at local midnight", () => {
    const { elDeg } = sunAzEl({ lat: 40, lon: 0, height: 0 }, utc(2025, 6, 21, 0, 0));
    expect(elDeg).toBeLessThan(0);
  });
});

describe("sunAzEl — NOAA-calculator reference (confirm at gml.noaa.gov/grad/solcalc)", () => {
  // Phoenix AZ near solar noon, 2026-07-17 19:30:00 UTC (12:30 MST). If this
  // fails by more than ~0.2°, VERIFY against the NOAA Solar Calculator and fix
  // the algorithm — do NOT edit the expected value to match your output.
  it("matches the Phoenix solar-noon fixture", () => {
    const { azDeg, elDeg } = sunAzEl({ lat: 33.4484, lon: -112.074, height: 0 }, utc(2026, 7, 17, 19, 30));
    expect(elDeg).toBeCloseTo(77.6, 0); // within 0.5°
    expect(azDeg).toBeCloseTo(175, -0.5); // within a few degrees
  });
});

describe("sunEnu", () => {
  it("returns a unit vector consistent with sunAzEl", () => {
    const rig = { lat: 33.4484, lon: -112.074, height: 0 };
    const t = utc(2026, 7, 17, 19, 30);
    const u = sunEnu(rig, t);
    expect(norm(u)).toBeCloseTo(1, 9);
    // Up-component = sin(elevation).
    const { elDeg } = sunAzEl(rig, t);
    expect(u[2]).toBeCloseTo(Math.sin((elDeg * Math.PI) / 180), 6);
  });
});
