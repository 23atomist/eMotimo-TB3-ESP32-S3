# Geo-Pointing (Layer 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add geo-pointing to the `tb3-mcp` daemon — convert a target `lat/lon/height` into an azimuth/elevation and then pan/tilt, and drive the rig via layer-1's move path, with a two-landmark calibration solving the full mount orientation.

**Architecture:** New pure math modules (`src/geo/*`) plus a persisted calibration store and a new MCP tool group, all inside the existing `tb3-mcp` daemon. Calibration solves one mount→ENU rotation `R` by TRIAD from two landmark sightings; pointing applies `Rᵀ`. The layer-1 move logic is extracted into a shared helper both `goto_angle` and `point_at` call.

**Tech Stack:** TypeScript (ESM, Node 20), zod, vitest, `@modelcontextprotocol/sdk`. Same daemon as layer 1 in `tb3-mcp/`.

## Global Constraints

- Project root for all paths below is `tb3-mcp/`. Source in `tb3-mcp/src/`, tests in `tb3-mcp/test/`.
- **ESM imports MUST use the `.js` extension** even for `.ts` files (e.g. `import { Vec3 } from "./vec3.js"`). This is how the existing code compiles.
- **WGS84 constants:** semi-major axis `a = 6378137.0` m, flattening `f = 1 / 298.257223563`, `e2 = f * (2 - f)`.
- **Boresight convention (mount frame):** `d_mount(pan, tilt) = [sin(pan)·cos(tilt), cos(pan)·cos(tilt), sin(tilt)]`, pan/tilt in radians internally. Inverts to `tilt = asin(z)`, `pan = atan2(x, y)`.
- **ENU convention:** unit vector `[East, North, Up]`. `azimuth = atan2(E, N)` normalized to `[0, 360)`°; `elevation = asin(U)`°.
- **Rotation `R` maps mount → ENU.** Pointing uses `Rᵀ` (ENU → mount).
- **User frame:** all pan/tilt exposed to tools are user-frame degrees, related to device steps by `applySign(stepsToDeg(steps), cfg.panSign|tiltSign)` (from `src/angles.ts`). `get_status`/`goto_angle` already use this frame.
- **Reachability reuses `checkPanTilt` from `src/angles.ts`** so the soft limits in `Config` stay the single source of truth.
- **Heights use one consistent datum** (treated as height-above-ellipsoid; MSL works because the geoid separation cancels in the ENU height difference). Do not add a geoid model.
- **Persistence:** the calibration profile is a JSON file, written **atomically** (temp file + `rename`), **zod-validated** on load with a `version` field; a missing or corrupt file yields an uncalibrated store and never throws.
- **Angles at the tool boundary are degrees.** Internal math is radians; convert at the edges. Provide `deg2rad`/`rad2deg` in `vec3.ts`.
- Run all tests from `tb3-mcp/`: `npm test` (vitest, `fileParallelism: false`). Build with `npm run build`.
- Commit messages: conventional format (`feat:`, `refactor:`, `test:`), end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/geo/vec3.ts` (new) | `Vec3`/`Mat3` types + linear-algebra primitives; `deg2rad`/`rad2deg` |
| `src/geo/wgs84.ts` (new) | geodetic→ECEF→ENU direction; azimuth/elevation/range |
| `src/geo/boresight.ts` (new) | pan/tilt ↔ mount-frame unit vector |
| `src/geo/orientation.ts` (new) | TRIAD solve → `R`; `Rᵀ`-based pointing; landmark separation; pan-wrap resolver |
| `src/calibration.ts` (new) | calibration profile schema + `CalibrationStore` (atomic load/save) |
| `src/move.ts` (new) | `moveToUserAngle` — extracted layer-1 move logic used by `goto_angle` and geo tools |
| `src/geo-tools.ts` (new) | the 7 geo MCP tools (`registerGeoTools`) |
| `src/config.ts` (modify) | add `calibrationFile` config + env override |
| `src/tools.ts` (modify) | `goto_angle` uses `moveToUserAngle` |
| `src/server.ts` (modify) | build `CalibrationStore`, call `registerGeoTools` |

---

### Task 1: Vector/matrix primitives (`src/geo/vec3.ts`)

**Files:**
- Create: `tb3-mcp/src/geo/vec3.ts`
- Test: `tb3-mcp/test/vec3.test.ts`

**Interfaces:**
- Produces:
  - `type Vec3 = readonly [number, number, number]`
  - `type Mat3 = readonly [Vec3, Vec3, Vec3]` (three **rows**)
  - `deg2rad(d: number): number`, `rad2deg(r: number): number`
  - `sub(a: Vec3, b: Vec3): Vec3`, `dot(a, b): number`, `cross(a, b): Vec3`
  - `norm(a: Vec3): number`, `normalize(a: Vec3): Vec3` (throws on zero-length), `scale(a: Vec3, k: number): Vec3`
  - `matFromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3`
  - `matVec(m: Mat3, v: Vec3): Vec3`, `matMul(a: Mat3, b: Mat3): Mat3`, `transpose(m: Mat3): Mat3`
  - `angleBetweenDeg(a: Vec3, b: Vec3): number`

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/vec3.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  deg2rad, rad2deg, sub, dot, cross, norm, normalize, scale,
  matFromColumns, matVec, matMul, transpose, angleBetweenDeg, Vec3, Mat3,
} from "../src/geo/vec3.js";

describe("vec3 primitives", () => {
  it("deg/rad round-trip", () => {
    expect(rad2deg(deg2rad(37))).toBeCloseTo(37, 9);
    expect(deg2rad(180)).toBeCloseTo(Math.PI, 12);
  });
  it("basic vector ops", () => {
    expect(sub([3, 5, 7], [1, 2, 3])).toEqual([2, 3, 4]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(norm([3, 4, 0])).toBeCloseTo(5, 12);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
    const n = normalize([0, 3, 4]);
    expect(norm(n)).toBeCloseTo(1, 12);
    expect(n[2]).toBeCloseTo(0.8, 12);
  });
  it("normalize throws on zero-length", () => {
    expect(() => normalize([0, 0, 0])).toThrow();
  });
  it("matVec applies a matrix built from columns", () => {
    // identity from standard basis columns
    const I = matFromColumns([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(matVec(I, [5, 6, 7])).toEqual([5, 6, 7]);
    // columns become the images of the basis vectors
    const M = matFromColumns([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    expect(matVec(M, [1, 0, 0])).toEqual([1, 2, 3]);
    expect(matVec(M, [0, 1, 0])).toEqual([4, 5, 6]);
  });
  it("transpose and matMul give R·Rᵀ = I for a rotation", () => {
    // 90° rotation about Z, as columns (images of x,y,z)
    const R = matFromColumns([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    const I = matMul(R, transpose(R));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(I[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
  });
  it("angleBetweenDeg", () => {
    expect(angleBetweenDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 9);
    expect(angleBetweenDeg([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 9);
    expect(angleBetweenDeg([1, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/vec3.test.ts`
Expected: FAIL — cannot find module `../src/geo/vec3.js`.

- [ ] **Step 3: Write minimal implementation** — `tb3-mcp/src/geo/vec3.ts`

```typescript
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3]; // three rows

export function deg2rad(d: number): number { return (d * Math.PI) / 180; }
export function rad2deg(r: number): number { return (r * 180) / Math.PI; }

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function norm(a: Vec3): number { return Math.sqrt(dot(a, a)); }
export function scale(a: Vec3, k: number): Vec3 { return [a[0] * k, a[1] * k, a[2] * k]; }
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) throw new Error("cannot normalize a zero-length vector");
  return [a[0] / n, a[1] / n, a[2] / n];
}

// Columns c0,c1,c2 become the images of the standard basis vectors.
export function matFromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
}
export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}
export function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}
export function matMul(a: Mat3, b: Mat3): Mat3 {
  const bt = transpose(b); // rows of bt are columns of b
  return [
    [dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
    [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
    [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
  ];
}
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = dot(normalize(a), normalize(b));
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, c))));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/vec3.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd tb3-mcp && git add src/geo/vec3.ts test/vec3.test.ts
git commit -m "feat(geo): vector/matrix primitives for geo-pointing"
```

---

### Task 2: WGS84 → ENU + az/el/range (`src/geo/wgs84.ts`)

**Files:**
- Create: `tb3-mcp/src/geo/wgs84.ts`
- Test: `tb3-mcp/test/wgs84.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `sub`, `norm`, `normalize`, `deg2rad`, `rad2deg` from `./vec3.js`.
- Produces:
  - `interface Geodetic { lat: number; lon: number; height: number }` (degrees, degrees, meters)
  - `geodeticToEcef(g: Geodetic): Vec3` (meters)
  - `enuDirection(rig: Geodetic, target: Geodetic): { unit: Vec3; range: number }` (ENU unit vector, meters)
  - `interface AzElRange { azimuth: number; elevation: number; range: number }` (deg, deg, m)
  - `azElRange(rig: Geodetic, target: Geodetic): AzElRange`

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/wgs84.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { geodeticToEcef, enuDirection, azElRange, Geodetic } from "../src/geo/wgs84.js";
import { norm } from "../src/geo/vec3.js";

describe("wgs84", () => {
  it("geodeticToEcef at the equator/prime meridian, sea level", () => {
    // lat=0, lon=0, h=0 → x=a, y=0, z=0
    const p = geodeticToEcef({ lat: 0, lon: 0, height: 0 });
    expect(p[0]).toBeCloseTo(6378137.0, 1);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0, 6);
  });
  it("geodeticToEcef at the north pole", () => {
    // lat=90 → z = b = a(1-f)
    const p = geodeticToEcef({ lat: 90, lon: 0, height: 0 });
    const b = 6378137.0 * (1 - 1 / 298.257223563);
    expect(p[0]).toBeCloseTo(0, 3);
    expect(p[1]).toBeCloseTo(0, 3);
    expect(p[2]).toBeCloseTo(b, 1);
  });
  it("enuDirection: a point due north and level reads azimuth 0, elevation 0", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    // 1 km due north, same height → mostly North, ~0 elevation
    const target: Geodetic = { lat: 45 + 1000 / 111320, lon: 10, height: 100 };
    const { unit, range } = enuDirection(rig, target);
    expect(unit[0]).toBeCloseTo(0, 3);          // East ≈ 0
    expect(unit[1]).toBeGreaterThan(0.99);       // mostly North
    expect(Math.abs(unit[2])).toBeLessThan(0.02); // near level
    expect(range).toBeGreaterThan(950);
    expect(range).toBeLessThan(1050);
  });
  it("azElRange: due-east target reads azimuth ~90", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    const target: Geodetic = { lat: 45, lon: 10 + 0.01, height: 100 };
    const r = azElRange(rig, target);
    expect(r.azimuth).toBeGreaterThan(89);
    expect(r.azimuth).toBeLessThan(91);
    expect(Math.abs(r.elevation)).toBeLessThan(1);
  });
  it("azElRange: a target directly overhead reads elevation ~90", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 0 };
    const target: Geodetic = { lat: 45, lon: 10, height: 1000 };
    const r = azElRange(rig, target);
    expect(r.elevation).toBeGreaterThan(89);
    expect(r.range).toBeCloseTo(1000, 0);
  });
  it("azimuth is normalized to [0,360): due-west reads ~270", () => {
    const rig: Geodetic = { lat: 45, lon: 10, height: 100 };
    const target: Geodetic = { lat: 45, lon: 10 - 0.01, height: 100 };
    const r = azElRange(rig, target);
    expect(r.azimuth).toBeGreaterThan(269);
    expect(r.azimuth).toBeLessThan(271);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/wgs84.test.ts`
Expected: FAIL — cannot find module `../src/geo/wgs84.js`.

- [ ] **Step 3: Write minimal implementation** — `tb3-mcp/src/geo/wgs84.ts`

```typescript
import { Vec3, sub, norm, normalize, deg2rad, rad2deg } from "./vec3.js";

const A = 6378137.0;                 // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;         // flattening
const E2 = F * (2 - F);              // first eccentricity squared

export interface Geodetic {
  lat: number;    // degrees
  lon: number;    // degrees
  height: number; // meters (ellipsoidal; MSL is fine — see plan Global Constraints)
}

export function geodeticToEcef(g: Geodetic): Vec3 {
  const lat = deg2rad(g.lat);
  const lon = deg2rad(g.lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const x = (n + g.height) * cosLat * Math.cos(lon);
  const y = (n + g.height) * cosLat * Math.sin(lon);
  const z = (n * (1 - E2) + g.height) * sinLat;
  return [x, y, z];
}

// Rotate an ECEF delta into the local ENU frame at `origin`.
function ecefDeltaToEnu(origin: Geodetic, delta: Vec3): Vec3 {
  const lat = deg2rad(origin.lat);
  const lon = deg2rad(origin.lon);
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const [dx, dy, dz] = delta;
  const e = -sinLon * dx + cosLon * dy;
  const n = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const u = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  return [e, n, u];
}

export function enuDirection(rig: Geodetic, target: Geodetic): { unit: Vec3; range: number } {
  const delta = sub(geodeticToEcef(target), geodeticToEcef(rig));
  const enu = ecefDeltaToEnu(rig, delta);
  const range = norm(enu);
  return { unit: normalize(enu), range };
}

export interface AzElRange {
  azimuth: number;   // degrees, [0,360)
  elevation: number; // degrees, [-90,90]
  range: number;     // meters
}

export function azElRange(rig: Geodetic, target: Geodetic): AzElRange {
  const { unit, range } = enuDirection(rig, target);
  let azimuth = rad2deg(Math.atan2(unit[0], unit[1]));
  if (azimuth < 0) azimuth += 360;
  const elevation = rad2deg(Math.asin(Math.max(-1, Math.min(1, unit[2]))));
  return { azimuth, elevation, range };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/wgs84.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd tb3-mcp && git add src/geo/wgs84.ts test/wgs84.test.ts
git commit -m "feat(geo): WGS84 geodetic to ENU direction + az/el/range"
```

---

### Task 3: Boresight kinematics (`src/geo/boresight.ts`)

**Files:**
- Create: `tb3-mcp/src/geo/boresight.ts`
- Test: `tb3-mcp/test/boresight.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `deg2rad`, `rad2deg` from `./vec3.js`.
- Produces:
  - `panTiltToMount(panDeg: number, tiltDeg: number): Vec3` (unit vector)
  - `mountToPanTilt(v: Vec3): { panDeg: number; tiltDeg: number }`

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/boresight.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { panTiltToMount, mountToPanTilt } from "../src/geo/boresight.js";
import { norm } from "../src/geo/vec3.js";

describe("boresight", () => {
  it("pan=0 tilt=0 points along +Y (mount-forward), unit length", () => {
    const v = panTiltToMount(0, 0);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
    expect(v[2]).toBeCloseTo(0, 12);
    expect(norm(v)).toBeCloseTo(1, 12);
  });
  it("pan=90 tilt=0 points along +X (mount-right)", () => {
    const v = panTiltToMount(90, 0);
    expect(v[0]).toBeCloseTo(1, 12);
    expect(v[1]).toBeCloseTo(0, 12);
    expect(v[2]).toBeCloseTo(0, 12);
  });
  it("tilt=90 points along +Z (mount-up)", () => {
    const v = panTiltToMount(0, 90);
    expect(v[2]).toBeCloseTo(1, 12);
  });
  it("round-trips pan/tilt through the mount vector", () => {
    for (const [p, t] of [[0, 0], [37.5, 12], [-120, 40], [175, -30], [-90, 0]]) {
      const back = mountToPanTilt(panTiltToMount(p, t));
      expect(back.panDeg).toBeCloseTo(p, 9);
      expect(back.tiltDeg).toBeCloseTo(t, 9);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/boresight.test.ts`
Expected: FAIL — cannot find module `../src/geo/boresight.js`.

- [ ] **Step 3: Write minimal implementation** — `tb3-mcp/src/geo/boresight.ts`

```typescript
import { Vec3, deg2rad, rad2deg } from "./vec3.js";

// Mount-frame boresight: pan about mount-up (+Z), tilt raises toward +Z.
// d = [sin(pan)cos(tilt), cos(pan)cos(tilt), sin(tilt)]
export function panTiltToMount(panDeg: number, tiltDeg: number): Vec3 {
  const p = deg2rad(panDeg);
  const t = deg2rad(tiltDeg);
  const ct = Math.cos(t);
  return [Math.sin(p) * ct, Math.cos(p) * ct, Math.sin(t)];
}

export function mountToPanTilt(v: Vec3): { panDeg: number; tiltDeg: number } {
  const z = Math.max(-1, Math.min(1, v[2]));
  const tiltDeg = rad2deg(Math.asin(z));
  const panDeg = rad2deg(Math.atan2(v[0], v[1]));
  return { panDeg, tiltDeg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/boresight.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd tb3-mcp && git add src/geo/boresight.ts test/boresight.test.ts
git commit -m "feat(geo): pan/tilt <-> mount-frame boresight kinematics"
```

---

### Task 4: Orientation solve + pointing (`src/geo/orientation.ts`)

**Files:**
- Create: `tb3-mcp/src/geo/orientation.ts`
- Test: `tb3-mcp/test/orientation.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `normalize`, `cross`, `matFromColumns`, `matMul`, `transpose`, `matVec`, `angleBetweenDeg` from `./vec3.js`; `panTiltToMount`, `mountToPanTilt` from `./boresight.js`.
- Produces:
  - `solveOrientation(mountA: Vec3, enuA: Vec3, mountB: Vec3, enuB: Vec3): Mat3` — the mount→ENU rotation `R`.
  - `enuToPanTilt(R: Mat3, enuUnit: Vec3): { panDeg: number; tiltDeg: number }` — apply `Rᵀ` then invert boresight.
  - `separationDeg(enuA: Vec3, enuB: Vec3): number` — angle between two landmark directions (conditioning).
  - `resolvePanInRange(panDeg: number, panMin: number, panMax: number): number | null` — pick the ±360° equivalent that lands in range, else null.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/orientation.test.ts`

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/orientation.test.ts`
Expected: FAIL — cannot find module `../src/geo/orientation.js`.

- [ ] **Step 3: Write minimal implementation** — `tb3-mcp/src/geo/orientation.ts`

```typescript
import {
  Vec3, Mat3, normalize, cross, matFromColumns, matMul, transpose, matVec, angleBetweenDeg,
} from "./vec3.js";
import { mountToPanTilt } from "./boresight.js";

// TRIAD: build an orthonormal triad from each vector pair and align them.
// Returns R mapping mount-frame -> ENU-frame.
export function solveOrientation(mountA: Vec3, enuA: Vec3, mountB: Vec3, enuB: Vec3): Mat3 {
  const t1 = normalize(mountA);
  const t2 = normalize(cross(mountA, mountB));
  const t3 = cross(t1, t2);
  const M = matFromColumns(t1, t2, t3);

  const w1 = normalize(enuA);
  const w2 = normalize(cross(enuA, enuB));
  const w3 = cross(w1, w2);
  const W = matFromColumns(w1, w2, w3);

  return matMul(W, transpose(M)); // R = W · Mᵀ
}

// Apply Rᵀ (ENU->mount) to a target ENU unit vector, then invert the boresight.
export function enuToPanTilt(R: Mat3, enuUnit: Vec3): { panDeg: number; tiltDeg: number } {
  const mount = matVec(transpose(R), enuUnit);
  return mountToPanTilt(mount);
}

export function separationDeg(enuA: Vec3, enuB: Vec3): number {
  return angleBetweenDeg(enuA, enuB);
}

// Try pan, pan-360, pan+360; return the first within [min,max], else null.
export function resolvePanInRange(panDeg: number, panMin: number, panMax: number): number | null {
  for (const cand of [panDeg, panDeg - 360, panDeg + 360]) {
    if (cand >= panMin && cand <= panMax) return cand;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/orientation.test.ts`
Expected: PASS (4 tests). (Ensure the `resolvePanInRange` null case uses an actually-unreachable value like `135, -90, 90` per the note.)

- [ ] **Step 5: Commit**

```bash
cd tb3-mcp && git add src/geo/orientation.ts test/orientation.test.ts
git commit -m "feat(geo): TRIAD orientation solve, pointing, pan-range resolver"
```

---

### Task 5: Calibration profile + store (`src/calibration.ts`)

**Files:**
- Create: `tb3-mcp/src/calibration.ts`
- Test: `tb3-mcp/test/calibration.test.ts`

**Interfaces:**
- Consumes: `Mat3` from `./geo/vec3.js`.
- Produces:
  - `interface Sighting { lat: number; lon: number; height: number; label?: string; panDeg: number; tiltDeg: number }`
  - `interface CalibrationProfile { version: 1; rig?: { lat: number; lon: number; height: number }; sightings: Sighting[]; orientation?: number[] /*9, row-major*/; solvedAt?: string }`
  - `class CalibrationStore`:
    - `constructor(filePath: string)`
    - `load(): void` — reads+validates the file if present; on any failure leaves an empty profile (never throws).
    - `get(): CalibrationProfile` — deep copy of the current profile.
    - `setRigLocation(lat: number, lon: number, height: number): void` — sets rig, clears sightings + orientation, saves.
    - `addSighting(s: Sighting): number` — appends, keeps only the **last two**, clears orientation, saves; returns the new sighting count.
    - `setOrientation(R: Mat3, solvedAtIso: string): void` — stores flattened `R` + timestamp, saves.
    - `getOrientation(): Mat3 | undefined`
    - `clear(): void` — resets to empty profile, saves.
    - `isCalibrated(): boolean` — `rig` present **and** `orientation` present.

- [ ] **Step 1: Write the failing test** — `tb3-mcp/test/calibration.test.ts`

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { CalibrationStore } from "../src/calibration.js";
import { Mat3 } from "../src/geo/vec3.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir: string | null = null;
function tmpFile(): string {
  dir = mkdtempSync(join(tmpdir(), "tb3cal-"));
  return join(dir, "sub", "calibration.json"); // nested dir must be created on save
}
afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });

const R: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

describe("CalibrationStore", () => {
  it("starts uncalibrated and empty", () => {
    const s = new CalibrationStore(tmpFile());
    s.load();
    expect(s.isCalibrated()).toBe(false);
    expect(s.get().sightings).toEqual([]);
  });

  it("setRigLocation persists and clears sightings", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.addSighting({ lat: 1, lon: 2, height: 3, panDeg: 4, tiltDeg: 5 });
    s.setRigLocation(45, 10, 100);
    expect(s.get().rig).toEqual({ lat: 45, lon: 10, height: 100 });
    expect(s.get().sightings).toEqual([]);
    expect(existsSync(f)).toBe(true);
  });

  it("addSighting keeps only the last two", () => {
    const s = new CalibrationStore(tmpFile());
    s.addSighting({ lat: 1, lon: 1, height: 0, panDeg: 0, tiltDeg: 0 });
    s.addSighting({ lat: 2, lon: 2, height: 0, panDeg: 10, tiltDeg: 0 });
    const count = s.addSighting({ lat: 3, lon: 3, height: 0, panDeg: 20, tiltDeg: 0 });
    expect(count).toBe(2);
    expect(s.get().sightings.map((x) => x.lat)).toEqual([2, 3]);
  });

  it("setOrientation makes it calibrated and round-trips through a reload", () => {
    const f = tmpFile();
    const s = new CalibrationStore(f);
    s.setRigLocation(45, 10, 100);
    s.setOrientation(R, "2026-07-16T00:00:00.000Z");
    expect(s.isCalibrated()).toBe(true);

    const s2 = new CalibrationStore(f);
    s2.load();
    expect(s2.isCalibrated()).toBe(true);
    expect(s2.getOrientation()).toEqual(R);
    expect(s2.get().solvedAt).toBe("2026-07-16T00:00:00.000Z");
  });

  it("clear resets to empty", () => {
    const s = new CalibrationStore(tmpFile());
    s.setRigLocation(45, 10, 100);
    s.clear();
    expect(s.get().rig).toBeUndefined();
    expect(s.isCalibrated()).toBe(false);
  });

  it("a corrupt file loads as empty and does not throw", () => {
    const f = tmpFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{ this is not valid json");
    const s = new CalibrationStore(f);
    expect(() => s.load()).not.toThrow();
    expect(s.isCalibrated()).toBe(false);
    expect(s.get().sightings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: FAIL — cannot find module `../src/calibration.js`.

- [ ] **Step 3: Write minimal implementation** — `tb3-mcp/src/calibration.ts`

```typescript
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Mat3 } from "./geo/vec3.js";

const SightingSchema = z.object({
  lat: z.number(), lon: z.number(), height: z.number(),
  label: z.string().optional(),
  panDeg: z.number(), tiltDeg: z.number(),
});
export type Sighting = z.infer<typeof SightingSchema>;

const ProfileSchema = z.object({
  version: z.literal(1),
  rig: z.object({ lat: z.number(), lon: z.number(), height: z.number() }).optional(),
  sightings: z.array(SightingSchema).max(2).default([]),
  orientation: z.array(z.number()).length(9).optional(),
  solvedAt: z.string().optional(),
});
export type CalibrationProfile = z.infer<typeof ProfileSchema>;

function empty(): CalibrationProfile {
  return { version: 1, sightings: [] };
}

export class CalibrationStore {
  private profile: CalibrationProfile = empty();
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.profile = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.profile = ProfileSchema.parse(raw);
    } catch {
      // Missing/corrupt/invalid → start uncalibrated. Never throw.
      this.profile = empty();
    }
  }

  get(): CalibrationProfile {
    return JSON.parse(JSON.stringify(this.profile));
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.profile, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  setRigLocation(lat: number, lon: number, height: number): void {
    this.profile = { version: 1, rig: { lat, lon, height }, sightings: [] };
    this.save();
  }

  addSighting(s: Sighting): number {
    const sightings = [...this.profile.sightings, s].slice(-2);
    this.profile = { ...this.profile, sightings, orientation: undefined, solvedAt: undefined };
    this.save();
    return sightings.length;
  }

  setOrientation(R: Mat3, solvedAtIso: string): void {
    const flat = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    this.profile = { ...this.profile, orientation: flat, solvedAt: solvedAtIso };
    this.save();
  }

  getOrientation(): Mat3 | undefined {
    const o = this.profile.orientation;
    if (!o) return undefined;
    return [[o[0], o[1], o[2]], [o[3], o[4], o[5]], [o[6], o[7], o[8]]];
  }

  clear(): void {
    this.profile = empty();
    this.save();
  }

  isCalibrated(): boolean {
    return this.profile.rig !== undefined && this.profile.orientation !== undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/calibration.test.ts`
Expected: PASS. (Finish the corrupt-file test per the note before running.)

- [ ] **Step 5: Commit**

```bash
cd tb3-mcp && git add src/calibration.ts test/calibration.test.ts
git commit -m "feat(geo): calibration profile schema + atomic persisted store"
```

---

### Task 6: Extract the shared move helper (`src/move.ts`)

**Files:**
- Create: `tb3-mcp/src/move.ts`
- Modify: `tb3-mcp/src/tools.ts` (make `goto_angle` call the helper)
- Test: existing `tb3-mcp/test/tools.test.ts` must still pass (no new test file; the extraction is behavior-preserving and already covered).

**Interfaces:**
- Consumes: `Device` from `./device.js`; `Config` from `./config.js`; `stepsToDeg`, `degToSteps`, `applySign`, `checkPanTilt`, `checkSpeed`, `Limits` from `./angles.js`.
- Produces:
  - `interface MoveResult { arrived: boolean; pan_deg: number; tilt_deg: number }`
  - `async moveToUserAngle(device: Device, cfg: Config, panDeg: number, tiltDeg: number, speedDps?: number): Promise<MoveResult>` — validates limits+speed, applies signs, calls `device.gotoAngle` + `waitForArrival`, returns the arrival result. **Throws `Error(message)`** on any limit/speed violation, device rejection, or timeout.

- [ ] **Step 1: Write the implementation** — `tb3-mcp/src/move.ts`

(This is a refactor of the existing `goto_angle` body at `src/tools.ts:57-87`; the behavior is identical, so no new unit test — `tools.test.ts` is the safety net. Step 2 runs it.)

```typescript
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, degToSteps, applySign, checkPanTilt, checkSpeed, Limits } from "./angles.js";

export interface MoveResult {
  arrived: boolean;
  pan_deg: number;
  tilt_deg: number;
}

// Move to a USER-frame pan/tilt. Validates soft limits + speed, applies device
// signs, commands the move, and waits for arrival. Throws Error(message) on any
// violation, device rejection, or timeout — callers turn that into an MCP error.
export async function moveToUserAngle(
  device: Device, cfg: Config, panDeg: number, tiltDeg: number, speedDps?: number,
): Promise<MoveResult> {
  const limits: Limits = {
    panMin: cfg.panMin, panMax: cfg.panMax,
    tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
    maxSpeedDps: cfg.maxSpeedDps,
  };
  const lim = checkPanTilt(panDeg, tiltDeg, limits);
  if (!lim.ok) throw new Error(lim.error!);
  const spd = checkSpeed(speedDps, cfg.maxSpeedDps);
  if (!spd.ok) throw new Error(spd.error!);

  const devPan = applySign(panDeg, cfg.panSign);
  const devTilt = applySign(tiltDeg, cfg.tiltSign);
  await device.gotoAngle(devPan, devTilt, speedDps);

  const cur = device.getState();
  const distDeg = Math.max(
    Math.abs(devPan - stepsToDeg(cur.panSteps)),
    Math.abs(devTilt - stepsToDeg(cur.tiltSteps)),
  );
  const effSpeed = speedDps ?? cfg.maxSpeedDps;
  const timeoutMs = Math.max(5000, (distDeg / effSpeed) * 1000 * 3 + 3000);

  const final = await device.waitForArrival(degToSteps(devPan), degToSteps(devTilt), timeoutMs);
  return {
    arrived: true,
    pan_deg: Number(applySign(stepsToDeg(final.panSteps), cfg.panSign).toFixed(3)),
    tilt_deg: Number(applySign(stepsToDeg(final.tiltSteps), cfg.tiltSign).toFixed(3)),
  };
}
```

- [ ] **Step 2: Refactor `goto_angle` to use the helper** — edit `tb3-mcp/src/tools.ts`

Add the import near the top (after the existing `angles.js` import):

```typescript
import { moveToUserAngle } from "./move.js";
```

Replace the entire `goto_angle` handler body (the async function passed as the 3rd arg, currently `src/tools.ts:56-88`) with:

```typescript
    async ({ pan_deg, tilt_deg, speed_dps }) => {
      try {
        const result = await moveToUserAngle(device, cfg, pan_deg, tilt_deg, speed_dps);
        return text(JSON.stringify(result));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
```

Leave the tool's `description`/`inputSchema` unchanged. (The `limits`/`clamp` locals at the top of `registerTools` are still used by `jog`, so leave them.)

- [ ] **Step 3: Run the full test suite to verify nothing regressed**

Run: `cd tb3-mcp && npm test`
Expected: PASS — all existing suites green, including `tools.test.ts`'s `goto_angle` cases and the "lists all 8 tools" test (still 8 tools; geo tools are added in Task 7).

- [ ] **Step 4: Commit**

```bash
cd tb3-mcp && git add src/move.ts src/tools.ts
git commit -m "refactor(mcp): extract moveToUserAngle shared by goto_angle and geo tools"
```

---

### Task 7: Config + store wiring + calibration state tools (`src/geo-tools.ts`, part 1)

**Files:**
- Modify: `tb3-mcp/src/config.ts` (add `calibrationFile`)
- Create: `tb3-mcp/src/geo-tools.ts` (with `registerGeoTools` + the 4 state/query tools)
- Modify: `tb3-mcp/src/server.ts` (build `CalibrationStore`, call `registerGeoTools`)
- Test: `tb3-mcp/test/geo-tools.test.ts`

**Interfaces:**
- Consumes: `McpServer`; `Device`, `Config`; `stepsToDeg`, `applySign` from `./angles.js`; `CalibrationStore`, `Sighting` from `./calibration.js`.
- Produces:
  - `registerGeoTools(server: McpServer, device: Device, cfg: Config, store: CalibrationStore): void`
  - Tools added in this task: `set_rig_location`, `sight_landmark`, `get_calibration`, `clear_calibration`.
- Config: `calibrationFile?: string` (env `TB3_CALIBRATION_FILE`); default resolved in `server.ts` to `join(homedir(), ".tb3-mcp", "calibration.json")`.

- [ ] **Step 1: Add config field** — edit `tb3-mcp/src/config.ts`

In `ConfigSchema` (after `auxSign`), add:

```typescript
    calibrationFile: z.string().optional(),
```

In `loadConfig` (after the `set("auxSign", …)` line), add:

```typescript
  set("calibrationFile", env.TB3_CALIBRATION_FILE);
```

- [ ] **Step 2: Write the failing test** — `tb3-mcp/test/geo-tools.test.ts`

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { registerGeoTools } from "../src/geo-tools.js";
import { CalibrationStore } from "../src/calibration.js";

const PORT = 8795;
let mock: MockTb3 | null = null;
let dev: Device | null = null;
let dir: string | null = null;

async function harness() {
  dir = mkdtempSync(join(tmpdir(), "tb3geo-"));
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const store = new CalibrationStore(join(dir, "calibration.json"));
  store.load();
  const server = new McpServer({ name: "tb3-geo", version: "test" });
  registerGeoTools(server, dev, cfg, store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("geo tools — state/query", () => {
  it("sight_landmark refuses before a rig location is set", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({
      name: "sight_landmark",
      arguments: { lat: 45, lon: 10, height_m: 500 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/rig location/i);
  });

  it("set_rig_location then sight_landmark captures current pan/tilt", async () => {
    const { client } = await harness();
    mock!.setPosition(20 * 444.444, 5 * 444.444); // pan=20°, tilt=5°
    await new Promise((r) => setTimeout(r, 200));

    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    const res: any = await client.callTool({
      name: "sight_landmark",
      arguments: { lat: 46, lon: 11, height_m: 800, label: "peak" },
    });
    const body = JSON.parse(textOf(res));
    expect(body.slot).toBe(1);
    expect(body.pan_deg).toBeCloseTo(20, 0);
    expect(body.tilt_deg).toBeCloseTo(5, 0);
  });

  it("get_calibration and clear_calibration reflect state", async () => {
    const { client } = await harness();
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    let res: any = await client.callTool({ name: "get_calibration", arguments: {} });
    let body = JSON.parse(textOf(res));
    expect(body.calibrated).toBe(false);
    expect(body.rig).toEqual({ lat: 45, lon: 10, height: 100 });

    await client.callTool({ name: "clear_calibration", arguments: {} });
    res = await client.callTool({ name: "get_calibration", arguments: {} });
    body = JSON.parse(textOf(res));
    expect(body.rig).toBeUndefined();
    expect(body.calibrated).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/geo-tools.test.ts`
Expected: FAIL — cannot find module `../src/geo-tools.js`.

- [ ] **Step 4: Write minimal implementation** — `tb3-mcp/src/geo-tools.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { stepsToDeg, applySign } from "./angles.js";
import { CalibrationStore } from "./calibration.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

function currentUserPanTilt(device: Device, cfg: Config): { panDeg: number; tiltDeg: number; moving: boolean } {
  const s = device.getState();
  return {
    panDeg: applySign(stepsToDeg(s.panSteps), cfg.panSign),
    tiltDeg: applySign(stepsToDeg(s.tiltSteps), cfg.tiltSign),
    moving: s.moving,
  };
}

export function registerGeoTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore,
): void {
  server.registerTool(
    "set_rig_location",
    {
      description: "Set the rig's fixed geographic location (WGS84). Clears any prior sightings and calibration solution.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("rig latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("rig longitude, degrees"),
        height_m: z.number().finite().describe("rig height in meters (same datum as targets)"),
      },
    },
    async ({ lat, lon, height_m }) => {
      store.setRigLocation(lat, lon, height_m);
      return text(`rig location set to ${lat}, ${lon}, ${height_m}m; sightings cleared`);
    },
  );

  server.registerTool(
    "sight_landmark",
    {
      description: "Record the CURRENT pan/tilt as a sighting of a known landmark (aim first via the camera feed + jog). Two well-separated sightings are needed before solving.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("landmark latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("landmark longitude, degrees"),
        height_m: z.number().finite().describe("landmark height in meters (same datum as the rig)"),
        label: z.string().optional().describe("optional name for this landmark"),
      },
    },
    async ({ lat, lon, height_m, label }) => {
      if (store.get().rig === undefined) {
        return errText("set the rig location first (set_rig_location) before sighting landmarks");
      }
      const { panDeg, tiltDeg, moving } = currentUserPanTilt(device, cfg);
      const slot = store.addSighting({ lat, lon, height: height_m, label, panDeg, tiltDeg });
      const warn = moving ? " WARNING: the rig was still moving; pan/tilt may not be settled — re-sight when stopped." : "";
      return text(JSON.stringify({
        slot, pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
        note: `${slot}/2 sightings recorded.${warn}`,
      }));
    },
  );

  server.registerTool(
    "get_calibration",
    { description: "Report the current calibration profile: rig location, sightings, solved heading, timestamp, and whether it is calibrated.", inputSchema: {} },
    async () => {
      const p = store.get();
      return text(JSON.stringify({
        calibrated: store.isCalibrated(),
        rig: p.rig,
        sightings: p.sightings,
        solved_at: p.solvedAt ?? null,
      }, null, 2));
    },
  );

  server.registerTool(
    "clear_calibration",
    { description: "Erase the calibration profile (rig location, sightings, solution).", inputSchema: {} },
    async () => { store.clear(); return text("calibration cleared"); },
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/geo-tools.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the store + geo tools into the server** — edit `tb3-mcp/src/server.ts`

Add imports at the top:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { registerGeoTools } from "./geo-tools.js";
import { CalibrationStore } from "./calibration.js";
```

Change `buildApp` to accept and use a store. Its signature becomes:

```typescript
export function buildApp(device: Device, cfg: Config, store: CalibrationStore): Express {
```

Inside `buildApp`, immediately after the existing `registerTools(server, device, cfg);` call, add:

```typescript
        registerGeoTools(server, device, cfg, store);
```

In `main()`, after `const device = new Device(cfg);` and before `buildApp(...)`, build the store and pass it:

```typescript
  const calibFile = cfg.calibrationFile ?? join(homedir(), ".tb3-mcp", "calibration.json");
  const store = new CalibrationStore(calibFile);
  store.load();
  console.error(`calibration file: ${calibFile} (calibrated: ${store.isCalibrated()})`);
```

and update the `buildApp` call to `const app = buildApp(device, cfg, store);`.

- [ ] **Step 7: Fix the server tests for the new `buildApp` signature** — edit `tb3-mcp/test/server.test.ts` and `tb3-mcp/test/server-error.test.ts`

Wherever these tests call `buildApp(device, cfg)`, construct a throwaway store and pass it. Add near the other imports:

```typescript
import { CalibrationStore } from "../src/calibration.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

and replace each `buildApp(device, cfg)` call with:

```typescript
buildApp(device, cfg, new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3srv-")), "calibration.json")))
```

- [ ] **Step 8: Run the full suite**

Run: `cd tb3-mcp && npm test`
Expected: PASS — all suites, including the updated server tests and the new geo-tools tests.

- [ ] **Step 9: Commit**

```bash
cd tb3-mcp && git add src/config.ts src/geo-tools.ts src/server.ts test/geo-tools.test.ts test/server.test.ts test/server-error.test.ts
git commit -m "feat(geo): calibration state tools + store wiring (set_rig_location, sight_landmark, get/clear)"
```

---

### Task 8: Solve + pointing tools (`src/geo-tools.ts`, part 2)

**Files:**
- Modify: `tb3-mcp/src/geo-tools.ts` (add `solve_calibration`, `point_at`, `point_at_azel`)
- Test: `tb3-mcp/test/geo-tools.test.ts` (add solve/point cases)

**Interfaces:**
- Consumes (additional): `Geodetic`, `enuDirection`, `azElRange` from `./geo/wgs84.js`; `solveOrientation`, `enuToPanTilt`, `separationDeg`, `resolvePanInRange` from `./geo/orientation.js`; `panTiltToMount` from `./geo/boresight.js`; `Vec3`, `deg2rad` from `./geo/vec3.js`; `moveToUserAngle` from `./move.js`.
- Produces: tools `solve_calibration`, `point_at`, `point_at_azel` added to `registerGeoTools`.

- [ ] **Step 1: Write the failing test** — append to `tb3-mcp/test/geo-tools.test.ts`

```typescript
describe("geo tools — solve + point", () => {
  // Build a self-consistent calibration by sighting two targets AT the pan/tilt
  // the mock currently reports, so the solved R maps those ENU dirs to those
  // aims. Then point_at a third target and assert the mock was driven to a
  // pan/tilt consistent with re-sighting it.
  async function calibrate(client: any, mock: MockTb3) {
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    // Sighting A: aim pan=0,tilt=2 at a landmark to the north-ish
    mock.setPosition(0 * 444.444, 2 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 46, lon: 10, height_m: 100, label: "N" } });
    // Sighting B: aim pan=80,tilt=1 at a landmark to the east-ish
    mock.setPosition(80 * 444.444, 1 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "sight_landmark", arguments: { lat: 45, lon: 11.4, height_m: 100, label: "E" } });
  }

  it("solve_calibration reports heading + separation and marks calibrated", async () => {
    const { client, store } = await harness();
    await calibrate(client, mock!);
    const res: any = await client.callTool({ name: "solve_calibration", arguments: {} });
    const body = JSON.parse(textOf(res));
    expect(body).toHaveProperty("heading_deg");
    expect(body).toHaveProperty("separation_deg");
    expect(body.separation_deg).toBeGreaterThan(15);
    expect(store.isCalibrated()).toBe(true);
  });

  it("point_at refuses before calibration", async () => {
    const { client } = await harness();
    await client.callTool({ name: "set_rig_location", arguments: { lat: 45, lon: 10, height_m: 100 } });
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not calibrated/i);
  });

  it("point_at drives the rig and reports az/el/range/pan/tilt", async () => {
    const { client } = await harness();
    await calibrate(client, mock!);
    await client.callTool({ name: "solve_calibration", arguments: {} });

    // Re-sighting landmark A (pan≈0,tilt≈2). point_at that same point:
    const res: any = await client.callTool({
      name: "point_at", arguments: { lat: 46, lon: 10, height_m: 100 },
    });
    const body = JSON.parse(textOf(res));
    expect(body.pan_deg).toBeCloseTo(0, 0);
    expect(body.tilt_deg).toBeCloseTo(2, 0);
    expect(body.azimuth_deg).toBeCloseTo(0, 0); // due north
    expect(body.range_m).toBeGreaterThan(1000);
    // the mock recorded a goto to the device-frame equivalent
    expect(mock!.lastGoto).not.toBeNull();
  });

  it("point_at_azel points and returns finite pan/tilt", async () => {
    const { client } = await harness();
    await calibrate(client, mock!);
    await client.callTool({ name: "solve_calibration", arguments: {} });
    const res: any = await client.callTool({
      name: "point_at_azel", arguments: { azimuth_deg: 5, elevation_deg: 3 },
    });
    expect(res.isError ?? false).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(Number.isFinite(body.pan_deg)).toBe(true);
    expect(Number.isFinite(body.tilt_deg)).toBe(true);
    expect(mock!.lastGoto).not.toBeNull();
  });
});

describe("reachablePanTilt (reachability)", () => {
  it("passes an in-range pan/tilt through", () => {
    expect(reachablePanTilt(45, 10, -180, 180, -90, 90)).toEqual({ pan: 45, tilt: 10 });
  });
  it("wraps pan into range", () => {
    const r = reachablePanTilt(200, 10, -180, 180, -90, 90) as any;
    expect("error" in r).toBe(false);
    expect(r.pan).toBeCloseTo(-160, 9);
  });
  it("refuses a tilt below the range (below horizon)", () => {
    const r = reachablePanTilt(0, -95, -180, 180, -90, 90) as any;
    expect(r.error).toMatch(/tilt/i);
  });
  it("refuses an unreachable pan", () => {
    const r = reachablePanTilt(135, 0, -90, 90, -90, 90) as any;
    expect(r.error).toMatch(/pan/i);
  });
});
```

> This test file uses `reachablePanTilt` directly — **update the import at the top of `test/geo-tools.test.ts`** (added in Task 7) to also import it:
> `import { registerGeoTools, reachablePanTilt } from "../src/geo-tools.js";`
>
> Reachability is thus covered deterministically by `reachablePanTilt` + `resolvePanInRange` (Task 4) unit tests; the `point_at`/`point_at_azel` tool tests stay on the happy path + "not calibrated" guard to avoid brittle live-geometry assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/geo-tools.test.ts`
Expected: FAIL — `solve_calibration` / `point_at` / `point_at_azel` are not registered tools.

- [ ] **Step 3: Add the three tools** — edit `tb3-mcp/src/geo-tools.ts`

Add these imports at the top (alongside the existing ones):

```typescript
import { Geodetic, enuDirection, azElRange } from "./geo/wgs84.js";
import { solveOrientation, enuToPanTilt, separationDeg, resolvePanInRange } from "./geo/orientation.js";
import { panTiltToMount } from "./geo/boresight.js";
import { Vec3, Mat3, deg2rad } from "./geo/vec3.js";
import { moveToUserAngle } from "./move.js";
```

Add an **exported** shared helper above `registerGeoTools` (exported so it can be unit-tested directly):

```typescript
// Resolve pan into range (trying ±360°), then verify tilt is reachable.
// Returns the movable pan/tilt, or an { error } message.
export function reachablePanTilt(
  panDeg: number, tiltDeg: number,
  panMin: number, panMax: number, tiltMin: number, tiltMax: number,
): { pan: number; tilt: number } | { error: string } {
  const pan = resolvePanInRange(panDeg, panMin, panMax);
  if (pan === null) {
    return { error: `computed pan ${panDeg.toFixed(2)}° is outside the reachable pan range [${panMin}, ${panMax}] (even after ±360°)` };
  }
  if (tiltDeg < tiltMin || tiltDeg > tiltMax) {
    return { error: `computed tilt ${tiltDeg.toFixed(2)}° is outside the reachable tilt range [${tiltMin}, ${tiltMax}] — target is below the horizon or too high` };
  }
  return { pan, tilt: tiltDeg };
}
```

Then register the three tools inside `registerGeoTools` (after `clear_calibration`):

```typescript
  server.registerTool(
    "solve_calibration",
    { description: "Solve the mount orientation from the two recorded sightings (TRIAD). Reports heading, base tilt, and landmark separation; persists the solution.", inputSchema: {} },
    async () => {
      const p = store.get();
      if (p.rig === undefined) return errText("set the rig location first (set_rig_location)");
      if (p.sightings.length < 2) return errText(`need two sightings to solve; have ${p.sightings.length}`);

      const rig: Geodetic = p.rig;
      const [sa, sb] = p.sightings;
      const enuA = enuDirection(rig, { lat: sa.lat, lon: sa.lon, height: sa.height }).unit;
      const enuB = enuDirection(rig, { lat: sb.lat, lon: sb.lon, height: sb.height }).unit;
      const mountA = panTiltToMount(sa.panDeg, sa.tiltDeg);
      const mountB = panTiltToMount(sb.panDeg, sb.tiltDeg);

      const sep = separationDeg(enuA, enuB);
      const R = solveOrientation(mountA, enuA, mountB, enuB);
      store.setOrientation(R, new Date().toISOString());

      // Heading = ENU azimuth the boresight points at pan=0,tilt=0, i.e. the
      // direction of the mount-forward (+Y) axis = second column of R.
      const headingUnit = matForward(R);
      let heading = (Math.atan2(headingUnit[0], headingUnit[1]) * 180) / Math.PI;
      if (heading < 0) heading += 360;
      // Base tilt = how far the mount-up (+Z) axis leans from true vertical
      // (0 if the tripod is perfectly level) = third column of R.
      const upUnit = matUp(R);
      const baseTilt = 90 - (Math.asin(Math.max(-1, Math.min(1, upUnit[2]))) * 180) / Math.PI;

      const warn = sep < 15 ? " WARNING: landmarks are close together — the solution is ill-conditioned; choose landmarks farther apart in azimuth." : "";
      return text(JSON.stringify({
        heading_deg: Number(heading.toFixed(2)),
        base_tilt_deg: Number(baseTilt.toFixed(2)),
        separation_deg: Number(sep.toFixed(1)),
        note: `solved from 2 sightings.${warn}`,
      }));
    },
  );

  server.registerTool(
    "point_at",
    {
      description: "Point the rig at a geographic target (WGS84 lat/lon/height). Requires a solved calibration. Blocks until arrival.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("target latitude, degrees"),
        lon: z.number().min(-180).max(180).describe("target longitude, degrees"),
        height_m: z.number().finite().describe("target height in meters (same datum as the rig)"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ lat, lon, height_m, speed_dps }) => {
      if (!store.isCalibrated()) return errText("not calibrated — set_rig_location, sight two landmarks, then solve_calibration");
      const rig = store.get().rig!;
      const target: Geodetic = { lat, lon, height: height_m };
      const { unit } = enuDirection(rig, target);
      const R = store.getOrientation()!;
      const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
      const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
      if ("error" in reach) return errText(reach.error);
      const azel = azElRange(rig, target);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps);
        return text(JSON.stringify({
          azimuth_deg: Number(azel.azimuth.toFixed(2)),
          elevation_deg: Number(azel.elevation.toFixed(2)),
          range_m: Math.round(azel.range),
          pan_deg: moved.pan_deg,
          tilt_deg: moved.tilt_deg,
        }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  server.registerTool(
    "point_at_azel",
    {
      description: "Point the rig at an absolute azimuth/elevation (degrees), bypassing geo. Requires a solved calibration.",
      inputSchema: {
        azimuth_deg: z.number().describe("azimuth from true north, degrees (0=N, 90=E)"),
        elevation_deg: z.number().min(-90).max(90).describe("elevation above horizontal, degrees"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ azimuth_deg, elevation_deg, speed_dps }) => {
      if (!store.isCalibrated()) return errText("not calibrated — set_rig_location, sight two landmarks, then solve_calibration");
      const az = deg2rad(azimuth_deg), el = deg2rad(elevation_deg);
      const unit: Vec3 = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
      const R = store.getOrientation()!;
      const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
      const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
      if ("error" in reach) return errText(reach.error);
      try {
        const moved = await moveToUserAngle(device, cfg, reach.pan, reach.tilt, speed_dps);
        return text(JSON.stringify({ pan_deg: moved.pan_deg, tilt_deg: moved.tilt_deg }));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );
```

Add these two tiny helpers at the bottom of the file (used by `solve_calibration` for reporting). `Mat3` is already imported in the top import block edited above:

```typescript
// The mount-forward (+Y) axis image in ENU = second column of R.
function matForward(R: Mat3): Vec3 { return [R[0][1], R[1][1], R[2][1]]; }
// The mount-up (+Z) axis image in ENU = third column of R.
function matUp(R: Mat3): Vec3 { return [R[0][2], R[1][2], R[2][2]]; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/geo-tools.test.ts`
Expected: PASS (all state + solve + point cases).

- [ ] **Step 5: Run the full suite + build**

Run: `cd tb3-mcp && npm test && npm run build`
Expected: PASS on all suites; `tsc` compiles with no errors.

- [ ] **Step 6: Commit**

```bash
cd tb3-mcp && git add src/geo-tools.ts test/geo-tools.test.ts
git commit -m "feat(geo): solve_calibration + point_at + point_at_azel tools"
```

---

### Task 9: README + docs

**Files:**
- Modify: `tb3-mcp/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the geo tools and calibration flow** — edit `tb3-mcp/README.md`

Add a "Geo-pointing (layer 2)" section that lists the seven tools (`set_rig_location`, `sight_landmark`, `solve_calibration`, `point_at`, `point_at_azel`, `get_calibration`, `clear_calibration`), the calibration workflow (set rig location → sight two well-separated landmarks via the live feed + `jog` → `solve_calibration` → `point_at`), the `calibrationFile` config / `TB3_CALIBRATION_FILE` env var (default `~/.tb3-mcp/calibration.json`), and the documented assumptions (heights share one datum; refraction and lever-arm are out of scope). Add a config-table row:

```
| calibrationFile | `~/.tb3-mcp/calibration.json` | where the calibration profile is persisted (env `TB3_CALIBRATION_FILE`) |
```

- [ ] **Step 2: Commit**

```bash
cd tb3-mcp && git add README.md
git commit -m "docs(geo): document geo-pointing tools and calibration flow"
```

---

## Plan Self-Review

**Spec coverage:**
- WGS84→ENU curvature-aware math → Tasks 1, 2. ✅
- Boresight convention → Task 3. ✅
- Two-landmark TRIAD solve for full mount orientation → Task 4. ✅
- Persisted calibration profile (atomic, zod, corrupt→uncalibrated, version) → Task 5. ✅
- Seven MCP tools → Tasks 7 (four) + 8 (three). ✅
- Reachability (pan-wrap + tilt limits, reuse `checkPanTilt`) → `resolvePanInRange` (Task 4) + `reachablePanTilt` (Task 8); `moveToUserAngle` reuses `checkPanTilt` (Task 6). ✅
- Quality/conditioning warning + moving-sighting warning → Task 8 (`separation_deg`) + Task 7 (moving warning). ✅
- Human-in-the-loop aiming (tool snapshots current pan/tilt) → `sight_landmark` (Task 7). ✅
- Height datum documented → Task 2 code comment + Task 9 README. ✅
- Testing strategy (synthetic ground-truth + mock integration) → orientation Task 4 end-to-end test + geo-tools Task 8 integration. ✅
- Refraction/lever-arm out of scope → documented (Task 9). ✅

**Placeholder scan:** clean. Every code and test block is complete and self-consistent (the earlier "fix this" notes in Task 4's `resolvePanInRange` null case, Task 5's corrupt-file test, and Task 8's `solve_calibration` have been resolved into final code).

**Type consistency:** `Vec3`/`Mat3` used identically across Tasks 1–8; `Geodetic` shape `{lat,lon,height}` consistent (tools accept `height_m` and map to `height`); `solveOrientation`/`enuToPanTilt`/`resolvePanInRange`/`separationDeg` signatures match between Task 4 definitions and Task 8 uses; `moveToUserAngle` signature matches between Task 6 and Task 8; `CalibrationStore` method names (`load`/`get`/`setRigLocation`/`addSighting`/`setOrientation`/`getOrientation`/`clear`/`isCalibrated`) match between Task 5 and Tasks 7–8.
