# Sun Avoidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on supervisor that keeps the camera boresight out of an exclusion cone around the sun, parking the rig away from the sun when the boresight approaches it.

**Architecture:** Pure solar-position math (`sun.ts`) + pure guard predicates and a park-path planner (`sunguard.ts`) + one stateful `SunSupervisor` (per rig, daemon-wide) that ticks on an injected scheduler, holds all state, and is the top motion authority. Phase 1 (`sun.ts` + `get_sun`) is independently shippable and unblocks a camera-off shadow test that measures calibration+clock error against the sun and sizes the cone. Phase 2 is the guard and supervisor.

**Tech Stack:** TypeScript/Node ESM, zod config, vitest.

## Global Constraints

- ESM: every relative import ends in `.js`. No `any` in application code.
- SI units internally; **degrees at boundaries**. ENU is `[E, N, U]`. Azimuth is from true north, clockwise; `sunEnu = [cos(el)·sin(az), cos(el)·cos(az), sin(el)]` — matches `azElRange`.
- `R` maps **mount→ENU**. `boresightEnu(R, pan, tilt)` gives the boresight ENU unit vector. `enuToPanTilt(R, u)` returns **user-frame** pan/tilt. Telemetry pan/tilt are user-frame via `applySign(stepsToDeg(steps), sign)`. All guard math is in **user frame**; device-frame conversion happens exactly once, inside `moveToUserAngle`, where the park drives the actuator. Never re-apply signs in the guard.
- **Refusing to move is always survivable; moving on bad data is not.** Every ambiguous case fails to *stop*, never to a guessed slew.
- **Fail-closed:** stale telemetry or a failed sun computation → stop motion, refuse new motion (set the lockout), and **do NOT park** (a park needs a known boresight).
- `STEPS_PER_DEG = 444.444`. `maxJogDps = 19.0` (measured). The rig pushes telemetry at ~5 Hz.
- One `SunSupervisor` per rig, daemon-wide: construct it once in `main()`, thread it into `buildApp` (a per-connection supervisor would fight over the motors).
- Tests: vitest, `fileParallelism: false` (the mock binds real ports). Ports **8791–8800 are taken**; new test files that bind a port use **8801** (sun tools) and **8802** (supervisor). Pure modules (`sun.ts`, `sunguard.ts`) bind no port.
- Reuse, do not duplicate: `boresightEnu`, `enuToPanTilt`, `limitHorizonMs`, `moveToUserAngle`, `Scheduler`/`realScheduler`, `angleBetweenDeg` already exist.
- **Build no IMU/GPS code.** Keep three inputs behind seams: **time** via the injected `now: () => number`; **attitude** localized to one supervisor method that calls `boresightEnu(R, pan, tilt)`; **position** read from `CalibrationStore`. Nothing more.
- Commits: conventional-commit messages. If a commit fails on 1Password SSH signing (`op-ssh-sign` / expired cache), leave the work staged and report "commit blocked on signing" — do not retry or work around it.

---

# PHASE 1 — solar position + inspection (independently shippable)

Delivers `sun.ts`, the `get_sun` tool, and the shadow-test enablement. Depends only on `point_at_azel`, which layer 2 already ships. After Phase 1 you can run the camera-off shadow test to measure `R`+clock error and size the cone.

### Task 1: `src/geo/sun.ts` — solar position (pure)

**Files:**
- Create: `tb3-mcp/src/geo/sun.ts`
- Test: `tb3-mcp/test/sun.test.ts`

**Interfaces:**
- Consumes: `Geodetic` from `./wgs84.js`; `Vec3`, `deg2rad`, `rad2deg` from `./vec3.js`.
- Produces:
  - `sunAzEl(rig: Geodetic, tMs: number): { azDeg: number; elDeg: number }` — `tMs` is Unix epoch milliseconds (`Date.now()`); azimuth from true north CW in `[0,360)`, elevation in `[-90,90]`, refraction-corrected.
  - `sunEnu(rig: Geodetic, tMs: number): Vec3` — sun direction as an ENU unit vector.

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/sun.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/sun.test.ts`
Expected: FAIL — `sunAzEl`/`sunEnu` not found.

- [ ] **Step 3: Write the implementation**

```ts
// tb3-mcp/src/geo/sun.ts
import { Geodetic } from "./wgs84.js";
import { Vec3, deg2rad, rad2deg } from "./vec3.js";

// NOAA solar-position algorithm (the one the NOAA Solar Calculator uses).
// Input tMs is Unix epoch milliseconds; output azimuth is from true north,
// clockwise, [0,360); elevation is refraction-corrected degrees.
export function sunAzEl(rig: Geodetic, tMs: number): { azDeg: number; elDeg: number } {
  const jd = tMs / 86400000 + 2440587.5;      // Julian Day from Unix ms
  const jc = (jd - 2451545.0) / 36525.0;      // Julian centuries since J2000.0

  const gml = mod360(280.46646 + jc * (36000.76983 + jc * 0.0003032)); // geom mean long (deg)
  const gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);          // geom mean anomaly (deg)
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);     // eccentricity

  const gmaR = deg2rad(gma);
  const ctr =
    Math.sin(gmaR) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(2 * gmaR) * (0.019993 - 0.000101 * jc) +
    Math.sin(3 * gmaR) * 0.000289;            // equation of centre (deg)
  const trueLong = gml + ctr;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega)); // apparent long (deg)

  const seconds = 21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813));
  const obl = 23.0 + (26.0 + seconds / 60.0) / 60.0;
  const oblCorr = obl + 0.00256 * Math.cos(deg2rad(omega));               // corrected obliquity (deg)

  const declR = Math.asin(Math.sin(deg2rad(oblCorr)) * Math.sin(deg2rad(appLong)));

  const y = Math.tan(deg2rad(oblCorr / 2)) ** 2;
  const gmlR = deg2rad(gml);
  const eot =
    4 *
    rad2deg(
      y * Math.sin(2 * gmlR) -
        2 * ecc * Math.sin(gmaR) +
        4 * ecc * y * Math.sin(gmaR) * Math.cos(2 * gmlR) -
        0.5 * y * y * Math.sin(4 * gmlR) -
        1.25 * ecc * ecc * Math.sin(2 * gmaR),
    ); // equation of time (minutes)

  // Minutes past UTC midnight for this instant.
  const dayMs = ((tMs % 86400000) + 86400000) % 86400000;
  const minutes = dayMs / 60000;
  const tst = mod(minutes + eot + 4 * rig.lon, 1440); // true solar time (min)
  let ha = tst / 4 - 180;                             // hour angle (deg)
  if (ha < -180) ha += 360;

  const latR = deg2rad(rig.lat);
  const haR = deg2rad(ha);
  const zenith = Math.acos(
    Math.min(1, Math.max(-1, Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR))),
  );
  let elDeg = 90 - rad2deg(zenith);
  elDeg += refractionDeg(elDeg);

  // Azimuth from north, clockwise.
  const den = Math.cos(latR) * Math.sin(zenith);
  let azDeg: number;
  if (Math.abs(den) < 1e-9) {
    azDeg = 180;
  } else {
    const c = Math.min(1, Math.max(-1, (Math.sin(latR) * Math.cos(zenith) - Math.sin(declR)) / den));
    const acc = rad2deg(Math.acos(c));
    azDeg = ha > 0 ? mod360(acc + 180) : mod360(540 - acc);
  }
  return { azDeg, elDeg };
}

export function sunEnu(rig: Geodetic, tMs: number): Vec3 {
  const { azDeg, elDeg } = sunAzEl(rig, tMs);
  const az = deg2rad(azDeg);
  const el = deg2rad(elDeg);
  const ce = Math.cos(el);
  return [ce * Math.sin(az), ce * Math.cos(az), Math.sin(el)];
}

// Atmospheric refraction (deg), significant only near the horizon.
function refractionDeg(elDeg: number): number {
  if (elDeg > 85) return 0;
  const te = Math.tan(deg2rad(elDeg));
  let sec: number;
  if (elDeg > 5) sec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elDeg > -0.575) sec = 1735 + elDeg * (-518.2 + elDeg * (103.4 + elDeg * (-12.79 + elDeg * 0.711)));
  else sec = -20.772 / te;
  return sec / 3600;
}

function mod(a: number, n: number): number { return ((a % n) + n) % n; }
function mod360(a: number): number { return mod(a, 360); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/sun.test.ts`
Expected: PASS (all in `test/sun.test.ts`). If the Phoenix fixture is off by >0.2°, confirm against the NOAA calculator before touching the algorithm.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/geo/sun.ts tb3-mcp/test/sun.test.ts
git commit -m "feat(sun): NOAA solar-position (sunAzEl, sunEnu), pure and tested"
```

---

### Task 2: `get_sun` MCP tool

**Files:**
- Create: `tb3-mcp/src/sun-tools.ts`
- Modify: `tb3-mcp/src/server.ts` (import + register)
- Modify: `tb3-mcp/test/server.test.ts:45` (tool count 19 → 20)
- Test: `tb3-mcp/test/sun-tools.test.ts`

**Interfaces:**
- Consumes: `sunAzEl` from `./geo/sun.js`; `boresightEnu` from `./track/control.js`; `angleBetweenDeg` from `./geo/vec3.js`; `stepsToDeg`, `applySign` from `./angles.js`; `Device`, `Config`, `CalibrationStore`.
- Produces: `registerSunTools(server, device, cfg, store)` registering **`get_sun`**. (Phase 2 adds a `supervisor` param and `set_sun_guard`, and extends `get_sun` with guard state.)

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/sun-tools.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { registerSunTools } from "../src/sun-tools.js";

const PORT = 8801;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

async function harness() {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  const store = new CalibrationStore("/tmp/tb3-suntest-DOES-NOT-EXIST.json"); store.load();
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerSunTools(server, dev, cfg, store);
  const client = new Client({ name: "c", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("get_sun", () => {
  it("reports sun az/el and the assumed UTC", async () => {
    const client = await harness();
    const res = await client.callTool({ name: "get_sun", arguments: {} });
    const p = JSON.parse(textOf(res));
    expect(typeof p.azimuth_deg).toBe("number");
    expect(typeof p.elevation_deg).toBe("number");
    expect(typeof p.assumed_utc).toBe("string");
    // Uncalibrated → no boresight separation.
    expect(p.boresight_separation_deg).toBeNull();
    expect(p.calibrated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/sun-tools.test.ts`
Expected: FAIL — `registerSunTools` not found.

- [ ] **Step 3: Write the implementation**

```ts
// tb3-mcp/src/sun-tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "./device.js";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { sunAzEl, sunEnu } from "./geo/sun.js";
import { boresightEnu } from "./track/control.js";
import { angleBetweenDeg } from "./geo/vec3.js";
import { stepsToDeg, applySign } from "./angles.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function registerSunTools(
  server: McpServer, device: Device, cfg: Config, store: CalibrationStore,
): void {
  server.registerTool(
    "get_sun",
    { description: "Report the sun's azimuth/elevation now, the assumed UTC, and the boresight→sun separation (when calibrated). Read-only.", inputSchema: {} },
    async () => {
      const nowMs = Date.now();
      const p = store.get();
      let azimuth_deg: number | null = null;
      let elevation_deg: number | null = null;
      let boresight_separation_deg: number | null = null;
      const calibrated = store.isCalibrated();

      if (p.rig) {
        const { azDeg, elDeg } = sunAzEl(p.rig, nowMs);
        azimuth_deg = Number(azDeg.toFixed(3));
        elevation_deg = Number(elDeg.toFixed(3));
        const R = store.getOrientation();
        if (R) {
          const d = device.getState();
          const panDeg = applySign(stepsToDeg(d.panSteps), cfg.panSign);
          const tiltDeg = applySign(stepsToDeg(d.tiltSteps), cfg.tiltSign);
          const sep = angleBetweenDeg(boresightEnu(R, panDeg, tiltDeg), sunEnu(p.rig, nowMs));
          boresight_separation_deg = Number(sep.toFixed(3));
        }
      }

      return text(JSON.stringify({
        calibrated,
        assumed_utc: new Date(nowMs).toISOString(),
        azimuth_deg,
        elevation_deg,
        above_horizon: elevation_deg === null ? null : elevation_deg > 0,
        boresight_separation_deg,
        rig_location_set: p.rig !== undefined,
      }, null, 2));
    },
  );
}
```

- [ ] **Step 4: Wire into the server**

In `tb3-mcp/src/server.ts`, add the import beside the others:
```ts
import { registerSunTools } from "./sun-tools.js";
```
and register it inside `buildApp`'s per-connection block, after `registerTrackTools(server, session);`:
```ts
      registerSunTools(server, device, cfg, store);
```

In `tb3-mcp/test/server.test.ts:45`, bump the count:
```ts
    expect(tools.length).toBe(20); // 8 base + 7 geo + 4 tracking + 1 sun (get_sun)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tb3-mcp && npx vitest run test/sun-tools.test.ts test/server.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/sun-tools.ts tb3-mcp/src/server.ts tb3-mcp/test/sun-tools.test.ts tb3-mcp/test/server.test.ts
git commit -m "feat(sun): get_sun tool — sun az/el, assumed UTC, boresight separation"
```

---

### Task 3: shadow-test enablement — probe script + README

**Files:**
- Create: `tb3-mcp/scripts/sun-guard-probe.mjs`
- Modify: `tb3-mcp/README.md` (add a Sun section documenting the shadow test)

**Interfaces:**
- Consumes: the compiled `../dist/geo/sun.js` (run `npm run build` first). No new exports.

- [ ] **Step 1: Write the probe script**

```js
// tb3-mcp/scripts/sun-guard-probe.mjs
//
// Shadow test: measure the combined calibration + clock error against the sun,
// which is the number that sizes the sun-guard exclusion cone.
//
// Requires a build first (the probe imports the compiled solar-position code so
// the math is never duplicated):   npm run build
//
// Usage (from tb3-mcp/):  node scripts/sun-guard-probe.mjs <LAT> <LON> [HEIGHT_M=0]
//   e.g. node scripts/sun-guard-probe.mjs 33.4484 -112.074
//
// RUN WITH THE CAMERA REMOVED. The rig points AT the sun; a lens there burns.

import { sunAzEl } from "../dist/geo/sun.js";

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const height = Number(process.argv[4] ?? 0);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error("usage: node scripts/sun-guard-probe.mjs <LAT> <LON> [HEIGHT_M=0]");
  console.error("  (run `npm run build` first — this imports dist/geo/sun.js)");
  process.exit(1);
}

const now = Date.now();
const { azDeg, elDeg } = sunAzEl({ lat, lon, height }, now);

console.log(`\nSun right now (${new Date(now).toISOString()}):`);
console.log(`  azimuth   ${azDeg.toFixed(2)}°  (from true north, clockwise)`);
console.log(`  elevation ${elDeg.toFixed(2)}°`);
if (elDeg <= 0) {
  console.log(`\n  The sun is below the horizon — no shadow test now.`);
  process.exit(0);
}
console.log(`\n--- shadow test (CAMERA REMOVED) ---`);
console.log(`1. Confirm the daemon's clock: this UTC must match the real world.`);
console.log(`2. Point the rig at the sun via your MCP client:`);
console.log(`     point_at_azel  azimuth_deg=${azDeg.toFixed(2)}  elevation_deg=${elDeg.toFixed(2)}`);
console.log(`3. Aim a straight rod/edge along the boresight and read its shadow.`);
console.log(`   Dead-on the sun, the shadow collapses to a point.`);
console.log(`4. Any offset IS your combined R + clock error, in degrees.`);
console.log(`   A point-shadow validates BOTH R and the clock at once (a 1-hour`);
console.log(`   clock error would read as ~15° of azimuth offset).`);
console.log(`5. Size the cone:  R_error + FOV/2 + ~0.5° tracking + 0.27° sun + margin.`);
console.log(`   Set it with:  set_sun_guard cone_deg=<that>   (Phase 2)\n`);
```

- [ ] **Step 2: Verify it runs**

Run: `cd tb3-mcp && npm run build && node scripts/sun-guard-probe.mjs 33.4484 -112.074`
Expected: prints the sun's az/el for now and the shadow-test steps. (Elevation should be positive if run in daytime; the exact numbers depend on when it runs.)

- [ ] **Step 3: Document in the README**

Add a `## Sun position and the shadow test` section to `tb3-mcp/README.md` that:
- Explains `get_sun` (sun az/el, assumed UTC, boresight separation).
- Gives the shadow-test procedure exactly as the probe prints it, stressing **camera removed**.
- States plainly: the exclusion cone is sized from the measured offset, and the assumed UTC must be correct because a clock error moves the sun with no other symptom.

- [ ] **Step 4: Commit**

```bash
git add tb3-mcp/scripts/sun-guard-probe.mjs tb3-mcp/README.md
git commit -m "docs(sun): shadow-test probe + README — measure R+clock error, size the cone"
```

**Phase 1 ends here — shippable. Run the shadow test on the first clear day before Phase 2 guards a lens.**

---

# PHASE 2 — the guard and the supervisor

### Task 4: config keys

**Files:**
- Modify: `tb3-mcp/src/config.ts` (schema + env)
- Test: `tb3-mcp/test/config.test.ts` (add cases if the file exists; otherwise add to an existing config test)

**Interfaces:**
- Produces on `Config`: `sunGuardEnabled: boolean` (default `true`), `sunConeDeg: number` (default `25`), `parkTiltDeg: number` (default `-20`), `sunGuardTickHz: number` (default `10`).

- [ ] **Step 1: Write the failing test**

```ts
// add to tb3-mcp/test/config.test.ts (import loadConfig if not already)
it("has sun-guard defaults and env overrides", () => {
  const d = loadConfig(undefined, {});
  expect(d.sunGuardEnabled).toBe(true);
  expect(d.sunConeDeg).toBe(25);
  expect(d.parkTiltDeg).toBe(-20);
  expect(d.sunGuardTickHz).toBe(10);
  const o = loadConfig(undefined, { TB3_SUN_CONE_DEG: "18", TB3_PARK_TILT_DEG: "-30", TB3_SUN_GUARD_ENABLED: "0", TB3_SUN_GUARD_TICK_HZ: "5" });
  expect(o.sunConeDeg).toBe(18);
  expect(o.parkTiltDeg).toBe(-30);
  expect(o.sunGuardEnabled).toBe(false);
  expect(o.sunGuardTickHz).toBe(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/config.test.ts`
Expected: FAIL — keys undefined.

- [ ] **Step 3: Implement — schema keys**

In `tb3-mcp/src/config.ts`, add these keys to the `z.object({...})` after `jogVectorTtlMs`:
```ts
    sunGuardEnabled: z.boolean().default(true),
    sunConeDeg: z.number().positive().max(90).default(25),
    parkTiltDeg: z.number().default(-20),
    sunGuardTickHz: z.number().positive().max(50).default(10),
```

- [ ] **Step 4: Implement — env overrides**

Add a boolean helper near `num()` in `config.ts`:
```ts
function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return !(v === "0" || v.toLowerCase() === "false");
}
```
and in `loadConfig`, after the `set("jogVectorTtlMs", ...)` line:
```ts
  set("sunGuardEnabled", bool(env.TB3_SUN_GUARD_ENABLED));
  set("sunConeDeg", num(env.TB3_SUN_CONE_DEG));
  set("parkTiltDeg", num(env.TB3_PARK_TILT_DEG));
  set("sunGuardTickHz", num(env.TB3_SUN_GUARD_TICK_HZ));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/config.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/config.ts tb3-mcp/test/config.test.ts
git commit -m "feat(sun): config keys — sunGuardEnabled, sunConeDeg, parkTiltDeg, sunGuardTickHz"
```

---

### Task 5: `src/track/sunguard.ts` — cone predicate + park planner (pure)

**Files:**
- Create: `tb3-mcp/src/track/sunguard.ts`
- Test: `tb3-mcp/test/sunguard.test.ts`

**Interfaces:**
- Consumes: `Mat3`, `Vec3`, `angleBetweenDeg` from `../geo/vec3.js`; `boresightEnu` from `./control.js`; `enuToPanTilt` from `../geo/orientation.js`.
- Produces:
  - `interface SunCheck { separationDeg: number; predictedSeparationDeg: number; tripped: boolean }`
  - `checkSun(R, panDeg, tiltDeg, ratePanDps, rateTiltDps, horizonMs, sunEnu, coneDeg): SunCheck`
  - `interface Waypoint { panDeg: number; tiltDeg: number }`
  - `interface ParkPlan { kind: "direct" | "pan-detour" | "no-safe-path"; waypoints: readonly Waypoint[] }` — the waypoints are flown **in sequence**, each a single-axis move from the previous, so the flown path is exactly the path this planner samples. (A single combined goto to a final point would cut a diagonal the sampling never checked and could pass closer to the sun than the cone.) `direct` → one waypoint (tilt-down at the current pan); `pan-detour` → two (pan sweep at the current tilt, then tilt down at the detour pan); `no-safe-path` → empty.
  - `planPark(R, curPanDeg, curTiltDeg, sunEnu, coneDeg, parkTiltDeg, limits): ParkPlan` where `limits: { panMin; panMax; tiltMin; tiltMax }`.
- Design notes: everything is in **user frame**. The park-path safety check **samples** the candidate sweep and takes the minimum boresight→sun separation — robust and directly testable. A leg is safe iff that minimum stays `≥ min(coneDeg, separation at the leg's start)`: a leg starting outside the cone must stay outside it; a leg starting **inside** the cone (the sun already drifted onto the boresight — the case the park most exists for) only has to escape without getting closer, since `≥ coneDeg` would be unsatisfiable and strand the rig on the sun. The sample step scales with `coneDeg` (`min(1°, coneDeg/10)`) so even a tiny cone can't hide a full transit between two samples.

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/sunguard.test.ts
import { describe, it, expect } from "vitest";
import { checkSun, planPark } from "../src/track/sunguard.js";
import { Mat3, Vec3, angleBetweenDeg } from "../src/geo/vec3.js";
import { boresightEnu } from "../src/track/control.js";

// Identity R: mount frame == ENU. Then boresight(pan,tilt) == the ENU direction
// with azimuth=pan, elevation=tilt, so cases are hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// A sun ENU unit vector at (az, el).
const sun = (azDeg: number, elDeg: number): Vec3 => {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
};
const LIM = { panMin: -180, panMax: 180, tiltMin: -30, tiltMax: 90 };

describe("checkSun", () => {
  it("does not trip when the boresight is far from the sun", () => {
    const r = checkSun(I, 0, 10, 0, 0, 0, sun(180, 60), 25);
    expect(r.separationDeg).toBeGreaterThan(25);
    expect(r.tripped).toBe(false);
  });

  it("trips when the current boresight is inside the cone", () => {
    const r = checkSun(I, 175, 60, 0, 0, 0, sun(180, 60), 25);
    expect(r.separationDeg).toBeLessThan(25);
    expect(r.tripped).toBe(true);
  });

  it("trips PREDICTIVELY: current boresight clear, but a slew carries it in", () => {
    // At (150°,60°) the sun (180°,60°) is ~15° away in azimuth → outside a 10° cone.
    // Slewing +pan at 30°/s for a 1s horizon predicts (180°,60°) → inside.
    const clear = checkSun(I, 150, 60, 0, 0, 0, sun(180, 60), 10);
    expect(clear.tripped).toBe(false);
    const pred = checkSun(I, 150, 60, 30, 0, 1000, sun(180, 60), 10);
    expect(pred.predictedSeparationDeg).toBeLessThan(clear.separationDeg);
    expect(pred.tripped).toBe(true);
  });
});

describe("planPark", () => {
  it("goes direct-down when the tilt sweep stays clear of a high sun", () => {
    // Sun overhead-ish (el 70°), boresight at tilt 20° → tilting DOWN to -20°
    // only increases separation. Direct: one waypoint, tilt-down at current pan.
    const plan = planPark(I, 0, 20, sun(180, 70), 25, -20, LIM);
    expect(plan.kind).toBe("direct");
    expect(plan.waypoints).toEqual([{ panDeg: 0, tiltDeg: -20 }]);
  });

  it("takes a pan detour when tilting down would sweep through a LOW sun", () => {
    // Low sun (el 10°) dead ahead (az 0°). Boresight above it at tilt 40°, same
    // azimuth. Tilting straight down crosses the sun's elevation at az 0 → unsafe.
    const plan = planPark(I, 0, 40, sun(0, 10), 15, -20, LIM);
    expect(plan.kind).toBe("pan-detour");
    // Two waypoints flown in order: pan sweep at the CURRENT tilt (40°), THEN
    // tilt down at the detour pan. Both share the detour pan; that is the L-path
    // the planner actually verified, so the rig must fly it, not a diagonal.
    expect(plan.waypoints.length).toBe(2);
    expect(plan.waypoints[0].tiltDeg).toBe(40);
    expect(plan.waypoints[1].tiltDeg).toBe(-20);
    expect(plan.waypoints[0].panDeg).toBe(plan.waypoints[1].panDeg);
    expect(Math.abs(plan.waypoints[1].panDeg)).toBeGreaterThanOrEqual(15);
  });

  it("the pan-detour L-path it returns is actually clear of the sun end to end", () => {
    // Fly the returned waypoints and confirm the minimum separation never enters
    // the cone. Interpolate BOTH axes between consecutive waypoints (not just the
    // one that changed) — for a correct single-axis leg the unchanged axis is a
    // no-op, but this way the test would ALSO catch a regression that collapsed
    // the detour back to a single diagonal-endpoint waypoint (the original bug).
    const cone = 15;
    const s = sun(0, 10);
    const plan = planPark(I, 0, 40, s, cone, -20, LIM);
    expect(plan.kind).toBe("pan-detour");
    let prev = { panDeg: 0, tiltDeg: 40 };
    let worst = Infinity;
    for (const wp of plan.waypoints) {
      const span = Math.max(Math.abs(wp.panDeg - prev.panDeg), Math.abs(wp.tiltDeg - prev.tiltDeg));
      const steps = Math.max(1, Math.ceil(span / 0.25));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const pan = prev.panDeg + (wp.panDeg - prev.panDeg) * f;
        const tilt = prev.tiltDeg + (wp.tiltDeg - prev.tiltDeg) * f;
        worst = Math.min(worst, angleBetweenDeg(boresightEnu(I, pan, tilt), s));
      }
      prev = wp;
    }
    expect(worst).toBeGreaterThanOrEqual(cone);
  });

  it("scales sampling to the cone: a sub-degree cone hidden between 1° samples is still caught", () => {
    // Sun at tilt 10.5° — exactly between the integer tilt samples a fixed 1°
    // sampler would take on a 40°→-20° sweep at pan 0. With a 0.3° cone, plain 1°
    // sampling (nearest sample 0.5° away, outside the cone) would MISS the transit
    // and call it a safe direct tilt-down. The cone-scaled sampler must not.
    const s = sun(0, 10.5);
    const plan = planPark(I, 0, 40, s, 0.3, -20, LIM);
    expect(plan.kind).not.toBe("direct");
  });

  it("escapes an already-in-cone start instead of reporting no-safe-path", () => {
    // Boresight aimed nearly AT a high sun (sep ~0.6°, deep inside a 25° cone) —
    // the situation the park most exists for. It must NOT fault as no-safe-path;
    // it must tilt down and away, and the path must never get CLOSER to the sun
    // than the (tiny) starting separation.
    const s = sun(175, 77.6);
    const plan = planPark(I, 175, 77, s, 25, -20, LIM);
    expect(plan.kind).toBe("direct");
    expect(plan.waypoints).toEqual([{ panDeg: 175, tiltDeg: -20 }]);
    const startSep = angleBetweenDeg(boresightEnu(I, 175, 77), s);
    let prev = { panDeg: 175, tiltDeg: 77 };
    let worst = Infinity;
    for (const wp of plan.waypoints) {
      const span = Math.max(Math.abs(wp.panDeg - prev.panDeg), Math.abs(wp.tiltDeg - prev.tiltDeg));
      const steps = Math.max(1, Math.ceil(span / 0.25));
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const pan = prev.panDeg + (wp.panDeg - prev.panDeg) * f;
        const tilt = prev.tiltDeg + (wp.tiltDeg - prev.tiltDeg) * f;
        worst = Math.min(worst, angleBetweenDeg(boresightEnu(I, pan, tilt), s));
      }
      prev = wp;
    }
    expect(worst).toBeGreaterThanOrEqual(startSep - 0.01); // never closer than the start
  });

  it("reports no-safe-path (empty waypoints) when limits block every detour around a low sun", () => {
    // Low sun straight ahead, but pan is pinned to a tiny window around it.
    const tight = { panMin: -5, panMax: 5, tiltMin: -30, tiltMax: 90 };
    const plan = planPark(I, 0, 40, sun(0, 10), 15, -20, tight);
    expect(plan.kind).toBe("no-safe-path");
    expect(plan.waypoints).toEqual([]);
  });

  it("degeneracy never coincides with danger: a near-zenith sun is never the crossing case", () => {
    // Sun near zenith (el 88°). Whatever the boresight, tilting down away from
    // near-vertical increases separation → always direct, never a detour.
    for (const bore of [0, 45, 90, 135, 180]) {
      const plan = planPark(I, bore, 30, sun(bore, 88), 20, -20, LIM);
      expect(plan.kind).toBe("direct");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/sunguard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// tb3-mcp/src/track/sunguard.ts
import { Mat3, Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { boresightEnu } from "./control.js";
import { enuToPanTilt } from "../geo/orientation.js";

export interface SunCheck {
  readonly separationDeg: number;
  readonly predictedSeparationDeg: number;
  readonly tripped: boolean;
}

// Predict the boresight after horizonMs at the given per-axis rates (user frame),
// then take the smaller of current and predicted separation. Tripped iff either
// the current OR the predicted boresight is inside the cone.
export function checkSun(
  R: Mat3, panDeg: number, tiltDeg: number,
  ratePanDps: number, rateTiltDps: number, horizonMs: number,
  sunEnu: Vec3, coneDeg: number,
): SunCheck {
  const sep = angleBetweenDeg(boresightEnu(R, panDeg, tiltDeg), sunEnu);
  const h = Math.max(0, horizonMs) / 1000;
  const predPan = panDeg + ratePanDps * h;
  const predTilt = tiltDeg + rateTiltDps * h;
  const predSep = angleBetweenDeg(boresightEnu(R, predPan, predTilt), sunEnu);
  return {
    separationDeg: sep,
    predictedSeparationDeg: predSep,
    tripped: sep < coneDeg || predSep < coneDeg,
  };
}

export interface Waypoint {
  readonly panDeg: number;
  readonly tiltDeg: number;
}

export interface ParkPlan {
  readonly kind: "direct" | "pan-detour" | "no-safe-path";
  // Flown IN SEQUENCE, each a single-axis move from the previous, so the flown
  // path is exactly the path sampled below. Empty for no-safe-path.
  readonly waypoints: readonly Waypoint[];
}

export interface ParkLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

const PARK_SAMPLE_DEG = 1.0;        // baseline resolution when sampling a sweep
const MIN_SAMPLES_PER_CONE = 10;    // guarantee >=10 samples across a cone width
const DETOUR_MARGIN_DEG = 5.0;      // extra clearance past the cone edge for a pan detour

// Minimum boresight→sun separation while sweeping ONE axis from a→b at fixed
// other-axis, inclusive of endpoints. Sampling APPROXIMATES the continuous
// minimum to within half the sample spacing; sampleDeg is scaled to the cone by
// the caller so the approximation cannot step over a full cone transit.
function minSepAlong(
  R: Mat3, sunEnu: Vec3, axis: "pan" | "tilt", fixed: number, a: number, b: number, sampleDeg: number,
): number {
  const steps = Math.max(1, Math.ceil(Math.abs(b - a) / sampleDeg));
  let min = Infinity;
  for (let i = 0; i <= steps; i++) {
    const v = a + ((b - a) * i) / steps;
    const enu = axis === "tilt" ? boresightEnu(R, fixed, v) : boresightEnu(R, v, fixed);
    min = Math.min(min, angleBetweenDeg(enu, sunEnu));
  }
  return min;
}

// A single-axis leg (from `a` to `b` at the fixed other-axis) is "clear" if it
// never brings the boresight closer to the sun than min(coneDeg, separation at
// the leg's START). A leg that starts OUTSIDE the cone must stay outside it (the
// normal predictive trip). A leg that starts INSIDE the cone — which is exactly
// why we park when the sun has already drifted onto the boresight — only has to
// escape WITHOUT getting closer; demanding >= coneDeg there is unsatisfiable and
// would leave the rig sitting on the sun (a moving hazard) instead of moving away.
function sweepClear(
  R: Mat3, sunEnu: Vec3, axis: "pan" | "tilt", fixed: number, a: number, b: number,
  coneDeg: number, sampleDeg: number,
): boolean {
  const startEnu = axis === "tilt" ? boresightEnu(R, fixed, a) : boresightEnu(R, a, fixed);
  const startSep = angleBetweenDeg(startEnu, sunEnu);
  const threshold = Math.min(coneDeg, startSep);
  return minSepAlong(R, sunEnu, axis, fixed, a, b, sampleDeg) >= threshold;
}

export function planPark(
  R: Mat3, curPanDeg: number, curTiltDeg: number,
  sunEnu: Vec3, coneDeg: number, parkTiltDeg: number,
  limits: ParkLimits,
): ParkPlan {
  const tiltTarget = Math.max(limits.tiltMin, Math.min(limits.tiltMax, parkTiltDeg));
  // Enough samples that a thin cone cannot hide a transit between two samples.
  const sampleDeg = Math.min(PARK_SAMPLE_DEG, coneDeg / MIN_SAMPLES_PER_CONE);

  // 1. Direct: tilt down at the current pan. Clear iff the sweep never gets closer
  // to the sun than where it starts (or than the cone, if it starts outside it).
  if (sweepClear(R, sunEnu, "tilt", curPanDeg, curTiltDeg, tiltTarget, coneDeg, sampleDeg)) {
    return { kind: "direct", waypoints: [{ panDeg: curPanDeg, tiltDeg: tiltTarget }] };
  }

  // 2. Pan detour: swing pan clear of the sun's azimuth, THEN tilt down — two
  // waypoints flown in that order (an L), which is exactly what is checked here.
  const sunPT = enuToPanTilt(R, sunEnu);
  const clearOffset = coneDeg / Math.max(0.2, Math.cos((sunPT.tiltDeg * Math.PI) / 180)) + DETOUR_MARGIN_DEG;
  for (const cand of [sunPT.panDeg + clearOffset, sunPT.panDeg - clearOffset]) {
    // Resolve the candidate into [panMin, panMax] via ±360 like the pointing code.
    const resolved = [cand, cand - 360, cand + 360].find((p) => p >= limits.panMin && p <= limits.panMax);
    if (resolved === undefined) continue;
    const panClear = sweepClear(R, sunEnu, "pan", curTiltDeg, curPanDeg, resolved, coneDeg, sampleDeg);
    const tiltClear = sweepClear(R, sunEnu, "tilt", resolved, curTiltDeg, tiltTarget, coneDeg, sampleDeg);
    if (panClear && tiltClear) {
      return {
        kind: "pan-detour",
        waypoints: [
          { panDeg: resolved, tiltDeg: curTiltDeg }, // pan sweep at the current tilt
          { panDeg: resolved, tiltDeg: tiltTarget }, // then tilt down at the detour pan
        ],
      };
    }
  }

  // 3. Nothing safe — refuse to move.
  return { kind: "no-safe-path", waypoints: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/sunguard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/track/sunguard.ts tb3-mcp/test/sunguard.test.ts
git commit -m "feat(sun): pure cone predicate + park-path planner"
```

---

### Task 6: `src/track/supervisor.ts` — SunSupervisor (stateful)

**Files:**
- Create: `tb3-mcp/src/track/supervisor.ts`
- Test: `tb3-mcp/test/supervisor.test.ts`

**Interfaces:**
- Consumes: `Device`, `Config`, `CalibrationStore`, `TrackingSession`, `Scheduler`/`realScheduler` from `./session.js`, `sunEnu` from `../geo/sun.js`, `checkSun`/`planPark` from `./sunguard.js`, `boresightEnu` from `./control.js`, `limitHorizonMs` from `./control.js`, `angleBetweenDeg` from `../geo/vec3.js`, `moveToUserAngle` from `../move.js`, `stepsToDeg`/`applySign` from `../angles.js`.
- Produces:
  - `type SunState = "disabled" | "monitoring" | "parking" | "parked" | "fault"`
  - `interface SunStatus { state; reason: string | null; enabled; coneDeg; parkTiltDeg; sunAzDeg; sunElDeg; separationDeg; locked }`
  - `class SunSupervisor` with:
    - `constructor(device, cfg, store, session, now = Date.now, scheduler = realScheduler)`
    - `start(): void` / `stop(): void`
    - `isSunLocked(): boolean`
    - `status(): SunStatus`
    - `setConfig(p: { enabled?: boolean; coneDeg?: number; parkTiltDeg?: number }): void`
    - `clearLock(): void`
    - `tickForTest(): void` (drives one tick under an injected scheduler; the real scheduler calls the same private tick)

- [ ] **Step 1: Write the failing test**

```ts
// tb3-mcp/test/supervisor.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { SunSupervisor } from "../src/track/supervisor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8802;
let mock: MockTb3 | null = null;
let dev: Device | null = null;

// A manual scheduler: tests fire ticks explicitly, no wall clock.
function manualScheduler(): { sched: Scheduler; fire: () => void } {
  let fn: (() => void) | null = null;
  return { sched: { every: (_ms, f) => { fn = f; return { cancel() { fn = null; } }; } }, fire: () => fn?.() };
}

// Identity R so pan==azimuth, tilt==elevation. Calibrate the store to a known rig.
function calibratedStore(): CalibrationStore {
  const dir = mkdtempSync(join(tmpdir(), "tb3-sun-"));
  const store = new CalibrationStore(join(dir, "cal.json"));
  store.load();
  store.setRigLocation(33.4484, -112.074, 0);
  store.addSighting({ lat: 33.5, lon: -112.074, height: 0, panDeg: 0, tiltDeg: 0 });
  store.addSighting({ lat: 33.4484, lon: -112.0, height: 1000, panDeg: 90, tiltDeg: 45 });
  store.setOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], new Date(0).toISOString());
  return store;
}

// Optionally freeze the DEVICE clock too. The supervisor compares its injected
// `now` against the device's telemetry timestamp (lastUpdateMs, stamped with the
// Device's own `now`). A test that freezes only the supervisor's `now` at a sun
// fixture would see a huge telemetry age and wrongly fault. Freeze both to the
// same instant and the age is ~0.
async function harness(coneDeg = 25, fixedNowMs?: number) {
  mock = new MockTb3(); await mock.start(PORT);
  const cfg = { ...loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` }), sunConeDeg: coneDeg };
  dev = new Device(cfg, fixedNowMs !== undefined ? () => fixedNowMs : undefined); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  return { cfg, store: calibratedStore() };
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });

describe("SunSupervisor", () => {
  it("is disabled when uncalibrated", async () => {
    const { cfg } = await harness();
    const empty = new CalibrationStore("/tmp/tb3-none-DOES-NOT-EXIST.json"); empty.load();
    const { sched } = manualScheduler();
    const session = new TrackingSession(dev!, cfg, empty);
    const sup = new SunSupervisor(dev!, cfg, empty, session, () => 1_000_000, sched);
    sup.start(); sup.tickForTest();
    const s = sup.status();
    expect(s.state).toBe("disabled");
    expect(s.reason).toBe("uncalibrated");
    expect(sup.isSunLocked()).toBe(false);
  });

  it("faults and locks on stale telemetry — and does NOT move", async () => {
    const { cfg, store } = await harness();
    const { sched } = manualScheduler();
    // now() far ahead of the device's lastUpdateMs → telemetry looks stale.
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => Date.now() + 10_000, sched);
    sup.start(); sup.tickForTest();
    const s = sup.status();
    expect(s.state).toBe("fault");
    expect(sup.isSunLocked()).toBe(true);
    expect(mock!.lastGoto).toBeNull(); // never parked on unknown position
  });

  it("fault is sticky: a later tick does not silently clear it or move", async () => {
    const { cfg, store } = await harness();
    const { sched } = manualScheduler();
    // First tick faults on stale telemetry (now far ahead of the device stamp).
    let nowMs = Date.now() + 10_000;
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start(); sup.tickForTest();
    expect(sup.status().state).toBe("fault");
    // "Telemetry recovers": align now with a fresh device stamp so it is no longer
    // stale. Without the sticky-fault guard the next tick would fall through and
    // leave fault (to monitoring or sun_below_horizon); with it, fault persists.
    nowMs = dev!.getState().lastUpdateMs + 100;
    sup.tickForTest();
    expect(sup.status().state).toBe("fault");
    expect(mock!.lastGoto).toBeNull();
    // Only a human clears it.
    sup.clearLock();
    expect(sup.status().state).toBe("monitoring");
  });

  it("flies a direct park and reaches 'parked' ONLY after the waypoint arrives", async () => {
    // Phoenix solar noon: sun high (~77.6° el, ~175° az). Boresight aimed at the
    // sun → trips → a high sun means a direct tilt-down park (one waypoint).
    const nowMs = Date.UTC(2026, 6, 17, 19, 30);
    const { cfg, store } = await harness(25, nowMs);
    const { sched } = manualScheduler();
    mock!.setPosition(175 * 444.444, 77 * 444.444);
    await new Promise((r) => setTimeout(r, 200));
    const session = new TrackingSession(dev!, cfg, store);
    const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
    sup.start();
    sup.tickForTest(); // trip → parking, issues the park goto (to tilt -20)
    expect(sup.status().state).toBe("parking");
    expect(mock!.lastGoto).not.toBeNull();
    // Waypoint has NOT arrived (still at tilt 77) → must stay parking, not parked.
    sup.tickForTest();
    expect(sup.status().state).toBe("parking");
    // Make the goto arrive: move the rig to the park target.
    mock!.setPosition(175 * 444.444, -20 * 444.444);
    await new Promise((r) => setTimeout(r, 400)); // waitForArrival resolves + .then runs
    sup.tickForTest(); // parkStep advanced on arrival → parked
    expect(sup.status().state).toBe("parked");
    expect(sup.isSunLocked()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/supervisor.test.ts`
Expected: FAIL — `SunSupervisor` not found.

- [ ] **Step 3: Write the implementation**

```ts
// tb3-mcp/src/track/supervisor.ts
import { Device } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { TrackingSession, Scheduler, realScheduler } from "./session.js";
import { sunEnu, sunAzEl } from "../geo/sun.js";
import { checkSun, planPark, ParkPlan } from "./sunguard.js";
import { boresightEnu, limitHorizonMs } from "./control.js";
import { Vec3 } from "../geo/vec3.js";
import { moveToUserAngle } from "../move.js";
import { stepsToDeg, applySign } from "../angles.js";

export type SunState = "disabled" | "monitoring" | "parking" | "parked" | "fault";

export interface SunStatus {
  readonly state: SunState;
  readonly reason: string | null;
  readonly enabled: boolean;
  readonly coneDeg: number;
  readonly parkTiltDeg: number;
  readonly sunAzDeg: number | null;
  readonly sunElDeg: number | null;
  readonly separationDeg: number | null;
  readonly locked: boolean;
}

interface Boresight { readonly panDeg: number; readonly tiltDeg: number; readonly enu: Vec3 }

// A park goto rejected this many ticks running (~5s at 10Hz) escalates to a
// fault+alarm rather than retrying forever in silence.
const PARK_MAX_RETRIES = 50;

export class SunSupervisor {
  private state: SunState = "disabled";
  private reason: string | null = "uncalibrated";
  private locked = false;
  private enabled: boolean;
  private coneDeg: number;
  private parkTiltDeg: number;
  private timer: { cancel(): void } | null = null;
  private parkInFlight = false;
  private parkPlan: ParkPlan | null = null;
  private parkStep = 0; // index of the next waypoint to fly
  private parkGen = 0;  // epoch; a superseded park's late promise can't mutate state
  private parkRetries = 0;
  private prev: { pan: number; tilt: number; tMs: number } | null = null;
  private lastSun: { az: number | null; el: number | null; sep: number | null } = { az: null, el: null, sep: null };

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly session: TrackingSession,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
  ) {
    this.enabled = cfg.sunGuardEnabled;
    this.coneDeg = cfg.sunConeDeg;
    this.parkTiltDeg = cfg.parkTiltDeg;
  }

  start(): void {
    if (this.timer) return;
    const ms = Math.max(20, Math.round(1000 / this.cfg.sunGuardTickHz));
    this.timer = this.scheduler.every(ms, () => this.safeTick());
  }
  stop(): void { this.timer?.cancel(); this.timer = null; }

  isSunLocked(): boolean { return this.locked; }
  clearLock(): void {
    this.locked = false;
    // Leaving parked/fault/parking all go back to monitoring; abortPark halts any
    // park goto still in flight so releasing the lock can't let another tool
    // command motion that fights the supervisor's own outstanding move.
    if (this.state === "parked" || this.state === "fault" || this.state === "parking") {
      this.abortPark();
      this.state = "monitoring";
    }
  }

  setConfig(p: { enabled?: boolean; coneDeg?: number; parkTiltDeg?: number }): void {
    if (p.enabled !== undefined) this.enabled = p.enabled;
    if (p.coneDeg !== undefined) this.coneDeg = p.coneDeg;
    if (p.parkTiltDeg !== undefined) this.parkTiltDeg = p.parkTiltDeg;
  }

  status(): SunStatus {
    return {
      state: this.state, reason: this.reason, enabled: this.enabled,
      coneDeg: this.coneDeg, parkTiltDeg: this.parkTiltDeg,
      sunAzDeg: this.lastSun.az, sunElDeg: this.lastSun.el,
      separationDeg: this.lastSun.sep, locked: this.locked,
    };
  }

  tickForTest(): void { this.tick(); }

  private safeTick(): void {
    // A throw must never leave motion running. Stop and lock; never guess a move.
    try { this.tick(); }
    catch { this.enterFault("internal_error"); }
  }

  private disable(reason: string): void {
    this.state = "disabled"; this.reason = reason; this.locked = false;
    this.abortPark(); this.prev = null;
  }

  private enterFault(reason: string): void {
    this.state = "fault"; this.reason = reason; this.locked = true;
    this.session.stop(); this.device.clearJog();
    this.abortPark();
  }

  // Abandon any in-flight park: halt the outstanding goto and bump the epoch so
  // its late resolution can neither advance parkStep nor declare "parked" on a
  // park cycle that no longer exists. Same orphaned-promise guard as
  // TrackingSession.cancelGoto. device.stop() fires only when a goto is actually
  // outstanding, so calling this every idle tick is cheap.
  private abortPark(): void {
    if (this.parkInFlight) void this.device.stop().catch(() => {});
    this.parkGen++;
    this.parkPlan = null; this.parkStep = 0; this.parkRetries = 0; this.parkInFlight = false;
  }

  private currentBoresight(): Boresight | null {
    // The attitude seam: the one place attitude is read. A future IMU source
    // would provide or correct this, without touching guard logic.
    const R = this.store.getOrientation();
    if (!R) return null;
    const d = this.device.getState();
    const panDeg = applySign(stepsToDeg(d.panSteps), this.cfg.panSign);
    const tiltDeg = applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign);
    return { panDeg, tiltDeg, enu: boresightEnu(R, panDeg, tiltDeg) };
  }

  private tick(): void {
    const nowMs = this.now();

    // Fault is terminal until a human clears it (clearLock). It must NOT silently
    // re-evaluate and resume autonomous motion when the triggering condition lifts
    // — a flaky telemetry link would otherwise bounce fault→park→fault with no
    // durable, operator-visible alarm.
    if (this.state === "fault") return;

    if (!this.enabled) { this.lastSun = { az: null, el: null, sep: null }; this.disable("manually_disabled"); return; }
    const p = this.store.get();
    if (!p.rig || !this.store.isCalibrated()) { this.lastSun = { az: null, el: null, sep: null }; this.disable("uncalibrated"); return; }

    // Fail-closed: a stale reading means we don't know where the boresight is.
    // Stop and lock, but never compute a park from an unknown position.
    const d = this.device.getState();
    const telAge = d.lastUpdateMs === 0 ? Infinity : nowMs - d.lastUpdateMs;
    if (!(telAge <= this.cfg.trackStaleTelemetryMs)) { this.enterFault("telemetry_stale"); return; }

    const { azDeg, elDeg } = sunAzEl(p.rig, nowMs);
    if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg)) { this.enterFault("sun_calc_failed"); return; }
    if (elDeg <= 0) { this.lastSun = { az: azDeg, el: elDeg, sep: null }; this.disable("sun_below_horizon"); return; }

    const sEnu = sunEnu(p.rig, nowMs);
    const bore = this.currentBoresight();
    if (!bore) { this.lastSun = { az: null, el: null, sep: null }; this.disable("uncalibrated"); return; }

    // Observed angular rate of the boresight, per axis, from consecutive samples.
    let ratePan = 0, rateTilt = 0;
    if (this.prev && nowMs > this.prev.tMs) {
      const dt = (nowMs - this.prev.tMs) / 1000;
      ratePan = (bore.panDeg - this.prev.pan) / dt;
      rateTilt = (bore.tiltDeg - this.prev.tilt) / dt;
    }
    this.prev = { pan: bore.panDeg, tilt: bore.tiltDeg, tMs: nowMs };

    const rate = Math.max(Math.abs(ratePan), Math.abs(rateTilt));
    const horizon = limitHorizonMs(rate, telAge, 1000 / this.cfg.sunGuardTickHz, this.cfg.maxJogDps);
    const chk = checkSun(this.store.getOrientation()!, bore.panDeg, bore.tiltDeg, ratePan, rateTilt, horizon, sEnu, this.coneDeg);
    this.lastSun = { az: azDeg, el: elDeg, sep: Number(chk.separationDeg.toFixed(3)) };

    // Stay parked and locked until a human clears the lock (clearLock moves us
    // back to monitoring; if the sun is still in the cone the next tick re-trips).
    if (this.state === "parked") return;

    if (this.state === "parking") { this.driveParkTick(bore); return; }

    // monitoring / recover: trip on a predicted approach.
    if (chk.tripped) {
      this.session.stop(); this.device.clearJog();
      this.locked = true;
      const plan = planPark(this.store.getOrientation()!, bore.panDeg, bore.tiltDeg, sEnu, this.coneDeg, this.parkTiltDeg,
        { panMin: this.cfg.panMin, panMax: this.cfg.panMax, tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax });
      if (plan.kind === "no-safe-path") { this.enterFault("no_safe_park_path"); return; }
      this.parkPlan = plan; this.parkStep = 0; this.parkRetries = 0;
      this.state = "parking"; this.reason = "sun_in_cone";
      this.driveParkTick(bore);
      return;
    }

    this.state = "monitoring"; this.reason = null; this.locked = false;
  }

  // Fly the park plan's waypoints IN ORDER, one single-axis goto at a time, so
  // the flown path is exactly the L-path planPark verified (a single combined
  // goto to the last point would cut a diagonal that was never checked). Each
  // moveToUserAngle resolves on arrival; advance the step then. Async, so kick
  // off one waypoint per tick and retry the same step if a goto is rejected
  // (e.g. a transient 409 while the rig decelerates out of a jog).
  private driveParkTick(_bore: Boresight): void {
    const plan = this.parkPlan;
    if (!plan || plan.waypoints.length === 0) { this.state = "monitoring"; return; }
    if (this.parkStep >= plan.waypoints.length) {
      // Every waypoint issued AND arrived (parkStep advances only on arrival).
      this.state = "parked"; this.reason = "sun_in_cone"; this.parkInFlight = false;
      return;
    }
    if (this.parkInFlight) return;
    const wp = plan.waypoints[this.parkStep];
    const gen = this.parkGen;
    this.parkInFlight = true;
    void moveToUserAngle(this.device, this.cfg, wp.panDeg, wp.tiltDeg)
      .then(() => {
        if (gen !== this.parkGen) return;              // superseded park — ignore
        this.parkStep++; this.parkRetries = 0; this.parkInFlight = false;
      })
      .catch(() => {
        if (gen !== this.parkGen) return;              // superseded park — ignore
        this.parkInFlight = false;
        // Retry the same waypoint next tick; give up (fault+alarm) if it never lands.
        if (++this.parkRetries >= PARK_MAX_RETRIES) this.enterFault("park_unreachable");
      });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && npx vitest run test/supervisor.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/track/supervisor.ts tb3-mcp/test/supervisor.test.ts
git commit -m "feat(sun): SunSupervisor — always-on watchdog that parks away from the sun"
```

---

### Task 7: wiring — supervisor in main, lockout gates, set_home invalidation, set_sun_guard, get_sun guard state

**Files:**
- Modify: `tb3-mcp/src/calibration.ts` (add `invalidateCalibration()`)
- Modify: `tb3-mcp/src/server.ts` (construct supervisor in `main`, thread into `buildApp` + registrations)
- Modify: `tb3-mcp/src/tools.ts` (lockout gate on `goto_angle`, `jog`, `set_home`; `set_home` invalidates calibration)
- Modify: `tb3-mcp/src/geo-tools.ts` (lockout gate on `point_at`, `point_at_azel`)
- Modify: `tb3-mcp/src/sun-tools.ts` (add `supervisor` param, `set_sun_guard`, guard state in `get_sun`)
- Modify: `tb3-mcp/test/server.test.ts:45` (count 20 → 21)
- Test: `tb3-mcp/test/supervisor.test.ts` (add lockout + set_home cases)

**Interfaces:**
- Consumes: `SunSupervisor` from `./track/supervisor.js`.
- Produces: `store.invalidateCalibration(): void` (keeps `rig`, clears `sightings` + `orientation`); `registerSunTools(server, device, cfg, store, supervisor)`; the 5 motion tools reject with `"sun guard active; blocked to protect the camera — clear it with set_sun_guard"` when `supervisor.isSunLocked()`.

- [ ] **Step 1: Write the failing test**

```ts
// add to tb3-mcp/test/supervisor.test.ts
it("locks out manual motion once tripped, and re-drives after clearLock", async () => {
  // Phoenix solar-noon fixture. Freeze BOTH clocks to it (harness freezes the
  // device) so telemetry age ≈ 0 while the sun sits at the fixture position.
  const nowMs = Date.UTC(2026, 6, 17, 19, 30);
  const { cfg, store } = await harness(25, nowMs);
  const { sched } = manualScheduler();
  // Aim the boresight AT the sun (identity R → pan=az≈175°, tilt=el≈77.6°).
  mock!.setPosition(175 * 444.444, 77 * 444.444);
  await new Promise((r) => setTimeout(r, 200));
  const session = new TrackingSession(dev!, cfg, store);
  const sup = new SunSupervisor(dev!, cfg, store, session, () => nowMs, sched);
  sup.start(); sup.tickForTest();
  expect(sup.isSunLocked()).toBe(true);
  expect(["parking", "parked", "fault"]).toContain(sup.status().state);
  sup.clearLock();
  expect(sup.isSunLocked()).toBe(false);
});

it("set_home invalidates R, dropping the guard to disabled(uncalibrated)", async () => {
  const { store } = await harness();
  expect(store.isCalibrated()).toBe(true);
  store.invalidateCalibration();
  expect(store.isCalibrated()).toBe(false);
  expect(store.get().rig).toBeDefined(); // rig location preserved
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && npx vitest run test/supervisor.test.ts`
Expected: FAIL — `invalidateCalibration` not found (and possibly the lock case).

- [ ] **Step 3: Add `invalidateCalibration` to the store**

In `tb3-mcp/src/calibration.ts`, add a method to `CalibrationStore`:
```ts
  // set_home re-zeros the step origin. R and the sightings were recorded against
  // the OLD zero, so both are now wrong; keep the rig location (the tripod did not
  // move) and force a re-calibration.
  invalidateCalibration(): void {
    this.profile = { ...this.profile, sightings: [], orientation: undefined, solvedAt: undefined };
    this.save();
  }
```

- [ ] **Step 4: Thread the supervisor through the server**

Use these **exact** signatures (add the new trailing params; keep existing order):
- `buildApp(device, cfg, store, session, supervisor)`
- `registerTools(server, device, cfg, session, supervisor, store)` — `store` is new here (`set_home` needs it); import `CalibrationStore` and `SunSupervisor` types.
- `registerGeoTools(server, device, cfg, store, session, supervisor)` — `supervisor` is new; import the type.
- `registerSunTools(server, device, cfg, store, supervisor)` — `supervisor` is new.

In `tb3-mcp/src/server.ts`:
- import: `import { SunSupervisor } from "./track/supervisor.js";`
- change `buildApp`'s signature and its registration calls:
  ```ts
  registerTools(server, device, cfg, session, supervisor, store);
  registerGeoTools(server, device, cfg, store, session, supervisor);
  registerSunTools(server, device, cfg, store, supervisor);
  ```
- in `main()`, after the session is constructed:
  ```ts
  const supervisor = new SunSupervisor(device, cfg, store, session);
  supervisor.start();
  const app = buildApp(device, cfg, store, session, supervisor);
  ```

- [ ] **Step 5: Add the lockout gate to the 5 motion tools**

Define the shared message once at the top of each of `tools.ts` and `geo-tools.ts` (they already each have their own `text`/`errText`):
```ts
const SUN_LOCKED_MSG = "sun guard active; blocked to protect the camera — clear it with set_sun_guard";
```
Add the `supervisor: SunSupervisor` parameter per the exact signatures in Step 4 (and `store: CalibrationStore` to `registerTools`), importing the types. At the **top** of each handler for `goto_angle`, `jog`, `set_home` (in `tools.ts`) and `point_at`, `point_at_azel` (in `geo-tools.ts`), before any device call, add:
```ts
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
```
In the `set_home` handler (`tools.ts`), after `device.setHome()` succeeds, invalidate calibration:
```ts
      try {
        await device.setHome();
        store.invalidateCalibration();
        return text("home set — calibration cleared (R was tied to the old zero); re-calibrate before pointing");
      } catch (e) { return errText(`device rejected set_home: ${(e as Error).message}`); }
```

- [ ] **Step 6: Extend `sun-tools.ts` — supervisor param, guard state, `set_sun_guard`**

Change `registerSunTools(server, device, cfg, store, supervisor)`. In `get_sun`, add the supervisor's guard fields to the JSON (`guard_state`, `guard_reason`, `guard_enabled`, `cone_deg`, `park_tilt_deg`, `locked`) from `supervisor.status()`. Add a second tool:
```ts
  server.registerTool(
    "set_sun_guard",
    {
      description: "Enable/disable the sun guard and set its exclusion cone and park tilt. Also clears a standing sun lockout.",
      inputSchema: {
        enabled: z.boolean().optional().describe("master enable"),
        cone_deg: z.number().positive().max(90).optional().describe("exclusion half-angle around the sun"),
        park_tilt_deg: z.number().optional().describe("tilt to park at when the guard trips"),
        clear_lock: z.boolean().optional().describe("release a standing lockout (re-trips next tick if the sun is still in the cone)"),
      },
    },
    async ({ enabled, cone_deg, park_tilt_deg, clear_lock }) => {
      supervisor.setConfig({ enabled, coneDeg: cone_deg, parkTiltDeg: park_tilt_deg });
      if (clear_lock) supervisor.clearLock();
      return text(JSON.stringify(supervisor.status(), null, 2));
    },
  );
```
(`z` import needed in `sun-tools.ts`.)

- [ ] **Step 7: Bump the tool count**

`tb3-mcp/test/server.test.ts:45`:
```ts
    expect(tools.length).toBe(21); // 8 base + 7 geo + 4 tracking + 2 sun (get_sun, set_sun_guard)
```

- [ ] **Step 8: Run the full suite**

Run: `cd tb3-mcp && npx vitest run && npx tsc --noEmit`
Expected: PASS (all files); tsc clean. Fix any call sites the new parameters broke (`buildApp`, `registerTools`, `registerGeoTools`, `registerSunTools` in `server.ts` and in any test harness that constructs them — update those harnesses to pass a `SunSupervisor`).

- [ ] **Step 9: Commit**

```bash
git add tb3-mcp/src
git add tb3-mcp/test/supervisor.test.ts tb3-mcp/test/server.test.ts
git commit -m "feat(sun): wire supervisor, sun lockout on 5 motion tools, set_home invalidates R, set_sun_guard"
```

---

### Task 8: README — the sun guard

**Files:**
- Modify: `tb3-mcp/README.md`

- [ ] **Step 1: Document the guard**

Add a `## Sun guard` subsection covering, in the README's existing honest tone:
- What it is: an always-on supervisor (when calibrated and the sun is up) that parks the rig away from the sun; the trip response is an active park, not a hold, because the sun moves.
- The tools: `get_sun` (now includes guard state) and `set_sun_guard` (enable/disable, `cone_deg`, `park_tilt_deg`, `clear_lock`).
- Sizing the cone from the shadow test: `R_error + FOV/2 + ~0.5° tracking + 0.27° sun + margin`.
- The five guarded tools and the lockout message; that `set_home` clears calibration and disables the guard until re-calibration.
- **Fail-closed:** stale telemetry or a failed sun calc → stop + lock, never a guessed park.
- **Explicitly NOT protected:** a stopped daemon (park down before ending a session), the physical nunchuck, clouds.
- The clock caveat: a wrong UTC moves the sun with no symptom; `get_sun` reports the assumed UTC; the shadow test validates it.

- [ ] **Step 2: Commit**

```bash
git add tb3-mcp/README.md
git commit -m "docs(sun): document the sun guard, its tools, cone sizing, and its limits"
```

---

## Notes for the executor

- **Spec vs plan tool count:** the spec's header said "2 new → 21 total" while its body listed three tool names. This plan consolidates the read side into `get_sun` and ships **two** tools (`get_sun`, `set_sun_guard`) → 21 total, honoring the header. If you would rather have a separate `get_sun_guard`, that's a third tool (→22) and the count assertions change accordingly — flag it rather than guessing.
- **The mock stays truthful.** Do not teach the mock anything about the sun; the supervisor reads only telemetry the mock already serves.
- **Phase 1 is a clean shipping point.** After Task 3, stop and run the shadow test on a clear day before building Phase 2 against a real lens.
