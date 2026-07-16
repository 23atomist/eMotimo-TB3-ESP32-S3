# Target Tracking (Layer 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TB3 continuously follow a moving geographic target (aircraft/drone given as lat/lon/height + optional velocity), keeping it in frame rather than pointing at it once.

**Architecture:** Extends the existing `tb3-mcp` daemon with its first background control loop. A pure target estimator extrapolates the target in the rig's ENU frame; a pure control law produces a rate command (feedforward from the known target angular rate + a proportional term on pointing error); a session state machine (`acquiring`/`tracking`/`waiting`/`stopped`) owns the tick loop and every safety gate. Rate reaches the rig through a new TTL-guarded sticky jog vector on `Device`.

**Tech Stack:** TypeScript/Node ESM, zod, vitest, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-07-16-target-tracking-design.md`

## Global Constraints

- **ESM:** every relative import MUST end in `.js` (e.g. `import { Vec3 } from "../geo/vec3.js"`). TypeScript source, `.js` specifier. A missing `.js` fails at runtime.
- **Tests:** vitest, run from `tb3-mcp/`. `vitest.config.ts` sets `fileParallelism: false` — do not change it (the mock binds real ports).
- **No `any`** in application code. Use `unknown` + narrowing at boundaries.
- **Pure modules are immutable:** `estimator.ts` and `control.ts` export pure functions over `readonly` types. No mutation, no classes, no I/O. `session.ts` is the only new stateful unit.
- **Units:** SI throughout — meters, m/s, degrees, milliseconds. Angles are degrees at every module boundary; radians only inside a function.
- **Frames:** `R` maps mount→ENU; pointing uses `Rᵀ`. `enuToPanTilt(R, u)` returns **user-frame** pan/tilt. The rig's user-frame pan/tilt is `applySign(stepsToDeg(steps), cfg.panSign|tiltSign)`. Never double-apply or drop a sign.
- **ENU is `[E, N, U]`.** Heading 0° = North, 90° = East, so `velocityEnu = [speed·sin(heading), speed·cos(heading), climb]`.
- **Soft limits are the single source of truth:** reuse `checkPanTilt` / `reachablePanTilt`. The jog path does NOT enforce them — the session must.
- **The jog deflection→rate curve is CUBIC, measured on hardware:** `rate = maxJogDps · ((|x|−5)/95)³`, zero below `|x|=6`. The servo inverts it via `rateToDeflection` (Task 6 Part A). Layer 1's `jog` tool keeps its linear mapping deliberately — it is human-in-the-loop. Never reuse the linear mapping in the servo, and never model it linearly in the mock.
- **`maxJogDps` is a measured hardware constant (~22.5 °/s), not a preference.** It scales the feedforward directly. The default is set from the rig's measured full-deflection plateau; if it is wrong, the servo is wrong everywhere.
- **The rig must be in the firmware's Track (Web) mode (Task 10) for the servo to move anything.** Web jog is mode-gated; on menu screens the joystick drives menu navigation, and in Dragonframe mode the entire web path is dead.
- **`stop` always wins:** the layer-1 `stop` tool kills any tracking session.
- **One rig = one `TrackingSession`, daemon-wide.** `buildApp` creates a NEW `McpServer` per MCP connection; the session must be created ONCE outside that and passed in, or two MCP clients would each get their own session driving one rig.
- **All new config keys** have a default and a `TB3_*` env override, following `config.ts` conventions.
- **Heights share a datum** (inherited from layer 2); `height_m` validated to `[-1000, 100000]` via the shared `heightSchema`.

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `tb3-mcp/src/track/estimator.ts` | Target state + ENU extrapolation (pure) |
| `tb3-mcp/src/track/control.ts` | Feedforward + P control law, limit guard (pure) |
| `tb3-mcp/src/track/session.ts` | State machine, tick loop, safety gates |
| `tb3-mcp/src/track-tools.ts` | The 4 MCP tools |
| `tb3-mcp/test/estimator.test.ts`, `control.test.ts`, `session.test.ts`, `track-tools.test.ts`, `device-jog.test.ts`, `tracking-sim.test.ts` | Tests |

**Modify:**
| File | Change |
|---|---|
| `tb3-mcp/src/geo/vec3.ts` | add `add()` |
| `tb3-mcp/src/geo/wgs84.ts` | add `enuPosition()`; re-express `enuDirection` on it |
| `tb3-mcp/src/geo-tools.ts` | export `heightSchema` for reuse |
| `tb3-mcp/src/config.ts` | 8 new keys |
| `tb3-mcp/src/device.ts` | sticky jog vector + TTL watchdog + injected clock |
| `tb3-mcp/src/tools.ts` | arbitration: goto/jog refuse while tracking; stop kills session |
| `tb3-mcp/src/server.ts` | construct session once; wire `registerTrackTools` |
| `tb3-mcp/test/mock-tb3.ts` | integrate the jog vector into simulated position |
| `tb3-mcp/test/server.test.ts` | tool count 15 → 19 |
| `tb3-mcp/README.md` | layer-3 docs |

---

### Task 0: Verify the jog path on hardware (HUMAN-RUN — do first) — ✅ DONE 2026-07-16, FINDINGS CHANGED THE PLAN

> **This task is complete. Do not re-run it, and do NOT apply its Step 4 fix — see below.**
>
> Probing the rig (`tb3-mcp/scripts/jog-probe.mjs`, `jog-curve.mjs`) found the jog path is **not broken** and does **not** share the `/api/goto` NaN root cause. Step 4 below ("initialize motion params, mirroring the goto fix") targets a bug that does not exist and would be a no-op. It is left here only as a record of the hypothesis that was tested and rejected.
>
> **What it actually found** (full detail in the spec's "Hardware reality" section):
> 1. **Jog is mode-gated.** Motion needs `DFSetup()` + `NunChuckQuerywithEC()` + `updateMotorVelocities2()` to coincide — only true on a program's point-setting screen. Menu screens route the joystick to menu navigation; `DFloop()` pumps no web path at all. → **new Task 10: a dedicated firmware Track (Web) mode.**
> 2. **The deflection→rate curve is CUBIC**, not linear (cubic fits 29× better on measured data). The linear mapping this plan originally reused in the servo would have corrupted the feedforward across its whole range while looking like a mistuned gain. → **Task 6 Part A: `rateToDeflection`**, and the mock must model the cubic too.
> 3. **Ceiling ≈ 22.5 °/s**, rate changes are ramped. `maxJogDps` default `20` was wrong.



**Why this is Task 0:** Layer 1's `/api/goto` hung on hardware because `DFSetup()` never runs from the boot menu, leaving `maxVelocity`/`jogMaxVelocity`/accel at 0 → `tmax = v/a = 0/0 = NaN` → poisoned move segments. **The entire layer-3 servo rides the jog/joystick path**, which may carry the same exposure. Verify before building on it.

This task requires physical hardware and is run by the human operator, not a subagent. Tasks 1–9 are mock-tested and do NOT depend on its outcome; only hardware validation and the conditional firmware fix below do.

- [ ] **Step 1: Power the rig with the camera REMOVED, note its IP, leave it on the boot menu screen**

Do not enter the Dragonframe or jog screen — the boot menu is the state that broke goto.

- [ ] **Step 2: Send a sustained jog over the joystick websocket and watch for motion**

The joystick path is a websocket (`/ws`), not HTTP, so use a WS client. From `tb3-mcp/`:

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://<RIG_IP>/ws");
ws.on("open", () => {
  console.log("open — jogging pan at 50% for 3s");
  const t = setInterval(() => ws.send(JSON.stringify({ x: 50, y: 0, aux: 0 })), 100);
  setTimeout(() => { clearInterval(t); ws.send(JSON.stringify({x:0,y:0,aux:0})); ws.close(); }, 3000);
});
ws.on("message", (m) => { const d = JSON.parse(m); if (d.type === "tick") console.log("pos", d.pos, "moving", d.moving); });
'
```

Expected if healthy: `pos[0]` increases steadily across ticks and `moving` is 1 during the jog.

- [ ] **Step 3: Record the outcome**

- **Pan advances smoothly** → jog path is healthy. Skip Step 4. Note the observed °/s (`Δpos[0] / 444.444 / 3s`) at 50% deflection — this calibrates `maxJogDps` and directly informs the feedforward's accuracy.
- **Pan does not move, or the rig hangs** → the jog path has the goto bug's twin. Do Step 4.

- [ ] **Step 4 (ONLY if Step 3 showed no motion): Initialize motion params on the jog path**

Mirror the fix already proven in `tb3_goto_execute`. In `src/TB3_WebGlue.ino`, find the joystick/jog entry point and initialize the same params before the first jog move, exactly as `tb3_goto_execute` does:

```cpp
  for (int i = 0; i < 3; i++) setPulsesPerSecond(i, 10000);  // 22.5 deg/s
  motors[0].jogMaxVelocity = PAN_MAX_JOG_STEPS_PER_SEC;
  motors[0].jogMaxAcceleration = PAN_MAX_JOG_STEPS_PER_SEC / 2;
  motors[1].jogMaxVelocity = TILT_MAX_JOG_STEPS_PER_SEC;
  motors[1].jogMaxAcceleration = TILT_MAX_JOG_STEPS_PER_SEC / 2;
  motors[2].jogMaxVelocity = AUX_MAX_JOG_STEPS_PER_SEC;
  motors[2].jogMaxAcceleration = AUX_MAX_JOG_STEPS_PER_SEC / 2;
```

Guard it so it runs once (a `static bool jog_params_ready` latch), rebuild, OTA-deploy, and re-run Step 2 to confirm motion. Then commit:

```bash
git add src/TB3_WebGlue.ino
git commit -m "fix(jog): initialize motor motion params on the joystick path"
```

- [ ] **Step 5: Report the measured °/s at 50% deflection to the controller** — it sets the real `maxJogDps` default.

---

### Task 1: Geo primitives for tracking (`add`, `enuPosition`)

**Files:**
- Modify: `tb3-mcp/src/geo/vec3.ts`
- Modify: `tb3-mcp/src/geo/wgs84.ts`
- Test: `tb3-mcp/test/vec3.test.ts`, `tb3-mcp/test/wgs84.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `sub`, `norm`, `normalize`, `geodeticToEcef`, `Geodetic` (existing).
- Produces: `add(a: Vec3, b: Vec3): Vec3`; `enuPosition(rig: Geodetic, target: Geodetic): Vec3` — the **unnormalized** ENU position of `target` relative to `rig`, in meters.

**Why:** `enuDirection` returns only a normalized unit vector, but the estimator must extrapolate a *position* (`p + v·Δt`), and `ecefDeltaToEnu` is private. `vec3` has no `add`.

- [ ] **Step 1: Write the failing tests**

Append to `tb3-mcp/test/vec3.test.ts`:

```ts
describe("add", () => {
  it("adds componentwise", () => {
    expect(add([1, 2, 3], [10, 20, 30])).toEqual([11, 22, 33]);
  });
});
```

Add `add` to that file's existing import from `../src/geo/vec3.js`.

Append to `tb3-mcp/test/wgs84.test.ts`:

```ts
describe("enuPosition", () => {
  it("a target directly above the rig is straight Up", () => {
    const rig = { lat: 45, lon: 10, height: 100 };
    const p = enuPosition(rig, { lat: 45, lon: 10, height: 1100 });
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(1000, 6);
  });

  it("a target 1km north reads ~1km North with a small curvature drop", () => {
    const rig = { lat: 45, lon: 10, height: 0 };
    // ~1km north: 1 degree of latitude is ~111.32 km.
    const p = enuPosition(rig, { lat: 45 + 1 / 111.32, lon: 10, height: 0 });
    expect(p[0]).toBeCloseTo(0, 3);
    expect(p[1]).toBeGreaterThan(990);
    expect(p[1]).toBeLessThan(1010);
    // Earth curvature drops the far point ~d^2/2R = ~0.078 m below the tangent plane.
    expect(p[2]).toBeLessThan(0);
    expect(p[2]).toBeGreaterThan(-0.2);
  });

  it("enuDirection is exactly the normalized enuPosition", () => {
    const rig = { lat: 45, lon: 10, height: 0 };
    const tgt = { lat: 45.5, lon: 10.7, height: 2000 };
    const p = enuPosition(rig, tgt);
    const d = enuDirection(rig, tgt);
    const n = Math.hypot(p[0], p[1], p[2]);
    expect(d.range).toBeCloseTo(n, 6);
    expect(d.unit[0]).toBeCloseTo(p[0] / n, 12);
    expect(d.unit[1]).toBeCloseTo(p[1] / n, 12);
    expect(d.unit[2]).toBeCloseTo(p[2] / n, 12);
  });
});
```

Add `enuPosition` to that file's existing import from `../src/geo/wgs84.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/vec3.test.ts test/wgs84.test.ts`
Expected: FAIL — `add is not a function` / `enuPosition is not a function`.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/geo/vec3.ts`, add next to `sub`:

```ts
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
```

In `tb3-mcp/src/geo/wgs84.ts`, add `enuPosition` and re-express `enuDirection` on top of it (DRY — one ENU conversion path):

```ts
// The unnormalized ENU position of `target` relative to `rig`, in meters.
export function enuPosition(rig: Geodetic, target: Geodetic): Vec3 {
  const delta = sub(geodeticToEcef(target), geodeticToEcef(rig));
  return ecefDeltaToEnu(rig, delta);
}

export function enuDirection(rig: Geodetic, target: Geodetic): { unit: Vec3; range: number } {
  const enu = enuPosition(rig, target);
  const range = norm(enu);
  return { unit: normalize(enu), range };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/vec3.test.ts test/wgs84.test.ts`
Expected: PASS. Then `npx vitest run` — all existing tests still pass (`enuDirection`'s behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/geo/vec3.ts src/geo/wgs84.ts test/vec3.test.ts test/wgs84.test.ts
git commit -m "feat(track): add vec3.add and wgs84.enuPosition for target extrapolation"
```

---

### Task 2: Tracking configuration keys

**Files:**
- Modify: `tb3-mcp/src/config.ts`
- Test: `tb3-mcp/test/config.test.ts`

**Interfaces:**
- Produces: `Config` gains `trackTickHz`, `trackKp`, `trackLeadMs`, `trackMaxTargetAgeMs`, `trackStaleTelemetryMs`, `trackDeadmanMs`, `trackReacquireDeg`, `jogVectorTtlMs` — all `number`, all required-with-default (never undefined at use sites).

- [ ] **Step 1: Write the failing test**

Append to `tb3-mcp/test/config.test.ts`:

```ts
describe("tracking config", () => {
  it("defaults every tracking key", () => {
    const c = loadConfig(undefined, {});
    expect(c.trackTickHz).toBe(10);
    expect(c.trackKp).toBe(1.0);
    expect(c.trackLeadMs).toBe(150);
    expect(c.trackMaxTargetAgeMs).toBe(5000);
    expect(c.trackStaleTelemetryMs).toBe(1000);
    expect(c.trackDeadmanMs).toBe(120000);
    expect(c.trackReacquireDeg).toBe(10);
    expect(c.jogVectorTtlMs).toBe(500);
  });

  it("overrides tracking keys from env", () => {
    const c = loadConfig(undefined, { TB3_TRACK_KP: "2.5", TB3_JOG_VECTOR_TTL_MS: "250" });
    expect(c.trackKp).toBe(2.5);
    expect(c.jogVectorTtlMs).toBe(250);
  });

  it("rejects a non-positive tick rate", () => {
    expect(() => loadConfig(undefined, { TB3_TRACK_TICK_HZ: "0" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `expected undefined to be 10`.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/config.ts`, add to `ConfigSchema` after `calibrationFile`:

```ts
    trackTickHz: z.number().positive().max(50).default(10),
    trackKp: z.number().nonnegative().default(1.0),
    trackLeadMs: z.number().nonnegative().max(5000).default(150),
    trackMaxTargetAgeMs: z.number().positive().default(5000),
    trackStaleTelemetryMs: z.number().positive().default(1000),
    trackDeadmanMs: z.number().positive().default(120000),
    trackReacquireDeg: z.number().positive().max(180).default(10),
    jogVectorTtlMs: z.number().positive().default(500),
```

And in `loadConfig`, after `set("calibrationFile", env.TB3_CALIBRATION_FILE);`:

```ts
  set("trackTickHz", num(env.TB3_TRACK_TICK_HZ));
  set("trackKp", num(env.TB3_TRACK_KP));
  set("trackLeadMs", num(env.TB3_TRACK_LEAD_MS));
  set("trackMaxTargetAgeMs", num(env.TB3_TRACK_MAX_TARGET_AGE_MS));
  set("trackStaleTelemetryMs", num(env.TB3_TRACK_STALE_TELEMETRY_MS));
  set("trackDeadmanMs", num(env.TB3_TRACK_DEADMAN_MS));
  set("trackReacquireDeg", num(env.TB3_TRACK_REACQUIRE_DEG));
  set("jogVectorTtlMs", num(env.TB3_JOG_VECTOR_TTL_MS));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(track): tracking control and safety config keys"
```

---

### Task 3: Target estimator (pure)

**Files:**
- Create: `tb3-mcp/src/track/estimator.ts`
- Test: `tb3-mcp/test/estimator.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `add`, `sub`, `scale`, `deg2rad` from `../geo/vec3.js`; `Geodetic`, `enuPosition` from `../geo/wgs84.js`.
- Produces:
  - `interface EstimatorState { readonly fix: EnuFix | null; readonly prevFix: EnuFix | null; readonly statedVel: Vec3 | null }`
  - `interface EnuFix { readonly enu: Vec3; readonly tMs: number }`
  - `emptyEstimator(): EstimatorState`
  - `velocityFromSpeedHeading(speedMps: number, headingDeg: number, climbMps: number): Vec3`
  - `withFix(s: EstimatorState, rig: Geodetic, g: Geodetic, tMs: number, statedVel: Vec3 | null): EstimatorState`
  - `velocityOf(s: EstimatorState): Vec3`
  - `estimateAt(s: EstimatorState, tMs: number): Vec3 | null`
  - `lastFixMs(s: EstimatorState): number | null`

Pure and immutable: `withFix` returns a NEW state, never mutates.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/estimator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyEstimator, withFix, velocityOf, estimateAt, lastFixMs, velocityFromSpeedHeading,
} from "../src/track/estimator.js";

const RIG = { lat: 45, lon: 10, height: 0 };

describe("velocityFromSpeedHeading", () => {
  it("heading 0 is due North", () => {
    const v = velocityFromSpeedHeading(100, 0, 0);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[1]).toBeCloseTo(100, 9);
    expect(v[2]).toBeCloseTo(0, 9);
  });

  it("heading 90 is due East, and climb is Up", () => {
    const v = velocityFromSpeedHeading(100, 90, 5);
    expect(v[0]).toBeCloseTo(100, 9);
    expect(v[1]).toBeCloseTo(0, 9);
    expect(v[2]).toBeCloseTo(5, 9);
  });
});

describe("estimator", () => {
  it("returns null before any fix", () => {
    expect(estimateAt(emptyEstimator(), 1000)).toBeNull();
    expect(lastFixMs(emptyEstimator())).toBeNull();
  });

  it("a stated velocity extrapolates linearly in ENU", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [10, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p2 = estimateAt(s, 3000)!;   // +2s at 10 m/s East
    expect(p2[0] - p0[0]).toBeCloseTo(20, 6);
    expect(p2[1] - p0[1]).toBeCloseTo(0, 6);
    expect(p2[2] - p0[2]).toBeCloseTo(0, 6);
  });

  it("holds position when velocity is zero and none can be derived", () => {
    const s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    expect(velocityOf(s)).toEqual([0, 0, 0]);
    const p0 = estimateAt(s, 1000)!;
    const p9 = estimateAt(s, 9999)!;
    expect(p9).toEqual(p0);
  });

  it("derives velocity from two successive fixes when none is stated", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    // Second fix 1000m up, 2 seconds later => +500 m/s Up.
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, null);
    const v = velocityOf(s);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(0, 6);
    expect(v[2]).toBeCloseTo(500, 6);
  });

  it("a stated velocity takes precedence over one derivable from fixes", () => {
    let s = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, null);
    s = withFix(s, RIG, { lat: 45, lon: 10, height: 2000 }, 3000, [1, 2, 3]);
    expect(velocityOf(s)).toEqual([1, 2, 3]);
  });

  it("withFix does not mutate the state it is given", () => {
    const a = withFix(emptyEstimator(), RIG, { lat: 45, lon: 10, height: 1000 }, 1000, [1, 0, 0]);
    const before = estimateAt(a, 5000)!;
    withFix(a, RIG, { lat: 46, lon: 11, height: 9000 }, 4000, [9, 9, 9]);
    expect(estimateAt(a, 5000)).toEqual(before);
    expect(lastFixMs(a)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/estimator.test.ts`
Expected: FAIL — cannot find module `../src/track/estimator.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/track/estimator.ts`:

```ts
import { Vec3, add, sub, scale, deg2rad } from "../geo/vec3.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";

export interface EnuFix {
  readonly enu: Vec3;   // meters, relative to the rig
  readonly tMs: number;
}

export interface EstimatorState {
  readonly fix: EnuFix | null;
  readonly prevFix: EnuFix | null;
  readonly statedVel: Vec3 | null;  // ENU m/s
}

export function emptyEstimator(): EstimatorState {
  return { fix: null, prevFix: null, statedVel: null };
}

// Aviation-natural velocity -> ENU. Heading 0 = North, 90 = East.
export function velocityFromSpeedHeading(speedMps: number, headingDeg: number, climbMps: number): Vec3 {
  const h = deg2rad(headingDeg);
  return [speedMps * Math.sin(h), speedMps * Math.cos(h), climbMps];
}

export function withFix(
  s: EstimatorState, rig: Geodetic, g: Geodetic, tMs: number, statedVel: Vec3 | null,
): EstimatorState {
  return { fix: { enu: enuPosition(rig, g), tMs }, prevFix: s.fix, statedVel };
}

export function velocityOf(s: EstimatorState): Vec3 {
  if (s.statedVel) return s.statedVel;
  if (s.fix && s.prevFix) {
    const dtSec = (s.fix.tMs - s.prevFix.tMs) / 1000;
    if (dtSec > 0) return scale(sub(s.fix.enu, s.prevFix.enu), 1 / dtSec);
  }
  return [0, 0, 0];
}

// Constant-velocity extrapolation in the rig's ENU frame. Straight-line ENU is
// an excellent model here: a 300mph target over a 10s horizon covers ~1.3km,
// across which earth curvature drops ~0.13m — far below achievable pointing.
export function estimateAt(s: EstimatorState, tMs: number): Vec3 | null {
  if (!s.fix) return null;
  const dtSec = (tMs - s.fix.tMs) / 1000;
  return add(s.fix.enu, scale(velocityOf(s), dtSec));
}

export function lastFixMs(s: EstimatorState): number | null {
  return s.fix?.tMs ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/estimator.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/track/estimator.ts test/estimator.test.ts
git commit -m "feat(track): pure target estimator with ENU constant-velocity extrapolation"
```

---

### Task 4: Control law (pure)

**Files:**
- Create: `tb3-mcp/src/track/control.ts`
- Test: `tb3-mcp/test/control.test.ts`

**Interfaces:**
- Consumes: `Vec3`, `Mat3`, `matVec`, `norm`, `normalize` from `../geo/vec3.js`; `panTiltToMount` from `../geo/boresight.js`; `enuToPanTilt` from `../geo/orientation.js`; `EstimatorState`, `estimateAt` from `./estimator.js`.
- Produces:
  - `wrapDeg180(d: number): number` — wrap to `(-180, 180]`, matching `mountToPanTilt`'s `atan2`, which already returns that half-open interval upstream. (The only functional difference from `[-180, 180)` is the exactly-antipodal case, where both directions are equally short — a tie, not a bug.)
  - `boresightEnu(R: Mat3, panDeg: number, tiltDeg: number): Vec3` — where the rig points, in ENU
  - `interface TargetAim { panDeg; tiltDeg; ratePanDps; rateTiltDps; enuUnit: Vec3; rangeM: number }`
  - `targetAimAt(s: EstimatorState, R: Mat3, tMs: number): TargetAim | null`
  - `interface ControlOutput { readonly panDps: number; readonly tiltDps: number }`
  - `controlRate(aim, rigPanDeg, rigTiltDeg, kp, maxJogDps): ControlOutput`
  - `limitGuard(out, rigPanDeg, rigTiltDeg, limits, horizonMs): { out: ControlOutput; panBlocked: boolean; tiltBlocked: boolean }`

**Why finite-difference the feedforward:** the estimate is a smooth analytic function, not a sensor reading — there is no noise for differencing to amplify, so it is safe here and avoids hand-deriving (and testing) the closed-form Jacobian. It is a first-order approximation, not exact (pan/tilt is a nonlinear `atan2`/`asin` of a linearly-extrapolated position), but the error at Δt = 10 ms is negligible against realistic target dynamics.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/control.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { wrapDeg180, boresightEnu, targetAimAt, controlRate, limitGuard } from "../src/track/control.js";
import { emptyEstimator, withFix } from "../src/track/estimator.js";

// Identity R means the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. That makes every expectation below hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
const LIMITS = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };

describe("wrapDeg180", () => {
  it("leaves in-range angles alone", () => {
    expect(wrapDeg180(0)).toBe(0);
    expect(wrapDeg180(179)).toBe(179);
    expect(wrapDeg180(-179)).toBe(-179);
  });
  it("wraps the short way across the seam", () => {
    expect(wrapDeg180(358)).toBeCloseTo(-2, 9);
    expect(wrapDeg180(-358)).toBeCloseTo(2, 9);
    expect(wrapDeg180(540)).toBeCloseTo(180, 9);
  });
});

describe("boresightEnu", () => {
  it("under identity R, pan 0/tilt 0 points due North", () => {
    const u = boresightEnu(I, 0, 0);
    expect(u[0]).toBeCloseTo(0, 9);
    expect(u[1]).toBeCloseTo(1, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
  it("under identity R, pan 90 points due East", () => {
    const u = boresightEnu(I, 90, 0);
    expect(u[0]).toBeCloseTo(1, 9);
    expect(u[1]).toBeCloseTo(0, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
});

describe("targetAimAt", () => {
  it("returns null with no fix", () => {
    expect(targetAimAt(emptyEstimator(), I, 1000)).toBeNull();
  });

  it("aims North at a stationary target due north, with zero rate", () => {
    // 10km north, level with the rig.
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 10 / 111.32, lon: 10, height: 0 }, 1000, [0, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.panDeg).toBeCloseTo(0, 3);
    expect(aim.ratePanDps).toBeCloseTo(0, 6);
    expect(aim.rateTiltDps).toBeCloseTo(0, 6);
    expect(aim.rangeM).toBeGreaterThan(9000);
  });

  it("feedforward matches the analytic rate for a crossing target", () => {
    // 1000m due north, flying East at 100 m/s, level. At the crossing point the
    // line of sight is 1000m and fully perpendicular to velocity, so the
    // angular rate is v/r = 100/1000 = 0.1 rad/s = 5.7296 deg/s, increasing
    // azimuth (turning from North toward East).
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 1 / 111.32, lon: 10, height: 0 }, 1000, [100, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.ratePanDps).toBeCloseTo((100 / 1000) * (180 / Math.PI), 1);
  });
});

describe("controlRate", () => {
  const aim = { panDeg: 10, tiltDeg: 5, ratePanDps: 2, rateTiltDps: -1, enuUnit: [0, 1, 0] as const, rangeM: 1000 };

  it("with zero error the command is pure feedforward", () => {
    const out = controlRate(aim, 10, 5, 1.0, 20);
    expect(out.panDps).toBeCloseTo(2, 9);
    expect(out.tiltDps).toBeCloseTo(-1, 9);
  });

  it("with a static target the command is pure proportional", () => {
    const still = { ...aim, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(still, 8, 5, 1.5, 20);
    expect(out.panDps).toBeCloseTo(1.5 * 2, 9);  // Kp * 2 deg of error
    expect(out.tiltDps).toBeCloseTo(0, 9);
  });

  it("takes the short way around the pan seam", () => {
    // Target at -179, rig at 179 => error is +2, NOT -358.
    const seam = { ...aim, panDeg: -179, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(seam, 179, 5, 1.0, 20);
    expect(out.panDps).toBeCloseTo(2, 9);
  });

  it("clamps to maxJogDps", () => {
    const far = { ...aim, panDeg: 170, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(far, 0, 5, 1.0, 20);
    expect(out.panDps).toBe(20);
  });

  it("clamps negatively too", () => {
    const far = { ...aim, panDeg: -170, ratePanDps: 0, rateTiltDps: 0 };
    const out = controlRate(far, 0, 5, 1.0, 20);
    expect(out.panDps).toBe(-20);
  });
});

describe("limitGuard", () => {
  it("passes a rate that stays in range", () => {
    const g = limitGuard({ panDps: 5, tiltDps: 0 }, 0, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(5);
    expect(g.panBlocked).toBe(false);
  });

  it("zeroes an axis whose predicted position would breach its limit", () => {
    // At pan 179 moving +20 deg/s, in 300ms we reach ~185 > panMax 180.
    const g = limitGuard({ panDps: 20, tiltDps: 0 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(0);
    expect(g.panBlocked).toBe(true);
  });

  it("blocks per-axis: pan held, tilt still tracking", () => {
    const g = limitGuard({ panDps: 20, tiltDps: 3 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(0);
    expect(g.out.tiltDps).toBe(3);
    expect(g.tiltBlocked).toBe(false);
  });

  it("allows moving away from a limit it is already at", () => {
    const g = limitGuard({ panDps: -20, tiltDps: 0 }, 179, 0, LIMITS, 300);
    expect(g.out.panDps).toBe(-20);
    expect(g.panBlocked).toBe(false);
  });

  it("guards the tilt floor (below-horizon)", () => {
    const g = limitGuard({ panDps: 0, tiltDps: -20 }, 0, -89, LIMITS, 300);
    expect(g.out.tiltDps).toBe(0);
    expect(g.tiltBlocked).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/control.test.ts`
Expected: FAIL — cannot find module `../src/track/control.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/track/control.ts`:

```ts
import { Vec3, Mat3, matVec, norm, normalize } from "../geo/vec3.js";
import { panTiltToMount } from "../geo/boresight.js";
import { enuToPanTilt } from "../geo/orientation.js";
import { EstimatorState, estimateAt } from "./estimator.js";

// Feedforward finite-difference step. The estimate is a smooth analytic
// function (not a sensor), so differencing is exact here.
const FF_DELTA_MS = 10;

// Below this range the pointing direction is undefined.
const MIN_RANGE_M = 1e-3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Wrap to (-180, 180] so errors always take the short way round. This matches
// mountToPanTilt's atan2, which already returns (-180, 180] upstream.
export function wrapDeg180(d: number): number {
  const x = (((d % 360) + 360) % 360);
  return x > 180 ? x - 360 : x;
}

// Where the rig is actually pointing, as an ENU unit vector. R maps mount->ENU.
export function boresightEnu(R: Mat3, panDeg: number, tiltDeg: number): Vec3 {
  return matVec(R, panTiltToMount(panDeg, tiltDeg));
}

export interface TargetAim {
  readonly panDeg: number;      // user frame
  readonly tiltDeg: number;     // user frame
  readonly ratePanDps: number;  // feedforward
  readonly rateTiltDps: number; // feedforward
  readonly enuUnit: Vec3;
  readonly rangeM: number;
}

// Where the target is at tMs, and how fast that aim point is moving.
export function targetAimAt(s: EstimatorState, R: Mat3, tMs: number): TargetAim | null {
  const p0 = estimateAt(s, tMs);
  const p1 = estimateAt(s, tMs + FF_DELTA_MS);
  if (!p0 || !p1) return null;
  const rangeM = norm(p0);
  if (rangeM < MIN_RANGE_M) return null;
  const u0 = normalize(p0);
  const a = enuToPanTilt(R, u0);
  const b = enuToPanTilt(R, normalize(p1));
  const dtSec = FF_DELTA_MS / 1000;
  return {
    panDeg: a.panDeg,
    tiltDeg: a.tiltDeg,
    ratePanDps: wrapDeg180(b.panDeg - a.panDeg) / dtSec,
    rateTiltDps: (b.tiltDeg - a.tiltDeg) / dtSec,
    enuUnit: u0,
    rangeM,
  };
}

export interface ControlOutput {
  readonly panDps: number;
  readonly tiltDps: number;
}

// rate = feedforward + Kp * error, clamped. P only — feedforward does the
// heavy lifting, so an integral term would fight it and wind up at the limits.
export function controlRate(
  aim: Pick<TargetAim, "panDeg" | "tiltDeg" | "ratePanDps" | "rateTiltDps">,
  rigPanDeg: number, rigTiltDeg: number, kp: number, maxJogDps: number,
): ControlOutput {
  const errPan = wrapDeg180(aim.panDeg - rigPanDeg);
  const errTilt = aim.tiltDeg - rigTiltDeg;   // tilt is bounded, it never wraps
  return {
    panDps: clamp(aim.ratePanDps + kp * errPan, -maxJogDps, maxJogDps),
    tiltDps: clamp(aim.rateTiltDps + kp * errTilt, -maxJogDps, maxJogDps),
  };
}

export interface GuardLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

// The jog path does NOT enforce soft limits and the rig has no endstops, so the
// session must. Check the PREDICTED position over `horizonMs`, not the current
// one: by the time we are outside, it is already too late.
export function limitGuard(
  out: ControlOutput, rigPanDeg: number, rigTiltDeg: number,
  limits: GuardLimits, horizonMs: number,
): { out: ControlOutput; panBlocked: boolean; tiltBlocked: boolean } {
  const h = horizonMs / 1000;
  const predPan = rigPanDeg + out.panDps * h;
  const predTilt = rigTiltDeg + out.tiltDps * h;
  const panBlocked = predPan > limits.panMax || predPan < limits.panMin;
  const tiltBlocked = predTilt > limits.tiltMax || predTilt < limits.tiltMin;
  return {
    out: {
      panDps: panBlocked ? 0 : out.panDps,
      tiltDps: tiltBlocked ? 0 : out.tiltDps,
    },
    panBlocked,
    tiltBlocked,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/control.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/track/control.ts test/control.test.ts
git commit -m "feat(track): pure control law - feedforward + P, pan-seam wrap, predictive limit guard"
```

---

### Task 5: Device sticky jog vector with TTL watchdog

**Files:**
- Modify: `tb3-mcp/src/device.ts`
- Test: `tb3-mcp/test/device-jog.test.ts`

**Interfaces:**
- Produces on `Device`:
  - `constructor(cfg: Config, now?: () => number)` — clock injected, defaults to `Date.now`
  - `setJogVector(x: number, y: number, aux: number, ttlMs: number): void`
  - `clearJog(): void`
  - existing `jog(x, y, aux, durationMs): Promise<void>` — unchanged signature, now built on the vector

**The point of this task:** the most dangerous failure available to layer 3 is a **sticky rate plus a dead loop** — if the session throws, stalls, or the event loop wedges after setting a vector, the rig slews until something breaks. A `try/catch` in the session cannot fire if the event loop stalls. So the watchdog lives here, in the component that actually holds the hazard: a vector that is not refreshed within its TTL is dropped and zeroed. The session must keep proving it is alive for the rig to keep moving.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/device-jog.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";

const PORT = 8795;
let mock: MockTb3;
let device: Device;
let clockMs = 1_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  clockMs = 1_000_000;
  mock = new MockTb3();
  await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  device = new Device(cfg, () => clockMs);
  device.start();
  await sleep(150);   // let the websocket connect
});

afterEach(async () => {
  device.close();
  await mock.stop();
});

describe("Device jog vector", () => {
  it("repeats the vector to the device while it is fresh", async () => {
    device.setJogVector(50, -25, 0, 500);
    await sleep(250);
    expect(mock.lastJog).toEqual({ x: 50, y: -25, aux: 0 });
  });

  it("clearJog zeroes the vector immediately", async () => {
    device.setJogVector(50, 0, 0, 500);
    await sleep(150);
    device.clearJog();
    await sleep(50);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("SAFETY: an un-refreshed vector expires and the rig is zeroed", async () => {
    device.setJogVector(80, 0, 0, 500);
    await sleep(150);
    expect(mock.lastJog).toEqual({ x: 80, y: 0, aux: 0 });

    // Simulate the session dying: nothing refreshes the vector, and time passes
    // beyond its TTL. The keep-alive must refuse to re-send it and zero instead.
    clockMs += 600;
    await sleep(250);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });

  it("SAFETY: a refreshed vector keeps running past the TTL", async () => {
    for (let i = 0; i < 6; i++) {
      device.setJogVector(40, 0, 0, 500);
      clockMs += 100;
      await sleep(60);
    }
    expect(mock.lastJog).toEqual({ x: 40, y: 0, aux: 0 });
  });

  it("the timed jog tool path still zeroes when it finishes", async () => {
    await device.jog(30, 0, 0, 300);
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/device-jog.test.ts`
Expected: FAIL — `device.setJogVector is not a function`.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/device.ts`:

Add near the other module constants:

```ts
const JOG_KEEPALIVE_MS = 100;
```

Add the clock to the constructor and fields (replace the existing constructor):

```ts
  private jogVec: { x: number; y: number; aux: number; expiresAtMs: number } | null = null;
  private jogTimer: NodeJS.Timeout | null = null;

  constructor(cfg: Config, private readonly now: () => number = Date.now) {
    this.cfg = cfg;
    this.hosts = cfg.deviceIpFallback ? [cfg.deviceHost, cfg.deviceIpFallback] : [cfg.deviceHost];
  }
```

(Keep the existing body of the constructor — only add the `now` parameter. If the current constructor body differs, preserve it verbatim and add the parameter.)

Replace the whole existing `jog` method with the vector implementation:

```ts
  private sendJog(x: number, y: number, aux: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ x, y, aux }));
    }
  }

  private stopJogTimer(): void {
    if (this.jogTimer) { clearInterval(this.jogTimer); this.jogTimer = null; }
  }

  // The keep-alive. A vector older than its TTL means whoever set it stopped
  // proving it was alive — drop it and zero the rig rather than keep slewing.
  private pumpJog(): void {
    const v = this.jogVec;
    if (!v) { this.stopJogTimer(); return; }
    if (this.now() >= v.expiresAtMs) {
      this.jogVec = null;
      this.sendJog(0, 0, 0);
      this.stopJogTimer();
      return;
    }
    this.sendJog(v.x, v.y, v.aux);
  }

  // Set a sticky rate that is repeated to the device until it expires. The
  // caller MUST keep refreshing it; see pumpJog.
  setJogVector(x: number, y: number, aux: number, ttlMs: number): void {
    this.jogVec = { x, y, aux, expiresAtMs: this.now() + ttlMs };
    this.sendJog(x, y, aux);
    if (!this.jogTimer) this.jogTimer = setInterval(() => this.pumpJog(), JOG_KEEPALIVE_MS);
  }

  clearJog(): void {
    this.jogVec = null;
    this.stopJogTimer();
    this.sendJog(0, 0, 0);
  }

  // Timed jog (the manual `jog` tool), built on the same vector so there is
  // exactly one keep-alive owner.
  async jog(x: number, y: number, aux: number, durationMs: number): Promise<void> {
    const deadline = this.now() + durationMs;
    while (this.now() < deadline) {
      this.setJogVector(x, y, aux, JOG_KEEPALIVE_MS * 5);
      await new Promise((res) => setTimeout(res, JOG_KEEPALIVE_MS));
    }
    this.clearJog();
  }
```

In `close()`, add `this.stopJogTimer();` so a closed device leaves no timer running.

Replace every remaining `Date.now()` in `device.ts` with `this.now()` (in `onTick` and `waitForArrival`) so the injected clock is honoured consistently.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/device-jog.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run` — the existing `jog` tool tests must still pass (its signature is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/device.ts test/device-jog.test.ts
git commit -m "feat(track): TTL-guarded sticky jog vector - a stalled owner stops the rig"
```

---

### Task 6: Cubic deflection mapping + tracking session state machine

**Files:**
- Modify: `tb3-mcp/src/track/control.ts` (add `rateToDeflection`)
- Modify: `tb3-mcp/test/control.test.ts` (test it)
- Create: `tb3-mcp/src/track/session.ts`
- Test: `tb3-mcp/test/session.test.ts`

#### Part A first: `rateToDeflection` (pure, in `control.ts`)

**This is the actuator mapping, and getting it wrong silently corrupts the entire servo.** Measured on real hardware (see the spec's "Hardware reality" §2), the firmware maps joystick deflection to rate through a **cubic** curve with a deadband, *not* linearly:

```
|x| < 6   -> 0                            (deadband, axis_button_deadzone)
joy_db     = |x| - 5
rate      ~= maxJogDps * (joy_db / 95)^3  (updateMotorVelocities2's "exponential curve")
```

Measured fit, normalised to full deflection — cubic total error **0.033**, linear **0.951**:

| deflection | measured | cubic | linear |
|---|---|---|---|
| 25 | 0.010 | 0.009 | 0.250 |
| 50 | 0.116 | 0.106 | 0.500 |
| 75 | 0.423 | 0.400 | 0.750 |
| 100 | 1.000 | 1.000 | 1.000 |

So the servo must **invert** it:

```ts
// Deflection units the firmware's cubic curve maps to full rate: |x|=100
// minus the deadband offset of 5.
const JOY_SPAN = 95;
const JOY_DEADBAND = 5;

// Convert a desired rate (deg/s, already sign-corrected for the axis) into a
// joystick deflection, inverting the firmware's cubic curve.
//
// Layer 1's `jog` tool maps this LINEARLY on purpose -- it is a human-in-the-
// loop framing nudge where "approximately" is fine. The servo has no such
// luxury: feedforward IS the design, so its mapping must match the hardware.
export function rateToDeflection(dps: number, maxJogDps: number): number {
  const f = Math.min(Math.abs(dps) / maxJogDps, 1);
  if (f <= 0) return 0;
  const joyDb = JOY_SPAN * Math.cbrt(f);
  const x = Math.round(joyDb + JOY_DEADBAND);
  return Math.sign(dps) * Math.min(x, 100);
}
```

- [ ] **Step A1: Write the failing tests** — append to `tb3-mcp/test/control.test.ts`:

```ts
describe("rateToDeflection (inverts the firmware's cubic jog curve)", () => {
  const MAX = 22.5;

  it("zero rate is zero deflection", () => {
    expect(rateToDeflection(0, MAX)).toBe(0);
  });

  it("full rate is full deflection", () => {
    expect(rateToDeflection(MAX, MAX)).toBe(100);
    expect(rateToDeflection(-MAX, MAX)).toBe(-100);
  });

  it("saturates rather than exceeding full deflection", () => {
    expect(rateToDeflection(MAX * 10, MAX)).toBe(100);
    expect(rateToDeflection(-MAX * 10, MAX)).toBe(-100);
  });

  it("round-trips through the firmware's own curve", () => {
    // The firmware: rate = MAX * ((|x|-5)/95)^3. Feed a rate in, get a
    // deflection, push it back through the firmware curve, expect the rate.
    const firmwareRate = (x: number) => {
      if (Math.abs(x) < 6) return 0;
      const db = Math.abs(x) - 5;
      return Math.sign(x) * MAX * Math.pow(db / 95, 3);
    };
    for (const r of [1, 2.5, 5, 10, 17, 22.5]) {
      const x = rateToDeflection(r, MAX);
      expect(firmwareRate(x)).toBeCloseTo(r, 0);   // integer x quantises it
    }
  });

  it("is emphatically NOT linear — half rate needs far more than half deflection", () => {
    // Linear would say 50. The cubic needs ~80: (75/95)^3 = 0.49.
    const x = rateToDeflection(MAX / 2, MAX);
    expect(x).toBeGreaterThan(70);
    expect(x).toBeLessThan(90);
  });

  it("matches the hardware-measured points", () => {
    // Measured: x=50 -> 0.116 of full rate; x=75 -> 0.423 of full rate.
    expect(rateToDeflection(MAX * 0.116, MAX)).toBeCloseTo(50, -0.5);
    expect(rateToDeflection(MAX * 0.423, MAX)).toBeCloseTo(75, -0.5);
  });
});
```

- [ ] **Step A2:** Run `npx vitest run test/control.test.ts` — expect FAIL (`rateToDeflection is not a function`).
- [ ] **Step A3:** Implement `rateToDeflection` in `src/track/control.ts` exactly as given above.
- [ ] **Step A4:** Run `npx vitest run test/control.test.ts` — expect PASS.
- [ ] **Step A5: Commit**

```bash
git add src/track/control.ts test/control.test.ts
git commit -m "feat(track): invert the firmware's cubic jog curve"
```

#### Part B: the session

**Interfaces:**
- Consumes: `Device`, `Config`, `CalibrationStore`, `moveToUserAngle` from `../move.js`, `reachablePanTilt` from `../geo-tools.js`, `stepsToDeg`/`applySign` from `../angles.js`, `angleBetweenDeg` from `../geo/vec3.js`, and all of `./estimator.js` + `./control.js` (including `rateToDeflection` from Part A).
- Produces:
  - `type TrackState = "stopped" | "acquiring" | "tracking" | "waiting"`
  - `type WaitReason = "below_tilt_limit" | "pan_limit" | "target_stale" | "telemetry_stale" | "program_engaged" | "not_calibrated"`
  - `interface TrackStatus { ... }` (fields listed in the implementation below)
  - `interface Scheduler { every(ms: number, fn: () => void): { cancel(): void } }`
  - `class TrackingSession` with `start(g, statedVel, label): string | null`, `updateTarget(g, statedVel): string | null`, `stop(): void`, `status(): TrackStatus`, `isActive(): boolean`
  - `start`/`updateTarget` return an error string, or `null` on success.

The clock and scheduler are injected so tests drive time explicitly instead of sleeping.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/track/session.js";
import { CalibrationStore } from "../src/calibration.js";
import { loadConfig, type Config } from "../src/config.js";
import { STEPS_PER_DEG } from "../src/angles.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level: pan 0 / tilt ~0 under identity R.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

// A hand-driven scheduler: tests call fire() instead of waiting.
function manualScheduler(): Scheduler & { fire(): void; cancelled(): boolean } {
  let fn: (() => void) | null = null;
  let cancelledFlag = false;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; cancelledFlag = true; } }; },
    fire() { fn?.(); },
    cancelled() { return cancelledFlag; },
  };
}

class FakeDevice {
  panSteps = 0; tiltSteps = 0; moving = false; programEngaged = false;
  lastUpdateMs = 1_000_000;
  jogVec: { x: number; y: number; aux: number } | null = null;
  cleared = 0;
  gotos: { pan: number; tilt: number }[] = [];
  getState() {
    return {
      connected: true, panSteps: this.panSteps, tiltSteps: this.tiltSteps, auxSteps: 0,
      moving: this.moving, programEngaged: this.programEngaged, batteryV: 12,
      staIp: "1.2.3.4", lastUpdateMs: this.lastUpdateMs,
    };
  }
  setJogVector(x: number, y: number, aux: number) { this.jogVec = { x, y, aux }; }
  clearJog() { this.jogVec = null; this.cleared++; }
  async gotoAngle(pan: number, tilt: number) { this.gotos.push({ pan, tilt }); }
  async waitForArrival() { return this.getState(); }
  async stop() {}
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

function newSession(): TrackingSession {
  return new TrackingSession(dev as never, cfg, store, () => clockMs, sched);
}

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sess-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("TrackingSession lifecycle", () => {
  it("starts stopped", () => {
    expect(newSession().status().state).toBe("stopped");
  });

  it("refuses to start without a calibration", () => {
    store.clear();
    const s = newSession();
    expect(s.start(NORTH, null, null)).toMatch(/calibrat/i);
    expect(s.status().state).toBe("stopped");
  });

  it("start enters acquiring and issues a goto", () => {
    const s = newSession();
    expect(s.start(NORTH, null, null)).toBeNull();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(1);
    expect(dev.gotos[0].pan).toBeCloseTo(0, 1);
  });

  it("stop clears the jog vector and cancels the tick", () => {
    const s = newSession();
    s.start(NORTH, null, null);
    s.stop();
    expect(s.status().state).toBe("stopped");
    expect(dev.cleared).toBeGreaterThan(0);
    expect(sched.cancelled()).toBe(true);
  });
});

describe("TrackingSession safety gates", () => {
  // Put the session in `tracking` with a stationary target due north.
  // Signature is start(target, statedVelocity, label).
  function tracking(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    return s;
  }

  it("commands a jog vector while tracking", () => {
    const s = tracking();
    dev.panSteps = 5 * STEPS_PER_DEG;   // 5 deg of error
    sched.fire();
    expect(dev.jogVec).not.toBeNull();
    expect(dev.jogVec!.x).toBeLessThan(0);   // drive back toward pan 0
  });

  it("stops and waits on stale telemetry", () => {
    const s = tracking();
    dev.lastUpdateMs = clockMs - (cfg.trackStaleTelemetryMs + 1);
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("telemetry_stale");
    expect(dev.jogVec).toBeNull();
  });

  it("stops and waits on a stale target fix", () => {
    const s = tracking();
    clockMs += cfg.trackMaxTargetAgeMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("target_stale");
    expect(dev.jogVec).toBeNull();
  });

  it("yields when a built-in program is engaged", () => {
    const s = tracking();
    dev.programEngaged = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("program_engaged");
    expect(dev.jogVec).toBeNull();
  });

  it("waits when the target is below the tilt limit", () => {
    // A target 10km north but 5km BELOW the rig sits at elevation ~ -26deg,
    // outside a tiltMin of -5.
    const tightCfg = { ...cfg, tiltMin: -5 };
    const s = new TrackingSession(dev as never, tightCfg, store, () => clockMs, sched);
    s.start({ lat: 45 + 10 / 111.32, lon: 10, height: -5000 }, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_tilt_limit");
    expect(dev.jogVec).toBeNull();
  });

  it("the deadman ends the session outright", () => {
    const s = tracking();
    clockMs += cfg.trackDeadmanMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("stopped");
    expect(dev.cleared).toBeGreaterThan(0);
  });

  it("auto-reacquires when a waiting target becomes reachable again", () => {
    const s = tracking();
    dev.programEngaged = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");

    dev.programEngaged = false;
    dev.lastUpdateMs = clockMs;
    s.updateTarget(NORTH, null);   // refresh the fix
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });

  it("drops back to acquiring when the pointing error is large", () => {
    const s = tracking();
    dev.panSteps = 90 * STEPS_PER_DEG;    // 90 deg off target
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
    expect(dev.jogVec).toBeNull();
  });

  it("reports pointing error in status", () => {
    const s = tracking();
    dev.panSteps = 3 * STEPS_PER_DEG;
    sched.fire();
    expect(s.status().pointingErrorDeg).toBeCloseTo(3, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — cannot find module `../src/track/session.js`.

- [ ] **Step 3: Implement**

Create `tb3-mcp/src/track/session.ts`:

```ts
import { Vec3, Mat3, angleBetweenDeg } from "../geo/vec3.js";
import { Geodetic } from "../geo/wgs84.js";
import { Device } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { stepsToDeg, applySign } from "../angles.js";
import { moveToUserAngle } from "../move.js";
import { reachablePanTilt } from "../geo-tools.js";
import { EstimatorState, emptyEstimator, withFix, lastFixMs } from "./estimator.js";
import {
  TargetAim, targetAimAt, controlRate, limitGuard, boresightEnu, rateToDeflection,
} from "./control.js";

export type TrackState = "stopped" | "acquiring" | "tracking" | "waiting";
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "program_engaged" | "not_calibrated";

export interface TrackStatus {
  state: TrackState;
  reason: WaitReason | null;
  label: string | null;
  targetAzimuthDeg: number | null;
  targetElevationDeg: number | null;
  targetRangeM: number | null;
  targetPanDeg: number | null;
  targetTiltDeg: number | null;
  rigPanDeg: number | null;
  rigTiltDeg: number | null;
  pointingErrorDeg: number | null;
  commandedPanDps: number | null;
  commandedTiltDps: number | null;
  targetAgeMs: number | null;
  telemetryAgeMs: number | null;
}

export interface Scheduler {
  every(ms: number, fn: () => void): { cancel(): void };
}

export const realScheduler: Scheduler = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    return { cancel() { clearInterval(t); } };
  },
};

// How far ahead the limit guard predicts: a few ticks of margin, so the rig is
// stopped before it reaches a limit rather than after.
const LIMIT_HORIZON_TICKS = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class TrackingSession {
  private state: TrackState = "stopped";
  private reason: WaitReason | null = null;
  private est: EstimatorState = emptyEstimator();
  private label: string | null = null;
  private timer: { cancel(): void } | null = null;
  private lastActivityMs = 0;
  private acquiring = false;
  private lastStatus: Partial<TrackStatus> = {};

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  isActive(): boolean { return this.state !== "stopped"; }

  start(g: Geodetic, statedVel: Vec3 | null, label: string | null): string | null {
    const rig = this.rigLocation();
    if (!rig) return "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";
    if (!this.store.getOrientation()) return "not calibrated — run solve_calibration first";

    this.stopMotion();
    this.est = withFix(emptyEstimator(), rig, g, this.now(), statedVel);
    this.label = label;
    this.lastActivityMs = this.now();
    this.state = "acquiring";
    this.reason = null;
    this.timer?.cancel();
    this.timer = this.scheduler.every(Math.round(1000 / this.cfg.trackTickHz), () => this.safeTick());
    this.beginAcquire();
    return null;
  }

  updateTarget(g: Geodetic, statedVel: Vec3 | null): string | null {
    if (this.state === "stopped") return "not tracking — call start_tracking first";
    const rig = this.rigLocation();
    if (!rig) return "not calibrated";
    this.est = withFix(this.est, rig, g, this.now(), statedVel);
    this.lastActivityMs = this.now();
    return null;
  }

  stop(): void {
    this.state = "stopped";
    this.reason = null;
    this.timer?.cancel();
    this.timer = null;
    this.stopMotion();
  }

  status(): TrackStatus {
    const dev = this.device.getState();
    const fixMs = lastFixMs(this.est);
    return {
      state: this.state,
      reason: this.reason,
      label: this.label,
      targetAzimuthDeg: this.lastStatus.targetAzimuthDeg ?? null,
      targetElevationDeg: this.lastStatus.targetElevationDeg ?? null,
      targetRangeM: this.lastStatus.targetRangeM ?? null,
      targetPanDeg: this.lastStatus.targetPanDeg ?? null,
      targetTiltDeg: this.lastStatus.targetTiltDeg ?? null,
      rigPanDeg: this.state === "stopped" ? null : this.rigPanTilt().panDeg,
      rigTiltDeg: this.state === "stopped" ? null : this.rigPanTilt().tiltDeg,
      pointingErrorDeg: this.lastStatus.pointingErrorDeg ?? null,
      commandedPanDps: this.lastStatus.commandedPanDps ?? null,
      commandedTiltDps: this.lastStatus.commandedTiltDps ?? null,
      targetAgeMs: fixMs === null ? null : this.now() - fixMs,
      telemetryAgeMs: dev.lastUpdateMs === 0 ? null : this.now() - dev.lastUpdateMs,
    };
  }

  private rigLocation(): Geodetic | null {
    const p = this.store.get();
    return p.rig ? { lat: p.rig.lat, lon: p.rig.lon, height: p.rig.height } : null;
  }

  private rigPanTilt(): { panDeg: number; tiltDeg: number } {
    const d = this.device.getState();
    return {
      panDeg: applySign(stepsToDeg(d.panSteps), this.cfg.panSign),
      tiltDeg: applySign(stepsToDeg(d.tiltSteps), this.cfg.tiltSign),
    };
  }

  private stopMotion(): void {
    this.device.clearJog();
    this.lastStatus = { ...this.lastStatus, commandedPanDps: null, commandedTiltDps: null };
  }

  private wait(reason: WaitReason): void {
    this.state = "waiting";
    this.reason = reason;
    this.stopMotion();
  }

  // Any throw inside a tick must not leave a rate running. The Device TTL is
  // the real backstop (it survives an event-loop stall, which this cannot).
  private safeTick(): void {
    try { this.tick(); }
    catch { this.stopMotion(); }
  }

  private tick(): void {
    if (this.state === "stopped") return;
    const t = this.now();

    if (t - this.lastActivityMs > this.cfg.trackDeadmanMs) { this.stop(); return; }

    const dev = this.device.getState();
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    if (dev.programEngaged) { this.wait("program_engaged"); return; }
    if (dev.lastUpdateMs === 0 || t - dev.lastUpdateMs > this.cfg.trackStaleTelemetryMs) {
      this.wait("telemetry_stale"); return;
    }
    const fixMs = lastFixMs(this.est);
    if (fixMs === null || t - fixMs > this.cfg.trackMaxTargetAgeMs) { this.wait("target_stale"); return; }

    const aim = targetAimAt(this.est, R, t + this.cfg.trackLeadMs);
    if (!aim) { this.wait("target_stale"); return; }

    const reach = reachablePanTilt(
      aim.panDeg, aim.tiltDeg,
      this.cfg.panMin, this.cfg.panMax, this.cfg.tiltMin, this.cfg.tiltMax,
    );
    if ("error" in reach) {
      this.recordAim(aim, R);
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }

    const rig = this.rigPanTilt();
    const errDeg = angleBetweenDeg(boresightEnu(R, rig.panDeg, rig.tiltDeg), aim.enuUnit);
    this.recordAim(aim, R, errDeg);

    if (this.state === "acquiring") return;   // a goto is in flight; let it finish

    if (this.state === "waiting" || errDeg > this.cfg.trackReacquireDeg) {
      this.state = "acquiring";
      this.reason = null;
      this.stopMotion();
      this.beginAcquire();
      return;
    }

    // state === tracking
    const raw = controlRate(
      { ...aim, panDeg: reach.pan }, rig.panDeg, rig.tiltDeg,
      this.cfg.trackKp, this.cfg.maxJogDps,
    );
    const horizonMs = (1000 / this.cfg.trackTickHz) * LIMIT_HORIZON_TICKS;
    const guarded = limitGuard(raw, rig.panDeg, rig.tiltDeg, {
      panMin: this.cfg.panMin, panMax: this.cfg.panMax,
      tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax,
    }, horizonMs);

    // NOT the linear mapping layer 1's jog tool uses -- the firmware curve is
    // cubic (measured on hardware). See rateToDeflection.
    const x = rateToDeflection(guarded.out.panDps * this.cfg.panSign, this.cfg.maxJogDps);
    const y = rateToDeflection(guarded.out.tiltDps * this.cfg.tiltSign, this.cfg.maxJogDps);
    this.device.setJogVector(x, y, 0, this.cfg.jogVectorTtlMs);
    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: guarded.out.panDps,
      commandedTiltDps: guarded.out.tiltDps,
    };
  }

  private recordAim(aim: TargetAim, R: Mat3, errDeg?: number): void {
    let azimuth = (Math.atan2(aim.enuUnit[0], aim.enuUnit[1]) * 180) / Math.PI;
    if (azimuth < 0) azimuth += 360;
    if (azimuth >= 360 - 1e-6) azimuth = 0;
    this.lastStatus = {
      ...this.lastStatus,
      targetAzimuthDeg: azimuth,
      targetElevationDeg: (Math.asin(Math.max(-1, Math.min(1, aim.enuUnit[2]))) * 180) / Math.PI,
      targetRangeM: aim.rangeM,
      targetPanDeg: aim.panDeg,
      targetTiltDeg: aim.tiltDeg,
      pointingErrorDeg: errDeg ?? this.lastStatus.pointingErrorDeg ?? null,
    };
  }

  private beginAcquire(): void {
    if (this.acquiring) return;
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    const aim = targetAimAt(this.est, R, this.now() + this.cfg.trackLeadMs);
    if (!aim) { this.wait("target_stale"); return; }
    const reach = reachablePanTilt(
      aim.panDeg, aim.tiltDeg,
      this.cfg.panMin, this.cfg.panMax, this.cfg.tiltMin, this.cfg.tiltMax,
    );
    if ("error" in reach) {
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }
    this.acquiring = true;
    void moveToUserAngle(this.device, this.cfg, reach.pan, reach.tilt)
      .then(() => { if (this.state === "acquiring") this.state = "tracking"; })
      .catch(() => { if (this.state === "acquiring") this.wait("telemetry_stale"); })
      .finally(() => { this.acquiring = false; });
  }

  /** Test seam: force a state without waiting for a real goto to complete. */
  forceStateForTest(s: TrackState): void { this.state = s; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add src/track/session.ts test/session.test.ts
git commit -m "feat(track): tracking session state machine with full safety gate set"
```

---

### Task 7: Tracking MCP tools, arbitration, and server wiring

**Files:**
- Create: `tb3-mcp/src/track-tools.ts`
- Modify: `tb3-mcp/src/geo-tools.ts` (export `heightSchema`)
- Modify: `tb3-mcp/src/tools.ts` (arbitration)
- Modify: `tb3-mcp/src/server.ts` (construct session once, wire tools)
- Modify: `tb3-mcp/test/server.test.ts` (tool count 15 → 19)
- Test: `tb3-mcp/test/track-tools.test.ts`

**Interfaces:**
- Consumes: `TrackingSession` from `./track/session.js`; `velocityFromSpeedHeading` from `./track/estimator.js`; `heightSchema` from `./geo-tools.js`.
- Produces: `registerTrackTools(server: McpServer, session: TrackingSession): void`. `registerTools` gains a 4th parameter `session: TrackingSession`. `buildApp(device, cfg, store, session)` gains a 4th parameter.

**Critical:** `buildApp` creates a NEW `McpServer` per MCP connection. The `TrackingSession` must be created ONCE (in `main()` and in tests) and passed in — one rig, one session. Do not construct it inside the per-connection factory.

- [ ] **Step 1: Write the failing test**

Create `tb3-mcp/test/track-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { registerTrackTools } from "../src/track-tools.js";

// Ports 8791-8798 are already taken by other test files (mock-tb3, device,
// tools, server, geo-tools, server-error, device-jog). Do not reuse them.
const PORT = 8799;
const RIG = { lat: 45, lon: 10, height: 0 };
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;

let mock: MockTb3; let device: Device; let client: Client; let store: CalibrationStore;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any) => r.content.map((c: any) => c.text).join("");

async function harness(calibrated = true) {
  mock = new MockTb3();
  await mock.start(PORT);
  const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
  device = new Device(cfg);
  device.start();
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-tt-")), "cal.json"));
  store.load();
  if (calibrated) {
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I as never, new Date(0).toISOString());
  }
  const session = new TrackingSession(device, cfg, store);
  const server = new McpServer({ name: "t", version: "0" });
  registerTrackTools(server, session);
  client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  await sleep(150);
  return session;
}

afterEach(async () => { device?.close(); await mock?.stop(); });

describe("track tools", () => {
  it("registers exactly the four tracking tools", async () => {
    await harness();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_tracking_status", "start_tracking", "stop_tracking", "update_target"]);
  });

  it("start_tracking refuses without a calibration", async () => {
    await harness(false);
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/calibrat/i);
  });

  it("start_tracking begins a session and reports state", async () => {
    const session = await harness();
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0, speed_mps: 100, heading_deg: 90, label: "test" },
    });
    expect(r.isError ?? false).toBe(false);
    expect(session.isActive()).toBe(true);
    session.stop();
  });

  it("start_tracking returns immediately (it does not block to arrival)", async () => {
    const session = await harness();
    const t0 = Date.now();
    await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(Date.now() - t0).toBeLessThan(500);
    session.stop();
  });

  it("update_target before start_tracking is refused", async () => {
    await harness();
    const r: any = await client.callTool({
      name: "update_target",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not tracking/i);
  });

  it("get_tracking_status reports pointing error and state", async () => {
    const session = await harness();
    await client.callTool({ name: "start_tracking", arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 } });
    await sleep(300);
    const r: any = await client.callTool({ name: "get_tracking_status", arguments: {} });
    const body = JSON.parse(textOf(r));
    expect(["acquiring", "tracking", "waiting"]).toContain(body.state);
    expect(body).toHaveProperty("pointing_error_deg");
    expect(body).toHaveProperty("target_range_m");
    session.stop();
  });

  it("stop_tracking ends the session", async () => {
    const session = await harness();
    await client.callTool({ name: "start_tracking", arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 0 } });
    await client.callTool({ name: "stop_tracking", arguments: {} });
    expect(session.isActive()).toBe(false);
  });

  it("rejects an out-of-band height", async () => {
    await harness();
    const r: any = await client.callTool({
      name: "start_tracking",
      arguments: { lat: NORTH.lat, lon: NORTH.lon, height_m: 500000 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/height_m/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/track-tools.test.ts`
Expected: FAIL — cannot find module `../src/track-tools.js`.

- [ ] **Step 3: Implement**

First, in `tb3-mcp/src/geo-tools.ts`, export the shared height validator (change `function heightSchema` to `export function heightSchema`) so the tracking tools reuse the same contract rather than duplicating the band.

Create `tb3-mcp/src/track-tools.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vec3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { velocityFromSpeedHeading } from "./track/estimator.js";
import { heightSchema } from "./geo-tools.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

const latSchema = z.number().finite().min(-90).max(90).describe("target latitude, degrees");
const lonSchema = z.number().finite().min(-180).max(180).describe("target longitude, degrees");
const speedSchema = z.number().finite().nonnegative().optional()
  .describe("ground speed in meters/second (optional; derived from successive fixes if omitted)");
const headingSchema = z.number().finite().optional()
  .describe("heading in degrees, 0=North 90=East (optional; required for speed to be usable)");
const climbSchema = z.number().finite().optional()
  .describe("climb rate in meters/second, positive up (optional, default 0)");

// Null means "no velocity stated" — the estimator then derives one from
// successive fixes. A speed without a heading is not usable, so it is ignored.
function velocityFromArgs(
  speed_mps?: number, heading_deg?: number, climb_mps?: number,
): Vec3 | null {
  if (speed_mps === undefined && climb_mps === undefined) return null;
  if (speed_mps !== undefined && heading_deg === undefined) return null;
  return velocityFromSpeedHeading(speed_mps ?? 0, heading_deg ?? 0, climb_mps ?? 0);
}

export function registerTrackTools(server: McpServer, session: TrackingSession): void {
  server.registerTool(
    "start_tracking",
    {
      description:
        "Begin continuously following a moving geographic target. Requires a solved calibration. " +
        "Returns immediately — tracking runs in the background; poll get_tracking_status.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        height_m: heightSchema("target height in meters (same datum as the rig)"),
        speed_mps: speedSchema,
        heading_deg: headingSchema,
        climb_mps: climbSchema,
        label: z.string().optional().describe("optional name for this target"),
      },
    },
    async ({ lat, lon, height_m, speed_mps, heading_deg, climb_mps, label }) => {
      const err = session.start(
        { lat, lon, height: height_m },
        velocityFromArgs(speed_mps, heading_deg, climb_mps),
        label ?? null,
      );
      if (err) return errText(err);
      return text(JSON.stringify(statusBody(session), null, 2));
    },
  );

  server.registerTool(
    "update_target",
    {
      description: "Feed a new position fix for the target being tracked. Refreshes the tracking deadman.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        height_m: heightSchema("target height in meters (same datum as the rig)"),
        speed_mps: speedSchema,
        heading_deg: headingSchema,
        climb_mps: climbSchema,
      },
    },
    async ({ lat, lon, height_m, speed_mps, heading_deg, climb_mps }) => {
      const err = session.updateTarget(
        { lat, lon, height: height_m },
        velocityFromArgs(speed_mps, heading_deg, climb_mps),
      );
      if (err) return errText(err);
      return text(JSON.stringify(statusBody(session), null, 2));
    },
  );

  server.registerTool(
    "stop_tracking",
    { description: "Stop following the target and halt all tracking motion.", inputSchema: {} },
    async () => { session.stop(); return text("tracking stopped"); },
  );

  server.registerTool(
    "get_tracking_status",
    {
      description:
        "Report the tracking session: state, target az/el/range, rig pan/tilt, measured pointing error, and data staleness.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(statusBody(session), null, 2)),
  );
}

function round(v: number | null, dp: number): number | null {
  return v === null ? null : Number(v.toFixed(dp));
}

function statusBody(session: TrackingSession) {
  const s = session.status();
  return {
    state: s.state,
    reason: s.reason,
    label: s.label,
    target_azimuth_deg: round(s.targetAzimuthDeg, 2),
    target_elevation_deg: round(s.targetElevationDeg, 2),
    target_range_m: round(s.targetRangeM, 1),
    target_pan_deg: round(s.targetPanDeg, 2),
    target_tilt_deg: round(s.targetTiltDeg, 2),
    rig_pan_deg: round(s.rigPanDeg, 2),
    rig_tilt_deg: round(s.rigTiltDeg, 2),
    pointing_error_deg: round(s.pointingErrorDeg, 2),
    commanded_pan_dps: round(s.commandedPanDps, 2),
    commanded_tilt_dps: round(s.commandedTiltDps, 2),
    target_age_ms: s.targetAgeMs,
    telemetry_age_ms: s.telemetryAgeMs,
  };
}
```

Now the arbitration in `tb3-mcp/src/tools.ts`. Change the signature:

```ts
export function registerTools(
  server: McpServer, device: Device, cfg: Config, session: TrackingSession,
): void {
```

and add the import `import { TrackingSession } from "./track/session.js";`.

In the `goto_angle` handler, before calling `moveToUserAngle`, add:

```ts
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
```

In the `jog` handler, before computing the joystick vector, add the same guard:

```ts
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
```

In the `stop` handler, kill the session first — stop always wins:

```ts
    async () => { session.stop(); await device.stop(); return text("stopped"); },
```

Now `tb3-mcp/src/server.ts`. Change `buildApp` to take the session and pass it through:

```ts
export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
): Express {
```

Add the imports:

```ts
import { TrackingSession } from "./track/session.js";
import { registerTrackTools } from "./track-tools.js";
```

Inside the per-connection factory, alongside the existing registrations:

```ts
        registerTools(server, device, cfg, session);
        registerGeoTools(server, device, cfg, store);
        registerTrackTools(server, session);
```

In `main()` (where the store is built), construct the session ONCE and pass it to `buildApp`:

```ts
  const session = new TrackingSession(device, cfg, store);
  const app = buildApp(device, cfg, store, session);
```

Finally, in `tb3-mcp/test/server.test.ts`, update the tool-count assertion and its comment:

```ts
    expect(tools.length).toBe(19); // 8 base + 7 geo + 4 tracking
```

and update that file's `buildApp(...)` call site(s) to construct and pass a `TrackingSession` (import it and `new TrackingSession(device, cfg, store)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/track-tools.test.ts test/server.test.ts test/tools.test.ts`
Expected: PASS.
Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/track-tools.ts src/tools.ts src/server.ts src/geo-tools.ts test/track-tools.test.ts test/server.test.ts
git commit -m "feat(track): tracking MCP tools, motion arbitration, and daemon-wide session wiring"
```

---

### Task 8: Mock jog integration and the closed-loop simulation

**Files:**
- Modify: `tb3-mcp/test/mock-tb3.ts`
- Test: `tb3-mcp/test/tracking-sim.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `MockTb3` now integrates its jog vector into simulated position, so a commanded rate actually moves the mock. No new exports.

**Why this task exists:** every other test checks a piece. This one proves the whole controller closes the loop — a synthetic target is flown along a known track, the real session and real control law chase it, and the **measured pointing error must stay bounded**. It exercises the exact number `get_tracking_status` reports, with no hardware.

- [ ] **Step 1: Write the failing test**

First extend the mock. In `tb3-mcp/test/mock-tb3.ts`, add these near `SIM_DPS`:

```ts
// The rig's measured full-deflection jog rate. Must match Config.maxJogDps.
const MOCK_JOG_MAX_DPS = 22.5;
// The firmware's real deflection->rate curve, measured on hardware:
// axis_button_deadzone() zeroes |x|<6 and subtracts 5, then
// updateMotorVelocities2() applies a CUBIC ("exponential curve").
// Modelling this LINEARLY would make the sim validate a fiction -- a linear
// control mapping would look perfect here and be ~9x wrong on the rig.
const MOCK_JOY_DEADBAND = 5;
const MOCK_JOY_SPAN = 95;
```

Add a jog integration step. In `start()`, change the tick timer to also integrate the jog:

```ts
    this.tickTimer = setInterval(() => { this.applyJog(); this.pushTick(); }, 50);
```

And add both methods next to `startMove`:

```ts
  // The firmware's cubic jog curve. See the constants above.
  private jogDps(x: number): number {
    if (Math.abs(x) < 6) return 0;
    const db = Math.abs(x) - MOCK_JOY_DEADBAND;
    return Math.sign(x) * MOCK_JOG_MAX_DPS * Math.pow(db / MOCK_JOY_SPAN, 3);
  }

  // Integrate the standing jog vector into position, so a commanded rate
  // actually moves the mock. A goto move takes precedence over jog.
  //
  // NOTE: this deliberately does NOT model the firmware's acceleration ramp
  // (updateMotorVelocities2 ramps the accumulator at (65535/20)/1.0 per 20Hz
  // cycle). Out of scope for v1: it bounds how fast the servo can correct but
  // does not bias steady-state rate. The sim's error tolerance absorbs it.
  private applyJog(): void {
    const j = this.lastJog;
    if (!j || this.moving) return;
    this.pan += this.jogDps(j.x) * STEPS_PER_DEG * 0.05;
    this.tilt += this.jogDps(j.y) * STEPS_PER_DEG * 0.05;
  }
```

Now create `tb3-mcp/test/tracking-sim.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockTb3 } from "./mock-tb3.js";
import { Device } from "../src/device.js";
import { loadConfig } from "../src/config.js";
import { CalibrationStore } from "../src/calibration.js";
import { TrackingSession } from "../src/track/session.js";
import { Mat3 } from "../src/geo/vec3.js";

// Ports 8791-8799 are already taken by other test files. Do not reuse them.
const PORT = 8800;
// Identity R: the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. Keeps the expectations hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);

let mock: MockTb3; let device: Device; let session: TrackingSession;

afterEach(async () => {
  session?.stop();
  device?.close();
  await mock?.stop();
});

describe("closed-loop tracking simulation", () => {
  it("holds pointing error bounded while chasing a crossing target", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    const cfg = loadConfig(undefined, { TB3_DEVICE_HOST: `127.0.0.1:${PORT}` });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    // An aircraft 8km north at 2km altitude, flying East at 120 m/s.
    // Over 4s it moves ~480m — a slow azimuth sweep the rig can hold.
    const northM = 8000, upM = 2000, speed = 120;
    const t0 = Date.now();
    const posAt = (tSec: number) => ({
      lat: RIG.lat + northM / M_PER_DEG_LAT,
      lon: RIG.lon + (speed * tSec) / M_PER_DEG_LON,
      height: upM,
    });

    session = new TrackingSession(device, cfg, store);
    expect(session.start(posAt(0), null, "sim")).toBeNull();

    // Feed fixes at 2Hz with a stated velocity (due East).
    const feeder = setInterval(() => {
      const tSec = (Date.now() - t0) / 1000;
      session.updateTarget(posAt(tSec), [speed, 0, 0]);
    }, 500);

    // Let it acquire, then sample the error while tracking.
    await sleep(2500);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const st = session.status();
      if (st.state === "tracking" && st.pointingErrorDeg !== null) samples.push(st.pointingErrorDeg);
    }
    clearInterval(feeder);

    expect(session.status().state).toBe("tracking");
    expect(samples.length).toBeGreaterThan(4);
    const worst = Math.max(...samples);
    // The controller must actually converge — not merely avoid diverging.
    expect(worst).toBeLessThan(3);
  }, 15000);

  it("stops commanding motion when target updates dry up", async () => {
    mock = new MockTb3();
    await mock.start(PORT);
    const cfg = loadConfig(undefined, {
      TB3_DEVICE_HOST: `127.0.0.1:${PORT}`,
      TB3_TRACK_MAX_TARGET_AGE_MS: "400",
    });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim2-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    session = new TrackingSession(device, cfg, store);
    session.start({ lat: RIG.lat + 8000 / M_PER_DEG_LAT, lon: RIG.lon, height: 2000 }, [0, 0, 0], "stale");

    // Never call updateTarget again: the fix goes stale and motion must cease.
    await sleep(1500);
    expect(session.status().state).toBe("waiting");
    expect(session.status().reason).toBe("target_stale");
    expect(mock.lastJog).toEqual({ x: 0, y: 0, aux: 0 });
  }, 15000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tracking-sim.test.ts`
Expected: FAIL — the mock does not integrate jog, so the rig never converges and `worst` exceeds 3° (or the state never reaches `tracking`).

- [ ] **Step 3: Implement**

The mock changes are in Step 1 above. If the closed-loop test fails on convergence, the likely causes, in order:
1. `MOCK_JOG_MAX_DPS` does not match `cfg.maxJogDps` — the feedforward is then systematically scaled wrong.
2. The mock's cubic and `rateToDeflection`'s inverse disagree (deadband or span mismatch) — they must be exact inverses, so a rate in should come back out.
3. A sign error in the joystick mapping — the rig would run *away* from the target and the error would grow monotonically.
4. `trackKp` too low to close the residual within the settling window.

Diagnose by logging `session.status()` each sample (state, `pointingErrorDeg`, `commandedPanDps`) rather than by adjusting the tolerance.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tracking-sim.test.ts`
Expected: PASS (2 tests).
Run: `npx vitest run && npx tsc --noEmit`
Expected: full suite passes, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add test/mock-tb3.ts test/tracking-sim.test.ts
git commit -m "test(track): mock jog integration + closed-loop tracking simulation"
```

---

### Task 9: Document layer 3

**Files:**
- Modify: `tb3-mcp/README.md`

- [ ] **Step 1: Add the tracking section**

In `tb3-mcp/README.md`, add the 8 new config keys to the config table:

```markdown
| trackTickHz | `10` | control loop rate for target tracking |
| trackKp | `1.0` | tracking proportional gain (°/s of rate per ° of error) |
| trackLeadMs | `150` | how far ahead the tracker aims, to cover command + rig latency |
| trackMaxTargetAgeMs | `5000` | target fix older than this → stop and wait |
| trackStaleTelemetryMs | `1000` | telemetry older than this → stop and wait |
| trackDeadmanMs | `120000` | total silence before a tracking session ends outright |
| trackReacquireDeg | `10` | pointing error above which tracking re-acquires with a goto |
| jogVectorTtlMs | `500` | jog keep-alive refuses to re-send a vector older than this |
```

Then add this section after the geo-pointing section:

```markdown
## Target tracking (layer 3)

Continuously follow a **moving** geographic target. Requires a solved layer-2 calibration.

Unlike every other tool here, the tracking tools **return immediately** — tracking runs in the
background and outlives the call. Poll `get_tracking_status` to see how it is doing.

### Workflow

1. **Calibrate** (layer 2) — `set_rig_location`, two `sight_landmark`s, `solve_calibration`.
2. **`start_tracking`** with the target's lat/lon/height, ideally plus `speed_mps` + `heading_deg`
   (+ `climb_mps`). The rig slews to acquire, then rate-tracks.
3. **`update_target`** with each new fix. Between fixes the daemon extrapolates using the
   velocity; with no stated velocity it derives one from successive fixes.
4. **`get_tracking_status`** to read state, target az/el/range, and the measured pointing error.
5. **`stop_tracking`** when done. The layer-1 `stop` tool also ends tracking — stop always wins.

### Tools

| Tool | Purpose |
|---|---|
| `start_tracking` | Begin following a target (lat, lon, height_m, optional speed_mps/heading_deg/climb_mps, label). Returns immediately. |
| `update_target` | Feed a new fix for the tracked target; refreshes the deadman. |
| `get_tracking_status` | State, target az/el/range, rig pan/tilt, **measured pointing error**, commanded rates, data staleness. |
| `stop_tracking` | End the session and halt tracking motion. |

### States

`acquiring` (slewing onto the target) → `tracking` (rate servo) ⇄ `waiting` (motion stopped, still
estimating) → `stopped`. A `waiting` status carries a reason: `below_tilt_limit`, `pan_limit`,
`target_stale`, `telemetry_stale`, `program_engaged`, or `not_calibrated`. It auto-reacquires once
the target is reachable and fresh again.

While tracking is active, `goto_angle` and `jog` are refused — stop tracking first.

### Safety

Tracking is the only thing here that commands sustained motion with **no human in the loop**, and
the rig has **no endstops**, so:

- The session enforces the pan/tilt soft limits itself (the jog path does not), checking the
  *predicted* position each tick and zeroing that axis before it reaches a limit.
- Stale telemetry, a stale target fix, or an engaged program all stop motion.
- A **deadman** ends the session after `trackDeadmanMs` of silence.
- The jog vector carries a TTL: if the control loop stalls or dies without refreshing it, the
  keep-alive zeroes the rig rather than letting it slew on. The watchdog lives in the device
  client, so it survives a crashed or stalled control loop.

### Accuracy

v1 does not promise a pointing accuracy. The tracker **measures and reports** its own error via
`get_tracking_status`; the achievable figure depends on the layer-2 calibration quality and on how
closely `maxJogDps` matches the rig's true jog rate. Tune `maxJogDps` and `trackKp` against the
reported error.
```

- [ ] **Step 2: Verify the docs against the code**

Re-read `src/config.ts` and `src/track-tools.ts` and confirm every documented key, default, tool name, argument name, and state string matches the implementation exactly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(track): document target tracking tools, states, and safety model"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Architecture / new modules | 3, 4, 6, 7 |
| Layer-1 refactor: sticky jog vector | 5 |
| Arbitration | 7 |
| Target estimator (ENU constant-velocity, velocity precedence) | 3 |
| Control law (feedforward, P-only, lead, clamp) | 4 |
| Measured pointing error | 4 (computation), 6 (reporting), 7 (surfacing), 8 (proving) |
| Safety envelope (all gates) | 4 (limit guard), 6 (gates) |
| Sticky-rate failure / TTL watchdog | 5 |
| Tool surface + state machine | 6, 7 |
| Configuration | 2 |
| Testing: pure units, TTL, closed-loop sim | 3, 4, 5, 6, 8 |
| Risk 1: jog path hardware check | 0 |
| Risk 2: L2 calibration ordering | 0 (noted), hardware validation after PR #3 lands |
| Risk 3: open-loop rate accuracy | 0 Step 5 (measure °/s), 9 (documented) |

`enuPosition` / `vec3.add` are not named in the spec but are prerequisites — Task 1.

**Placeholder scan:** none. Every code step carries complete code; every command has an expected result.

**Type consistency:**
- `reachablePanTilt` returns `{pan,tilt} | {error:string}` — narrowed with `"error" in reach` in Task 6, matching the real signature.
- `enuToPanTilt(R, u)` returns user-frame pan/tilt; the rig's user-frame comes from `applySign(stepsToDeg(...))`. Consistent in Tasks 4 and 6.
- `EstimatorState`/`TargetAim`/`ControlOutput`/`TrackStatus`/`Scheduler` names are identical across Tasks 3, 4, 6, 7.
- `Device.setJogVector(x, y, aux, ttlMs)` — same arity in Tasks 5, 6, and the `FakeDevice` in Task 6.
- `registerTools` gains `session` (Task 7); every call site (`server.ts`, `server.test.ts`) is updated in that task.
- `heightSchema` is exported in Task 7 before `track-tools.ts` imports it.

---

### Task 10: Firmware — a dedicated web track mode

**Files:**
- Modify: `src/_TB3_LCD_Buttons.ino` (menu entry + mode dispatch)
- Modify: `src/TB3_Black_109_Release1.ino` (progtype enum + menu strings, if that is where they live)
- Verify on hardware (OTA deploy), no host test framework exists for firmware

**Why (from the spec's "Hardware reality" §1, measured on the rig):** web jog only moves the motors where three things coincide — `DFSetup()` (motion params), `NunChuckQuerywithEC()` (which pumps `tb3_web_poll()`, landing the web joystick on the virtual gamepad AND draining goto/stop), and `updateMotorVelocities2()` (gamepad → motor velocity). Today they coincide **only** on a program's point-setting screen. `DFloop()` (Dragonframe) pumps no web path at all — jog, goto and stop are all dead there. Layer 3's servo therefore has nowhere safe to live. This task gives it one.

**The shape** — deliberately the same loop `_TB3_LCD_Buttons.ino:253-260` already runs for "Move to Start Pt.", minus the program state:

```cpp
// Web track mode: the one screen where the layer-3 servo can drive the rig.
// Same input+velocity loop the point-setting screens use, with no program
// state, so a stray C press cannot advance anything out from under tracking.
lcd.empty();
lcd.at(1,1,"Track (Web)");
// second line: show the STA IP so the operator can see where to point the daemon
DFSetup();                        // motion params + ISR setup
while (/* not exited */) {
    if (!nextMoveLoaded) {
        NunChuckQuerywithEC();    // pumps tb3_web_poll(): web joystick + goto/stop drain
        axis_button_deadzone();   // gamepad -> joy_x_axis (deadband)
        updateMotorVelocities2(); // joy_x_axis -> motor velocity (the cubic)
    }
    // exit on a held button; see below
}
```

- [ ] **Step 1: Find how modes are registered.** Read `_TB3_LCD_Buttons.ino` around line 128-165 (the `progtype` dispatch: `REG3POINTMOVE`, `DFSLAVE`, `SETUPMENU`, `REV2POINTMOVE`, ...) and locate the `progtype` enum and the menu string table. Add a new `WEBTRACK` progtype and a menu entry beside "Dragonframe", following the existing pattern exactly.

- [ ] **Step 2: RESOLVE ISR OWNERSHIP FIRST — this is the task's main risk.**

`tb3_goto_execute()` (which `point_at` uses to acquire, and which the servo relies on) runs its own blocking move loop and calls `startISR1()` / `stopISR1()` itself. The track mode also owns ISR state via `DFSetup()`. A goto dispatched *from inside* the track loop (via `tb3_web_poll()`) will therefore call `stopISR1()` on its way out — potentially leaving the track loop's velocity engine dead while the loop keeps running, so jog silently stops working after the first `point_at`.

Read `startISR1`/`stopISR1` and `DFSetup()` in `src/TB_DF.ino`, and `tb3_goto_execute()` in `src/TB3_WebGlue.ino`. Determine whether the ISR must be restarted after a goto returns, and make the track loop re-assert whatever it needs. **Verify on hardware:** `point_at` (a goto) followed by sustained jog in the same session — jog must still move the rig after the goto completes. If it does not, that is this task's real deliverable.

- [ ] **Step 3: Exit path.** The operator must be able to leave. Follow the existing convention for exiting a mode (see how `DFSLAVE`/`DFloop` or the setup screens return to the menu). On exit, ensure motion is stopped and the ISR left in the state the menu expects. Do NOT use a bare `C` tap if that risks a mis-press killing a live track — prefer a held button or `C+Z`, matching whatever the codebase already does for deliberate exits.

- [ ] **Step 4: Build**

```bash
pio run -e esp32-s3-devkitc-1
```
Expected: SUCCESS.

- [ ] **Step 5: Deploy over OTA and verify on hardware** (camera removed):
  1. Enter Track (Web) from the menu; confirm the LCD shows it and the STA IP.
  2. `node scripts/jog-probe.mjs <IP> 100 6` → jog moves the rig; note the plateau °/s.
  3. Issue a `point_at`/goto, wait for arrival, then re-run the jog probe → **jog must still work** (this is the ISR-ownership check from Step 2).
  4. `POST /api/stop` mid-jog → motion stops.
  5. Exit the mode → rig returns to the menu, motors stopped.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "feat(track): dedicated web track mode for layer-3 rate control"
```

**Note:** this task cannot be done by a subagent without hardware. The controller runs it with the human operator.
