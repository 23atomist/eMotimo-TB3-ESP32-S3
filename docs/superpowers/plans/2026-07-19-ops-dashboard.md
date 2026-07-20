# TB3 Operations Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate `tb3-dashboard` web service on the host that aggregates the whole TB3 system's state into one live page and drives operations — calibration, manual/autonomous tracking, camera view, and a direct-to-firmware emergency stop.

**Architecture:** A new Node/Express service in the `tb3-mcp` monorepo, isolated from the rig-control daemon. It holds no rig state: it aggregates from the daemon (over MCP), the ESP32 (`/api/status` direct), `systemctl`, and `readsb`, streams the D5000 camera as MJPEG (gphoto2→ffmpeg with a still-fallback), pushes one `DashboardState` snapshot per second over SSE, and issues controls (through the daemon's MCP tools, plus a direct-to-firmware E-STOP). A dependency-free vanilla SPA renders it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥18 (global `fetch`, `AbortSignal.timeout`, `child_process`), Express, `@modelcontextprotocol/sdk` client, Zod, vitest. Frontend: plain HTML/CSS/JS (no build step).

## Global Constraints

- **No `any`.** Untrusted inputs (ESP32 JSON, `systemctl` text, readsb JSON, MCP tool text) parsed with `unknown` + narrowing / Zod. ESM `.js` import specifiers on every relative import.
- **The dashboard never bypasses the daemon's safety.** All rig *motion* controls (track, jog, calibration-aim, goto) go through the daemon's MCP tools, so sun-guard / pan-tilt limits / deadman still apply. The one exception is a *stop*: the **E-STOP posts directly to the ESP32 `/api/stop`** (a stop is always safe and must work even if the daemon is down).
- **Graceful degradation is mandatory.** Every source is fetched in its own try/catch; a failed source marks its field unavailable and the aggregator NEVER throws. One dead service must not blank the whole page.
- **No firmware or L1–L4 daemon control-path changes.** The dashboard only *consumes* MCP tools + ESP32 `/api/*` that already exist. The only shared-file edit is adding config fields to `tb3-mcp/src/config.ts`.
- **Existing 274 daemon tests stay green.** Match daemon conventions (vitest `fileParallelism:false`).
- **On-host, not unit-tested (by design):** the camera MJPEG stream, the live SSE, and the browser SPA are verified by on-host manual testing. The D5000 liveview fps and the liveview-vs-fallback decision are settled during the on-host build. Releasing the `gvfs-gphoto2-volume-monitor` claim is a documented HOST SETUP prerequisite, not a code task.

## Interfaces this dashboard consumes (verified against the codebase)

- **MCP tools** (daemon `:8770/mcp`): `get_status` → `{connected, pan_deg, tilt_deg, aux_steps, moving, program_engaged, battery_v, sta_ip, last_update_age_ms, stale}`; `get_tracking_status` → `{state, reason, label, target_azimuth_deg, target_elevation_deg, target_range_m, target_pan_deg, target_tilt_deg, rig_pan_deg, rig_tilt_deg, pointing_error_deg, commanded_pan_dps, commanded_tilt_dps, pan_limited, tilt_limited, target_age_ms, telemetry_age_ms}`; `get_tracked_aircraft` → `{hex, lost_ms, session_active, last_error}`; `scan_aircraft` → `{ok, count, aircraft:[{hex,callsign,category,squawk,altitude_m,ground_speed_kt,azimuth_deg,elevation_deg,range_km,required_slew_dps,est_track_sec,reachable,sun_safe,slew_ok}]}`; `get_calibration` → `{calibrated, rig, sightings, solved_at}`; `get_sun` → sun-guard status; `set_rig_location`/`sight_landmark`/`solve_calibration`/`clear_calibration`; `jog` → `{pan_dps, tilt_dps, aux?, duration_ms}`; `track_aircraft`/`stop_tracking`. All return `{content:[{type:"text",text}], isError?}`.
- **ESP32 `GET /api/status`** (direct): `{pos:{pan,tilt,aux (STEPS)}, moving, joy_latched, program_engaged, battery_v, uptime_ms, heap, wifi:{ap_ip,sta_ip,clients}, imu:{ok, pitch, roll, tempC, pressHpa}}`. **ESP32 `POST /api/stop`** (direct, e-stop).
- Rig host = `cfg.deviceHost` (+ `cfg.deviceIpFallback`). `STEPS_PER_DEG` = `444.444` (from `src/angles.ts`, exported `stepsToDeg`).

---

## File Structure

- `tb3-mcp/src/dashboard/state.ts` — `DashboardState` + source types + the pure `mergeState()` (aggregation core).
- `tb3-mcp/src/dashboard/parse.ts` — pure parsers: `parseRigStatus()` (ESP32 JSON), `parseServiceState()` (`systemctl` text).
- `tb3-mcp/src/dashboard/client.ts` — `DashboardClient` interface + `McpDashboardClient` (extends the MCP call pattern with the extra tools).
- `tb3-mcp/src/dashboard/rig.ts` — direct ESP32 `/api/status` fetch + `/api/stop`.
- `tb3-mcp/src/dashboard/services.ts` — `systemctl` exec + agent start/stop.
- `tb3-mcp/src/dashboard/controls.ts` — action→tool mapping + the E-STOP fan-out.
- `tb3-mcp/src/dashboard/camera.ts` — supervised gphoto2→ffmpeg MJPEG streamer.
- `tb3-mcp/src/dashboard/server.ts` — Express `main()`: static SPA, `/api/state`, SSE `/api/stream`, `/api/control/*`, `/camera/stream`; the ~1 s poller.
- `tb3-mcp/dashboard/public/{index.html,app.js,style.css}` — the vanilla SPA (Layout A).
- **Modify:** `tb3-mcp/src/config.ts`, `tb3-mcp/config.example.json`, `tb3-mcp/package.json` (scripts), `tb3-mcp/README.md`; **Add:** `tb3-mcp/deploy/tb3-dashboard.service`, `tb3-mcp/deploy/HOST-SETUP.md`.
- **Tests:** `test/dashboard-parse.test.ts`, `test/dashboard-state.test.ts`, `test/dashboard-controls.test.ts`, `test/dashboard-rig.test.ts`, `test/dashboard-services.test.ts`, `test/dashboard-camera.test.ts`. **Modify:** `test/config.test.ts`.

Run tests from `tb3-mcp/`: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"; npx vitest run test/<file>.ts` (single) / `npm test` (full) / `npm run build` (tsc).

---

### Task 1: Config fields

**Files:** Modify `tb3-mcp/src/config.ts`; Test `tb3-mcp/test/config.test.ts`.

**Interfaces — Produces:** `Config` fields `dashboardPort:number`, `dashboardBind:string`, `dashboardAuth:boolean`, `cameraFps:number`, `cameraFallbackMs:number`, `cameraDevicePort:string` (`""` = auto).

- [ ] **Step 1: Failing test** — append to `tb3-mcp/test/config.test.ts`:

```typescript
describe("dashboard config", () => {
  it("defaults", () => {
    const c = loadConfig(undefined, {});
    expect(c.dashboardPort).toBe(8788);
    expect(c.dashboardBind).toBe("0.0.0.0");
    expect(c.dashboardAuth).toBe(false);
    expect(c.cameraFps).toBe(10);
    expect(c.cameraFallbackMs).toBe(1500);
    expect(c.cameraDevicePort).toBe("");
  });
  it("env overrides", () => {
    const c = loadConfig(undefined, { TB3_DASHBOARD_PORT: "9000", TB3_DASHBOARD_AUTH: "1", TB3_CAMERA_FPS: "5" });
    expect(c.dashboardPort).toBe(9000);
    expect(c.dashboardAuth).toBe(true);
    expect(c.cameraFps).toBe(5);
  });
});
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run test/config.test.ts`

- [ ] **Step 3: Implement.** In `ConfigSchema` (after the L4 agent fields):

```typescript
    // --- Ops dashboard ---
    dashboardPort: z.number().int().positive().max(65535).default(8788),
    dashboardBind: z.string().min(1).default("0.0.0.0"),
    dashboardAuth: z.boolean().default(false),
    cameraFps: z.number().positive().max(30).default(10),
    cameraFallbackMs: z.number().positive().default(1500),
    cameraDevicePort: z.string().default(""),
```

In `loadConfig`, after the agent env lines:

```typescript
  set("dashboardPort", num(env.TB3_DASHBOARD_PORT));
  set("dashboardBind", env.TB3_DASHBOARD_BIND);
  set("dashboardAuth", bool(env.TB3_DASHBOARD_AUTH));
  set("cameraFps", num(env.TB3_CAMERA_FPS));
  set("cameraFallbackMs", num(env.TB3_CAMERA_FALLBACK_MS));
  set("cameraDevicePort", env.TB3_CAMERA_DEVICE_PORT);
```

- [ ] **Step 4: Run — PASS.** `npx vitest run test/config.test.ts`
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/config.ts tb3-mcp/test/config.test.ts && git commit -m "feat(dash): config fields for the ops dashboard"`

---

### Task 2: Pure parsers (ESP32 status + systemctl)

**Files:** Create `tb3-mcp/src/dashboard/parse.ts`; Test `tb3-mcp/test/dashboard-parse.test.ts`.

**Interfaces — Produces:**
- `interface RigDirect { connected: boolean; moving: boolean; batteryV: number|null; panSteps: number|null; tiltSteps: number|null; imu: { ok: boolean; pitchDeg: number|null; rollDeg: number|null; tempC: number|null; pressHpa: number|null } | null; joyLatched: boolean }`
- `parseRigStatus(raw: unknown): RigDirect` — defensive; missing fields → null/false, never throws.
- `type ServiceState = "active" | "inactive" | "failed" | "unknown"`
- `parseServiceState(systemctlIsActiveOutput: string): ServiceState` — maps `systemctl is-active` output (`active`/`inactive`/`failed`/`activating`/`deactivating`/unknown) to the 4-state enum (`activating`→`inactive`, anything unrecognized→`unknown`).

- [ ] **Step 1: Failing test** — `tb3-mcp/test/dashboard-parse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRigStatus, parseServiceState } from "../src/dashboard/parse.js";

const SAMPLE = {
  pos: { pan: 44444, tilt: -8888, aux: 0 }, moving: 1, joy_latched: false,
  program_engaged: false, battery_v: 12.3, uptime_ms: 5000, heap: 170000,
  wifi: { ap_ip: "10.31.31.1", sta_ip: "192.168.4.56", clients: 1 },
  imu: { ok: true, pitch: 1.5, roll: -2.0, tempC: 25.0, pressHpa: 1008.0 },
};

describe("parseRigStatus", () => {
  it("parses full telemetry (steps kept raw, imu present)", () => {
    const r = parseRigStatus(SAMPLE);
    expect(r.connected).toBe(true);
    expect(r.moving).toBe(true);           // 1 → true
    expect(r.batteryV).toBe(12.3);
    expect(r.panSteps).toBe(44444);
    expect(r.tiltSteps).toBe(-8888);
    expect(r.imu?.ok).toBe(true);
    expect(r.imu?.pitchDeg).toBe(1.5);
    expect(r.joyLatched).toBe(false);
  });
  it("imu absent → imu null, still connected", () => {
    const r = parseRigStatus({ pos: { pan: 0, tilt: 0, aux: 0 }, moving: 0, battery_v: 12 });
    expect(r.connected).toBe(true);
    expect(r.moving).toBe(false);
    expect(r.imu).toBeNull();
  });
  it("garbage → not connected, all null, never throws", () => {
    expect(parseRigStatus(null).connected).toBe(false);
    expect(parseRigStatus("nope").panSteps).toBeNull();
    expect(parseRigStatus({}).connected).toBe(false);   // no pos → not a real status
  });
});

describe("parseServiceState", () => {
  it("maps systemctl is-active output", () => {
    expect(parseServiceState("active\n")).toBe("active");
    expect(parseServiceState("inactive")).toBe("inactive");
    expect(parseServiceState("failed")).toBe("failed");
    expect(parseServiceState("activating")).toBe("inactive");
    expect(parseServiceState("")).toBe("unknown");
    expect(parseServiceState("weird")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement** `tb3-mcp/src/dashboard/parse.ts`:

```typescript
export interface RigImu {
  ok: boolean;
  pitchDeg: number | null; rollDeg: number | null;
  tempC: number | null; pressHpa: number | null;
}
export interface RigDirect {
  connected: boolean;
  moving: boolean;
  batteryV: number | null;
  panSteps: number | null;
  tiltSteps: number | null;
  imu: RigImu | null;
  joyLatched: boolean;
}
export type ServiceState = "active" | "inactive" | "failed" | "unknown";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseRigStatus(raw: unknown): RigDirect {
  const empty: RigDirect = {
    connected: false, moving: false, batteryV: null,
    panSteps: null, tiltSteps: null, imu: null, joyLatched: false,
  };
  if (typeof raw !== "object" || raw === null) return empty;
  const r = raw as Record<string, unknown>;
  const pos = (typeof r.pos === "object" && r.pos !== null) ? r.pos as Record<string, unknown> : null;
  if (!pos) return empty;   // no position block → not a real /api/status body

  let imu: RigImu | null = null;
  if (typeof r.imu === "object" && r.imu !== null) {
    const i = r.imu as Record<string, unknown>;
    imu = {
      ok: i.ok === true || i.ok === 1,
      pitchDeg: numOrNull(i.pitch), rollDeg: numOrNull(i.roll),
      tempC: numOrNull(i.tempC), pressHpa: numOrNull(i.pressHpa),
    };
  }
  return {
    connected: true,
    moving: r.moving === true || r.moving === 1,
    batteryV: numOrNull(r.battery_v),
    panSteps: numOrNull(pos.pan),
    tiltSteps: numOrNull(pos.tilt),
    imu,
    joyLatched: r.joy_latched === true,
  };
}

export function parseServiceState(out: string): ServiceState {
  const s = out.trim();
  if (s === "active") return "active";
  if (s === "inactive" || s === "activating" || s === "deactivating") return "inactive";
  if (s === "failed") return "failed";
  return "unknown";
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/dashboard/parse.ts tb3-mcp/test/dashboard-parse.test.ts && git commit -m "feat(dash): pure parsers for ESP32 status + systemctl state"`

---

### Task 3: DashboardState + the aggregation merge

**Files:** Create `tb3-mcp/src/dashboard/state.ts`; Test `tb3-mcp/test/dashboard-state.test.ts`.

**Interfaces — Consumes:** `RigDirect`, `ServiceState` (Task 2). **Produces:**
- `type Result<T> = { ok: true; value: T } | { ok: false; error: string }`
- `interface ServicesState { readsb: ServiceState; tb3mcp: ServiceState; tb3agent: ServiceState; llama: ServiceState }`
- source raw types: `DeviceStatus`, `TrackingRaw`, `TrackedRaw`, `CalibrationRaw`, `SunRaw`, `AdsbRaw`, `AircraftRow`
- `Mode = "idle" | "manual" | "autonomous"`
- `interface DashboardState { ts:number; services:ServicesState; rig:{...}; mode:Mode; tracking:{...}; calibration:{...}; adsb:{...}; sunGuard:{...}; errors:string[] }` (full shape below)
- `interface SourceInputs { deviceStatus:Result<DeviceStatus>; rigDirect:Result<RigDirect>; tracking:Result<TrackingRaw>; tracked:Result<TrackedRaw>; calibration:Result<CalibrationRaw>; sun:Result<SunRaw>; services:ServicesState; adsb:Result<AdsbRaw> }`
- `mergeState(s: SourceInputs, nowMs: number): DashboardState`

Mode rule: `tb3agent === "active"` → `autonomous`; else `tracking.state !== "stopped"` → `manual`; else `idle`. rig.connected = deviceStatus.ok-and-connected OR rigDirect.ok-and-connected. pan/tilt degrees come from deviceStatus when ok, else null (raw steps stay in rigDirect but the merged rig shows degrees only). Each failed source appends `"<name>: <error>"` to `errors` and leaves its field at a safe default.

- [ ] **Step 1: Failing test** — `tb3-mcp/test/dashboard-state.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeState, type SourceInputs, type ServicesState } from "../src/dashboard/state.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (error: string) => ({ ok: false as const, error });
const SVC: ServicesState = { readsb: "active", tb3mcp: "active", tb3agent: "inactive", llama: "inactive" };

function inputs(over: Partial<SourceInputs> = {}): SourceInputs {
  return {
    deviceStatus: ok({ connected: true, pan_deg: 10, tilt_deg: 20, moving: false, battery_v: 12.1, stale: false, last_update_age_ms: 100 }),
    rigDirect: ok({ connected: true, moving: false, batteryV: 12.1, panSteps: 4444, tiltSteps: 8888,
      imu: { ok: true, pitchDeg: 1, rollDeg: 2, tempC: 25, pressHpa: 1008 }, joyLatched: false }),
    tracking: ok({ state: "stopped", label: null, target_azimuth_deg: null, target_elevation_deg: null,
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false }),
    tracked: ok({ hex: null }),
    calibration: ok({ calibrated: true, rig: { lat: 33, lon: -112, height: 0 }, sightings: [], solved_at: "2026-07-19T00:00:00Z" }),
    sun: ok({ state: "monitoring", locked: false, separationDeg: 80 }),
    services: SVC,
    adsb: ok({ rawCount: 12, trackable: [] }),
    ...over,
  };
}

describe("mergeState mode derivation", () => {
  it("idle when agent off and not tracking", () => {
    expect(mergeState(inputs(), 1000).mode).toBe("idle");
  });
  it("manual when agent off but tracking active", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false }),
      tracked: ok({ hex: "abc123" }) }), 1000);
    expect(s.mode).toBe("manual");
    expect(s.tracking.hex).toBe("abc123");
    expect(s.tracking.callsign).toBe("UAL1");
    expect(s.tracking.targetAzDeg).toBe(90);
  });
  it("autonomous when the agent service is active", () => {
    const s = mergeState(inputs({ services: { ...SVC, tb3agent: "active" },
      tracking: ok({ state: "tracking", label: "x", target_azimuth_deg: 1, target_elevation_deg: 1,
        target_range_m: 1, pointing_error_deg: 1, pan_limited: false, tilt_limited: false }) }), 1000);
    expect(s.mode).toBe("autonomous");
  });
});

describe("mergeState degradation", () => {
  it("a failed source marks its field + records an error, others intact", () => {
    const s = mergeState(inputs({ deviceStatus: err("ECONNREFUSED"), rigDirect: err("timeout") }), 1000);
    expect(s.rig.connected).toBe(false);          // neither source up
    expect(s.rig.panDeg).toBeNull();
    expect(s.errors.some((e) => e.includes("ECONNREFUSED"))).toBe(true);
    expect(s.services.readsb).toBe("active");      // unaffected
    expect(s.calibration.calibrated).toBe(true);
  });
  it("rig connected via direct even when the daemon get_status fails", () => {
    const s = mergeState(inputs({ deviceStatus: err("daemon down") }), 1000);
    expect(s.rig.connected).toBe(true);            // rigDirect still up
    expect(s.rig.imu?.ok).toBe(true);
  });
  it("stamps ts and never throws on all-failed", () => {
    const allErr = err("x");
    const s = mergeState({ deviceStatus: allErr, rigDirect: allErr, tracking: allErr, tracked: allErr,
      calibration: allErr, sun: allErr, services: { readsb: "unknown", tb3mcp: "unknown", tb3agent: "unknown", llama: "unknown" },
      adsb: allErr }, 4242);
    expect(s.ts).toBe(4242);
    expect(s.mode).toBe("idle");
    expect(s.rig.connected).toBe(false);
    expect(s.adsb.trackable).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `tb3-mcp/src/dashboard/state.ts`:

```typescript
import { RigDirect, ServiceState } from "./parse.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ServicesState { readsb: ServiceState; tb3mcp: ServiceState; tb3agent: ServiceState; llama: ServiceState; }

export interface DeviceStatus {
  connected: boolean; pan_deg: number; tilt_deg: number; moving: boolean;
  battery_v: number; stale: boolean; last_update_age_ms: number | null;
}
export interface TrackingRaw {
  state: string; label: string | null;
  target_azimuth_deg: number | null; target_elevation_deg: number | null; target_range_m: number | null;
  pointing_error_deg: number | null; pan_limited: boolean; tilt_limited: boolean;
}
export interface TrackedRaw { hex: string | null; }
export interface Geo { lat: number; lon: number; height: number; }
export interface CalibrationRaw { calibrated: boolean; rig: Geo | null; sightings: unknown[]; solved_at: string | null; }
export interface SunRaw { state: string; locked: boolean; separationDeg: number | null; }
export interface AircraftRow {
  hex: string; callsign: string | null; category: string | null; squawk: string | null;
  altitude_m: number | null; ground_speed_kt: number | null;
  azimuth_deg: number; elevation_deg: number; range_km: number; est_track_sec: number;
}
export interface AdsbRaw { rawCount: number | null; trackable: AircraftRow[]; }

export type Mode = "idle" | "manual" | "autonomous";

export interface DashboardState {
  ts: number;
  services: ServicesState;
  rig: {
    connected: boolean; panDeg: number | null; tiltDeg: number | null; moving: boolean;
    batteryV: number | null; telemetryAgeMs: number | null;
    imu: RigDirect["imu"];
  };
  mode: Mode;
  tracking: {
    state: string; hex: string | null; callsign: string | null;
    targetAzDeg: number | null; targetElDeg: number | null; targetRangeM: number | null;
    pointingErrorDeg: number | null; panLimited: boolean; tiltLimited: boolean;
  };
  calibration: { calibrated: boolean; rig: Geo | null; sightings: unknown[]; solvedAt: string | null; };
  adsb: { rawCount: number | null; trackable: AircraftRow[]; };
  sunGuard: { state: string; locked: boolean; separationDeg: number | null; };
  errors: string[];
}

export interface SourceInputs {
  deviceStatus: Result<DeviceStatus>;
  rigDirect: Result<RigDirect>;
  tracking: Result<TrackingRaw>;
  tracked: Result<TrackedRaw>;
  calibration: Result<CalibrationRaw>;
  sun: Result<SunRaw>;
  services: ServicesState;
  adsb: Result<AdsbRaw>;
}

export function mergeState(s: SourceInputs, nowMs: number): DashboardState {
  const errors: string[] = [];
  const note = (name: string, r: Result<unknown>) => { if (!r.ok) errors.push(`${name}: ${r.error}`); };
  for (const [k, v] of Object.entries(s)) {
    if (k !== "services" && v && typeof v === "object" && "ok" in v) note(k, v as Result<unknown>);
  }

  const dev = s.deviceStatus.ok ? s.deviceStatus.value : null;
  const rd = s.rigDirect.ok ? s.rigDirect.value : null;
  const trk = s.tracking.ok ? s.tracking.value : null;
  const tracked = s.tracked.ok ? s.tracked.value : null;
  const cal = s.calibration.ok ? s.calibration.value : null;
  const sun = s.sun.ok ? s.sun.value : null;
  const adsb = s.adsb.ok ? s.adsb.value : null;

  const trackingState = trk?.state ?? "unknown";
  const mode: Mode = s.services.tb3agent === "active" ? "autonomous"
    : (trk && trk.state !== "stopped" && trk.state !== "unknown") ? "manual"
    : "idle";

  return {
    ts: nowMs,
    services: s.services,
    rig: {
      connected: (dev?.connected ?? false) || (rd?.connected ?? false),
      panDeg: dev ? dev.pan_deg : null,
      tiltDeg: dev ? dev.tilt_deg : null,
      moving: dev?.moving ?? rd?.moving ?? false,
      batteryV: dev?.battery_v ?? rd?.batteryV ?? null,
      telemetryAgeMs: dev?.last_update_age_ms ?? null,
      imu: rd?.imu ?? null,
    },
    mode,
    tracking: {
      state: trackingState,
      hex: tracked?.hex ?? null,
      callsign: trk?.label ?? null,
      targetAzDeg: trk?.target_azimuth_deg ?? null,
      targetElDeg: trk?.target_elevation_deg ?? null,
      targetRangeM: trk?.target_range_m ?? null,
      pointingErrorDeg: trk?.pointing_error_deg ?? null,
      panLimited: trk?.pan_limited ?? false,
      tiltLimited: trk?.tilt_limited ?? false,
    },
    calibration: {
      calibrated: cal?.calibrated ?? false,
      rig: cal?.rig ?? null,
      sightings: cal?.sightings ?? [],
      solvedAt: cal?.solved_at ?? null,
    },
    adsb: { rawCount: adsb?.rawCount ?? null, trackable: adsb?.trackable ?? [] },
    sunGuard: { state: sun?.state ?? "unknown", locked: sun?.locked ?? false, separationDeg: sun?.separationDeg ?? null },
    errors,
  };
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/dashboard/state.ts tb3-mcp/test/dashboard-state.test.ts && git commit -m "feat(dash): DashboardState + pure mergeState aggregation core"`

---

### Task 4: Control mapping + E-STOP fan-out

**Files:** Create `tb3-mcp/src/dashboard/controls.ts`; Test `tb3-mcp/test/dashboard-controls.test.ts`.

**Interfaces — Produces:**
- `interface ControlDeps { track(hex:string):Promise<void>; stopTracking():Promise<void>; jog(panDps:number,tiltDps:number,durationMs:number):Promise<void>; setRigLocation(lat:number,lon:number,heightM:number):Promise<void>; sightLandmark(lat:number,lon:number,heightM:number,label?:string):Promise<void>; solveCalibration():Promise<string>; clearCalibration():Promise<void>; firmwareStop():Promise<void>; agentStop():Promise<void>; agentStart():Promise<void> }`
- `interface ActionResult { ok:boolean; message:string }`
- `interface EstopResult { firmware:ActionResult; tracking:ActionResult; agent:ActionResult; allOk:boolean }`
- `emergencyStop(d: ControlDeps): Promise<EstopResult>` — fires `firmwareStop`, `stopTracking`, `agentStop` **in parallel**, each wrapped so one failure never aborts the others; returns per-action results.
- `runAction(d: ControlDeps, action: string, body: Record<string, unknown>): Promise<ActionResult>` — dispatches `track|stop|agent|jog|calibrate/set-location|calibrate/sight|calibrate/solve|calibrate/clear` to the right dep, returning `{ok,message}` (never throws).

- [ ] **Step 1: Failing test** — `tb3-mcp/test/dashboard-controls.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { emergencyStop, runAction, type ControlDeps } from "../src/dashboard/controls.js";

function deps(over: Partial<ControlDeps> = {}): { d: ControlDeps; calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => async (...a: unknown[]) => { calls.push(`${n}:${JSON.stringify(a)}`); };
  const d: ControlDeps = {
    track: rec("track"), stopTracking: rec("stopTracking"),
    jog: rec("jog"), setRigLocation: rec("setRigLocation"), sightLandmark: rec("sightLandmark"),
    solveCalibration: async () => { calls.push("solve"); return "heading 71"; }, clearCalibration: rec("clearCalibration"),
    firmwareStop: rec("firmwareStop"), agentStop: rec("agentStop"), agentStart: rec("agentStart"),
    ...over,
  };
  return { d, calls };
}

describe("emergencyStop", () => {
  it("fires all three in parallel and reports allOk", async () => {
    const { d, calls } = deps();
    const r = await emergencyStop(d);
    expect(calls.sort()).toEqual(["agentStop:[]", "firmwareStop:[]", "stopTracking:[]"]);
    expect(r.allOk).toBe(true);
    expect(r.firmware.ok).toBe(true);
  });
  it("one failure does NOT abort the others", async () => {
    const { d, calls } = deps({ firmwareStop: async () => { throw new Error("rig unreachable"); } });
    const r = await emergencyStop(d);
    expect(r.firmware.ok).toBe(false);
    expect(r.firmware.message).toMatch(/rig unreachable/);
    expect(r.tracking.ok).toBe(true);            // still fired
    expect(r.agent.ok).toBe(true);
    expect(r.allOk).toBe(false);
    expect(calls).toContain("stopTracking:[]");
    expect(calls).toContain("agentStop:[]");
  });
});

describe("runAction", () => {
  it("routes track/stop/agent/jog/calibration", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "track", { hex: "abc" })).ok).toBe(true);
    await runAction(d, "stop", {});
    await runAction(d, "agent", { on: true });
    await runAction(d, "jog", { pan_dps: 5, tilt_dps: 0, duration_ms: 300 });
    await runAction(d, "calibrate/set-location", { lat: 1, lon: 2, height_m: 3 });
    await runAction(d, "calibrate/sight", { lat: 1, lon: 2, height_m: 3, label: "A" });
    const solved = await runAction(d, "calibrate/solve", {});
    expect(solved.message).toMatch(/heading/);
    expect(calls).toContain('track:["abc"]');
    expect(calls).toContain("agentStart:[]");
    expect(calls).toContain("jog:[5,0,300]");
  });
  it("unknown action → {ok:false}", async () => {
    const { d } = deps();
    expect((await runAction(d, "explode", {})).ok).toBe(false);
  });
  it("a throwing dep → {ok:false, message}", async () => {
    const { d } = deps({ track: async () => { throw new Error("sun locked"); } });
    const r = await runAction(d, "track", { hex: "x" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sun locked/);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `tb3-mcp/src/dashboard/controls.ts`:

```typescript
export interface ControlDeps {
  track(hex: string): Promise<void>;
  stopTracking(): Promise<void>;
  jog(panDps: number, tiltDps: number, durationMs: number): Promise<void>;
  setRigLocation(lat: number, lon: number, heightM: number): Promise<void>;
  sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void>;
  solveCalibration(): Promise<string>;
  clearCalibration(): Promise<void>;
  firmwareStop(): Promise<void>;
  agentStop(): Promise<void>;
  agentStart(): Promise<void>;
}

export interface ActionResult { ok: boolean; message: string; }
export interface EstopResult { firmware: ActionResult; tracking: ActionResult; agent: ActionResult; allOk: boolean; }

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function attempt(fn: () => Promise<unknown>, okMsg: string): Promise<ActionResult> {
  try { await fn(); return { ok: true, message: okMsg }; }
  catch (e) { return { ok: false, message: msg(e) }; }
}

export async function emergencyStop(d: ControlDeps): Promise<EstopResult> {
  const [firmware, tracking, agent] = await Promise.all([
    attempt(() => d.firmwareStop(), "rig stopped"),
    attempt(() => d.stopTracking(), "tracking stopped"),
    attempt(() => d.agentStop(), "agent stopped"),
  ]);
  return { firmware, tracking, agent, allOk: firmware.ok && tracking.ok && agent.ok };
}

function num(v: unknown, dflt = 0): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }

export async function runAction(d: ControlDeps, action: string, body: Record<string, unknown>): Promise<ActionResult> {
  try {
    switch (action) {
      case "track": {
        const hex = str(body.hex);
        if (!hex) return { ok: false, message: "hex required" };
        await d.track(hex); return { ok: true, message: `tracking ${hex}` };
      }
      case "stop": await d.stopTracking(); return { ok: true, message: "tracking stopped" };
      case "agent":
        if (body.on === true) { await d.agentStart(); return { ok: true, message: "agent started" }; }
        await d.agentStop(); return { ok: true, message: "agent stopped" };
      case "jog":
        await d.jog(num(body.pan_dps), num(body.tilt_dps), num(body.duration_ms, 300));
        return { ok: true, message: "jogged" };
      case "calibrate/set-location":
        await d.setRigLocation(num(body.lat), num(body.lon), num(body.height_m));
        return { ok: true, message: "rig location set" };
      case "calibrate/sight":
        await d.sightLandmark(num(body.lat), num(body.lon), num(body.height_m), str(body.label));
        return { ok: true, message: "landmark sighted" };
      case "calibrate/solve": return { ok: true, message: await d.solveCalibration() };
      case "calibrate/clear": await d.clearCalibration(); return { ok: true, message: "calibration cleared" };
      default: return { ok: false, message: `unknown action: ${action}` };
    }
  } catch (e) { return { ok: false, message: msg(e) }; }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/dashboard/controls.ts tb3-mcp/test/dashboard-controls.test.ts && git commit -m "feat(dash): control mapping + parallel E-STOP fan-out"`

---

### Task 5: rig.ts (direct ESP32 status + stop) + services.ts (systemctl)

**Files:** Create `tb3-mcp/src/dashboard/rig.ts`, `tb3-mcp/src/dashboard/services.ts`; Test `tb3-mcp/test/dashboard-rig.test.ts`, `tb3-mcp/test/dashboard-services.test.ts`.

**Interfaces — Consumes:** `parseRigStatus`/`RigDirect`/`parseServiceState`/`ServiceState` (Task 2), `ServicesState` (Task 3). **Produces:**
- `class RigDirectClient { constructor(hosts: string[], fetchFn?: typeof fetch); status(): Promise<RigDirect>; stop(): Promise<void> }` — GETs `http://<host>/api/status`, POSTs `http://<host>/api/stop`; tries hosts in order.
- `interface Systemctl { isActive(unit: string): Promise<ServiceState>; start(unit: string): Promise<void>; stop(unit: string): Promise<void> }`
- `class RealSystemctl implements Systemctl` (uses `child_process.execFile`, injectable via constructor for tests)
- `readServices(sc: Systemctl): Promise<ServicesState>` — reads the four units concurrently.

- [ ] **Step 1: Failing tests.**

`tb3-mcp/test/dashboard-rig.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { RigDirectClient } from "../src/dashboard/rig.js";

const BODY = { pos: { pan: 4444, tilt: 0, aux: 0 }, moving: 0, battery_v: 12, imu: { ok: true, pitch: 1, roll: 2, tempC: 25, pressHpa: 1008 } };
const fetchOk = (async () => ({ ok: true, json: async () => BODY })) as unknown as typeof fetch;

describe("RigDirectClient", () => {
  it("status parses /api/status", async () => {
    const r = await new RigDirectClient(["1.2.3.4"], fetchOk).status();
    expect(r.connected).toBe(true);
    expect(r.imu?.ok).toBe(true);
  });
  it("status on fetch failure → not connected (never throws)", async () => {
    const bad = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const r = await new RigDirectClient(["1.2.3.4"], bad).status();
    expect(r.connected).toBe(false);
  });
  it("stop POSTs and throws on non-ok (so the e-stop reports failure)", async () => {
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(new RigDirectClient(["1.2.3.4"], bad).stop()).rejects.toThrow();
  });
});
```

`tb3-mcp/test/dashboard-services.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readServices, type Systemctl } from "../src/dashboard/services.js";

describe("readServices", () => {
  it("maps the four units", async () => {
    const sc: Systemctl = {
      isActive: async (u) => (u === "tb3-agent" ? "active" : u === "llama-server" ? "inactive" : "active"),
      start: async () => {}, stop: async () => {},
    };
    const s = await readServices(sc);
    expect(s.tb3agent).toBe("active");
    expect(s.llama).toBe("inactive");
    expect(s.readsb).toBe("active");
    expect(s.tb3mcp).toBe("active");
  });
  it("a failing probe → that unit unknown, others intact", async () => {
    const sc: Systemctl = {
      isActive: async (u) => { if (u === "readsb") throw new Error("nope"); return "active"; },
      start: async () => {}, stop: async () => {},
    };
    const s = await readServices(sc);
    expect(s.readsb).toBe("unknown");
    expect(s.tb3mcp).toBe("active");
  });
});
```

- [ ] **Step 2: Run — FAIL** (both).

- [ ] **Step 3: Implement.**

`tb3-mcp/src/dashboard/rig.ts`:
```typescript
import { RigDirect, parseRigStatus } from "./parse.js";

const TIMEOUT_MS = 3000;

export class RigDirectClient {
  constructor(private readonly hosts: string[], private readonly fetchFn: typeof fetch = fetch) {}

  async status(): Promise<RigDirect> {
    for (const h of this.hosts) {
      try {
        const r = await this.fetchFn(`http://${h}/api/status`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) continue;
        return parseRigStatus(await r.json());
      } catch { /* try next host */ }
    }
    return parseRigStatus(null);   // not connected
  }

  // Throws on failure so the e-stop fan-out reports the firmware leg as failed.
  async stop(): Promise<void> {
    let lastErr: unknown = new Error("no rig host reachable");
    for (const h of this.hosts) {
      try {
        const r = await this.fetchFn(`http://${h}/api/stop`, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.ok || r.status === 202) return;
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
```

`tb3-mcp/src/dashboard/services.ts`:
```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceState, parseServiceState } from "./parse.js";
import { ServicesState } from "./state.js";

const pexec = promisify(execFile);

export interface Systemctl {
  isActive(unit: string): Promise<ServiceState>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
}

export class RealSystemctl implements Systemctl {
  // `systemctl is-active` exits non-zero for inactive/failed but still prints the
  // state on stdout — so read stdout regardless of exit code.
  async isActive(unit: string): Promise<ServiceState> {
    try {
      const { stdout } = await pexec("systemctl", ["is-active", unit]);
      return parseServiceState(stdout);
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return typeof out === "string" ? parseServiceState(out) : "unknown";
    }
  }
  async start(unit: string): Promise<void> { await pexec("systemctl", ["start", unit]); }
  async stop(unit: string): Promise<void> { await pexec("systemctl", ["stop", unit]); }
}

const UNITS: Record<keyof ServicesState, string> = {
  readsb: "readsb", tb3mcp: "tb3-mcp", tb3agent: "tb3-agent", llama: "llama-server",
};

export async function readServices(sc: Systemctl): Promise<ServicesState> {
  const entries = await Promise.all(
    (Object.keys(UNITS) as (keyof ServicesState)[]).map(async (key) => {
      try { return [key, await sc.isActive(UNITS[key])] as const; }
      catch { return [key, "unknown" as ServiceState] as const; }
    }),
  );
  return Object.fromEntries(entries) as ServicesState;
}
```

- [ ] **Step 4: Run — PASS** (both files).
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/dashboard/rig.ts tb3-mcp/src/dashboard/services.ts tb3-mcp/test/dashboard-rig.test.ts tb3-mcp/test/dashboard-services.test.ts && git commit -m "feat(dash): direct ESP32 rig client + systemctl service reader"`

---

### Task 6: DashboardClient (MCP tool wrapper)

**Files:** Create `tb3-mcp/src/dashboard/client.ts`. **No unit test** (live MCP I/O; gated by `tsc` + used via a fake in Tasks 3/4/7).

**Interfaces — Consumes:** the MCP SDK `Client`/`StreamableHTTPClientTransport`, and the `resultText` pattern from `src/agent/mcp-client.ts`. **Produces:** `class McpDashboardClient` with `connect()`, and typed methods returning the source shapes from Task 3: `getDeviceStatus():Promise<DeviceStatus>`, `getTrackingStatus():Promise<TrackingRaw>`, `getTracked():Promise<TrackedRaw>`, `getCalibration():Promise<CalibrationRaw>`, `getSun():Promise<SunRaw>`, `scanTrackable():Promise<AircraftRow[]>`, plus controls `track(hex)`, `stopTracking()`, `jog(panDps,tiltDps,durationMs)`, `setRigLocation(lat,lon,heightM)`, `sightLandmark(lat,lon,heightM,label?)`, `solveCalibration():Promise<string>`, `clearCalibration()`.

- [ ] **Step 1: Implement** `tb3-mcp/src/dashboard/client.ts` — reuse the exact `Client` + `StreamableHTTPClientTransport` + `resultText` shapes proven in `src/agent/mcp-client.ts` (read that file first for the verified SDK call signatures). Each method: `JSON.parse(await this.call(tool, args))` then narrow with a small Zod schema into the Task-3 type. Example skeleton (fill every method the same way):

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { DeviceStatus, TrackingRaw, TrackedRaw, CalibrationRaw, SunRaw, AircraftRow } from "./state.js";

export function resultText(name: string, result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const t = r.content?.find((c) => c.type === "text")?.text;
  if (typeof t !== "string") throw new Error(`${name}: tool returned no text content`);
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
}

const DeviceStatusZ = z.object({
  connected: z.boolean(), pan_deg: z.number(), tilt_deg: z.number(), moving: z.boolean(),
  battery_v: z.number(), stale: z.boolean(), last_update_age_ms: z.number().nullable(),
});
// ... TrackingRawZ, TrackedRawZ, CalibrationRawZ, SunRawZ, ScanZ (aircraft rows) similarly,
//     matching the tool outputs documented in the plan's "Interfaces this dashboard consumes".

export class McpDashboardClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = new Client({ name: "tb3-dashboard", version: "0.1.0" });
  }
  async connect(): Promise<void> {
    const opts = this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url), opts));
  }
  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    return resultText(name, await this.client.callTool({ name, arguments: args }));
  }
  async getDeviceStatus(): Promise<DeviceStatus> { return DeviceStatusZ.parse(JSON.parse(await this.call("get_status", {}))); }
  // getTrackingStatus/getTracked/getCalibration/getSun: same shape, get_tracking_status/get_tracked_aircraft/get_calibration/get_sun
  // scanTrackable(): parse scan_aircraft → body.aircraft as AircraftRow[]
  async track(hex: string): Promise<void> { await this.call("track_aircraft", { hex }); }
  async stopTracking(): Promise<void> { await this.call("stop_tracking", {}); }
  async jog(panDps: number, tiltDps: number, durationMs: number): Promise<void> {
    await this.call("jog", { pan_dps: panDps, tilt_dps: tiltDps, duration_ms: durationMs });
  }
  async setRigLocation(lat: number, lon: number, heightM: number): Promise<void> {
    await this.call("set_rig_location", { lat, lon, height_m: heightM });
  }
  async sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void> {
    await this.call("sight_landmark", { lat, lon, height_m: heightM, label });
  }
  async solveCalibration(): Promise<string> { return this.call("solve_calibration", {}); }
  async clearCalibration(): Promise<void> { await this.call("clear_calibration", {}); }
}
```

Implement EVERY method fully (the skeleton elides `getTrackingStatus`/`getTracked`/`getCalibration`/`getSun`/`scanTrackable` and their Zod schemas — write them, mapping each tool's documented output to its Task-3 type; `get_sun`'s output field names must be read from `src/sun-tools.ts` and mapped to `{state, locked, separationDeg}`).

- [ ] **Step 2: Build.** `npm run build` — must be clean (no `any`, all methods typed).
- [ ] **Step 3: Commit.** `git add tb3-mcp/src/dashboard/client.ts && git commit -m "feat(dash): MCP dashboard client (typed tool wrappers)"`

---

### Task 7: Aggregator poller + Express server + SSE + control routes

**Files:** Create `tb3-mcp/src/dashboard/server.ts`; Modify `tb3-mcp/package.json` (scripts). **No unit test** (live HTTP/SSE; gated by `tsc` + on-host). The pure `mergeState`/`controls`/`readServices` it wires are already tested.

**Interfaces — Consumes:** `mergeState`/`SourceInputs`/`Result` (Task 3), `runAction`/`emergencyStop`/`ControlDeps` (Task 4), `RigDirectClient`/`RealSystemctl`/`readServices` (Task 5), `McpDashboardClient` (Task 6), `CameraStreamer` (Task 8), `loadConfig` (config). **Produces:** `main()`.

- [ ] **Step 1: Implement** `tb3-mcp/src/dashboard/server.ts`. Structure:
  - Build `client` (McpDashboardClient, connect), `rig` (RigDirectClient from `[cfg.deviceHost, cfg.deviceIpFallback].filter(Boolean)`), `sc` (RealSystemctl), `camera` (Task 8).
  - **`collect(): Promise<SourceInputs>`** — wrap each source call in `try/catch` into a `Result<T>` (`get_status`, `/api/status` direct, `get_tracking_status`, `get_tracked_aircraft`, `get_calibration`, `get_sun`, `scan_aircraft`→trackable + a direct readsb count via `fetch(cfg.adsbUrl)` for `rawCount`), and `readServices(sc)`.
  - **Poller:** every 1000 ms, `const snap = mergeState(await collect(), Date.now())`; keep as `latest`; broadcast to SSE clients (`res.write("data: " + JSON.stringify(snap) + "\n\n")`); non-overlapping (a `running` guard) + never throw (catch+log).
  - **`ControlDeps`** built from `client` + `rig` + `sc` (agentStart/Stop = `sc.start/stop("tb3-agent")`, firmwareStop = `rig.stop()`).
  - **Routes:** `express.static(dashboardPublicDir)`; `GET /api/state` → `latest`; `GET /api/stream` → SSE (set headers, add res to a Set, send `latest` immediately, remove on `close`); `POST /api/control/estop` → `emergencyStop(deps)`; `POST /api/control/*` → `runAction(deps, action, req.body)`; `GET /camera/stream` → `camera.attach(res)`. Optional bearer gate when `cfg.dashboardAuth` (reuse `cfg.mcpToken`), matching `server.ts`'s existing token middleware.
  - `app.listen(cfg.dashboardPort, cfg.dashboardBind, …)`; `main()` + `isEntry` guard like `agent.ts`.
  - Resolve the static dir relative to the compiled file (`dist/dashboard/server.js` → `../../dashboard/public`); document it.
- [ ] **Step 2: Add package.json scripts:** `"dashboard": "node dist/dashboard/server.js"`, `"dashboard:dev": "tsx src/dashboard/server.ts"`.
- [ ] **Step 3: Build.** `npm run build` clean; `npm test` — existing suites still green.
- [ ] **Step 4: Commit.** `git add tb3-mcp/src/dashboard/server.ts tb3-mcp/package.json && git commit -m "feat(dash): aggregator poller + Express server (state/SSE/controls/camera routes)"`

---

### Task 8: Camera streamer (gphoto2 → ffmpeg MJPEG)

**Files:** Create `tb3-mcp/src/dashboard/camera.ts`; Test `tb3-mcp/test/dashboard-camera.test.ts` (the viewer-refcount + fallback-selection logic only — the subprocess itself is on-host).

**Interfaces — Produces:**
- `interface Spawner { start(onFrame:(jpeg:Buffer)=>void, onExit:(code:number|null)=>void): { kill():void } }` — abstracts the gphoto2→ffmpeg pipeline (real impl) so the refcount/lifecycle is testable with a fake.
- `class CameraStreamer { constructor(makeSpawner: () => Spawner, opts:{fallbackMs:number}); attach(res: ServerResponse): void; viewerCount(): number; stop(): void }` — starts the spawner on first viewer, stops it at zero viewers, fans the latest frame to all attached `multipart/x-mixed-replace` responses, serves a placeholder frame when no frame yet / camera down.

- [ ] **Step 1: Failing test** — `tb3-mcp/test/dashboard-camera.test.ts` (test the refcount lifecycle with a fake Spawner + fake response objects; assert: no spawner until first attach; spawner started once for N viewers; stopped when all detach; a frame pushed to the spawner is written to every attached response). Write real assertions against `viewerCount()` and a recording fake `ServerResponse` (`{ write(): true, on(evt,cb){...}, end(){} }`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `tb3-mcp/src/dashboard/camera.ts`. The `CameraStreamer` holds a Set of response writers + the latest JPEG; `attach()` writes the multipart headers, adds the writer, starts the spawner if it was at zero, and streams the latest frame; on `res` `close`, removes the writer and stops the spawner at zero. `onFrame` stores the latest frame and writes a `--frame\r\nContent-Type: image/jpeg\r\n\r\n<jpeg>\r\n` boundary chunk to every writer. `onExit` triggers a bounded auto-restart. Include a `realSpawner(cfg)` factory (NOT unit-tested) that runs `gphoto2 --capture-movie --stdout` piped to `ffmpeg -i - -f mjpeg -q:v <q> -r <fps> -` and, on early exit / no frames within a timeout, falls back to a `--capture-preview` loop at `fallbackMs`. Document that the on-host build step decides which path the D5000 actually supports.

- [ ] **Step 4: Run — PASS** (refcount test).
- [ ] **Step 5: Commit.** `git add tb3-mcp/src/dashboard/camera.ts tb3-mcp/test/dashboard-camera.test.ts && git commit -m "feat(dash): camera MJPEG streamer (shared encoder, viewer refcount, fallback)"`

---

### Task 9: Frontend SPA (camera-centric cockpit)

**Files:** Create `tb3-mcp/dashboard/public/index.html`, `app.js`, `style.css`. **On-host manual verification** (no unit test).

**Interfaces — Consumes:** `GET /api/state`, `SSE /api/stream` (DashboardState), `POST /api/control/*`, `GET /camera/stream`.

- [ ] **Step 1: Implement `index.html`** — Layout A: a top bar (`#mode`, service LED row `#svc`, big `#estop` button); a main split — left `#camera` panel (`<img src="/camera/stream">` + a jog D-pad of buttons) and a right rail with `#rig`, `#tracking`, `#adsb` (a list container), and `#calibration` (the step form: lat/lon/height inputs, Set Location, Sight A, Sight B, Solve, Clear). Load `style.css` + `app.js`.
- [ ] **Step 2: Implement `app.js`** — open `EventSource("/api/stream")`; on message, `render(JSON.parse(e.data))`: update the mode chip, service LEDs (color by state), rig readout, tracking readout, and rebuild the ADS-B list (each row a "Track" button → `POST /api/control/track {hex}`). Wire the E-STOP button → `POST /api/control/estop`, then show the returned per-leg result and latch a "STOPPED — clear to resume" state that disables motion controls until a "clear" click. Wire jog buttons → `POST /api/control/jog`, the agent toggle → `POST /api/control/agent {on}`, stop → `/stop`, and the calibration buttons → `/calibrate/*`. Show a per-action toast from `{ok,message}`. Handle SSE disconnect (show "reconnecting").
- [ ] **Step 3: Implement `style.css`** — the cockpit grid (camera dominant left, compact right rail, top bar), service LED dots, a large red E-STOP, dark theme, responsive enough for a laptop/tablet.
- [ ] **Step 4: Build + local smoke.** `npm run build`; start `npm run dashboard:dev` against the dev machine (the daemon can be down — panels should show "unavailable" gracefully); confirm the page loads, SSE connects, and controls POST (they'll error without a live daemon — that's the graceful-degradation path). Full camera/live verification is the on-host step.
- [ ] **Step 5: Commit.** `git add tb3-mcp/dashboard/public && git commit -m "feat(dash): vanilla cockpit SPA (SSE render + controls + calibration)"`

---

### Task 10: Deploy unit, host-setup doc, config example, README

**Files:** Create `tb3-mcp/deploy/tb3-dashboard.service`, `tb3-mcp/deploy/HOST-SETUP.md`; Modify `tb3-mcp/config.example.json`, `tb3-mcp/README.md`.

- [ ] **Step 1:** `tb3-mcp/deploy/tb3-dashboard.service` — mirror `tb3-agent.service`: `After=network-online.target tb3-mcp.service`; `WorkingDirectory=/home/atomist/TB3-ESP32/tb3-mcp`; `Environment=TB3_CONFIG=…/config.json`; `ExecStartPre=/usr/bin/npm run build`; `ExecStart=/usr/bin/npm run dashboard`; `Restart=on-failure`. Note: needs permission to run `systemctl start/stop tb3-agent` (a polkit rule or a sudoers entry for the service user) — document it.
- [ ] **Step 2:** `tb3-mcp/deploy/HOST-SETUP.md` — the gvfs release prerequisite (`systemctl --user mask gvfs-gphoto2-volume-monitor` or the equivalent to free the D5000 for gphoto2), how to confirm `gphoto2 --capture-preview` grabs a frame, `ffmpeg` presence, and the systemctl permission note for the agent toggle.
- [ ] **Step 3:** Add the dashboard keys to `config.example.json` (dashboardPort 8788, dashboardBind, dashboardAuth false, cameraFps 10, cameraFallbackMs 1500, cameraDevicePort "").
- [ ] **Step 4:** Add a "Operations Dashboard" section to `README.md` — what it is, `npm run dashboard`, the URL, the E-STOP behavior, and the on-host camera setup pointer.
- [ ] **Step 5:** Build + full suite green. `npm run build && npm test`. Commit. `git add tb3-mcp/deploy tb3-mcp/config.example.json tb3-mcp/README.md && git commit -m "feat(dash): deploy unit + host-setup doc + config example + README"`

---

## On-host verification (after the tasks, on the host — not unit tests)

Gated by the gvfs release + a running daemon. Manual runbook:
1. `npm run build && npm run dashboard`; open `http://192.168.4.104:8788` on the LAN.
2. Service LEDs match `systemctl is-active`; rig telemetry + "connected" reflect the real rig; killing the daemon degrades gracefully (rig still shows via direct `/api/status`).
3. Camera panel shows live video (or the still-fallback); confirm the D5000's real fps and settle liveview-vs-fallback; verify it idles when the tab closes.
4. Manual track from the ADS-B list moves the rig; stop halts it; the agent toggle starts/stops `tb3-agent` and the mode flips to `autonomous`.
5. **E-STOP:** with the daemon deliberately stopped, the button still halts the rig (direct `/api/stop`); with it up, all three legs report success; the UI latches until cleared.
6. Calibration flow end-to-end (location → two sightings via jog + the live view → solve).

---

## Self-Review

**Spec coverage:** config (T1), parsers (T2), aggregation + mode + degradation (T3), controls + e-stop fan-out (T4), direct rig + systemctl (T5), MCP client (T6), poller/SSE/routes (T7), camera streamer (T8), cockpit SPA (T9), deploy + gvfs setup doc + README (T10). Camera fps/liveview-vs-fallback + gvfs release are on-host/host-setup, not code tasks (per spec). All covered.

**Placeholder scan:** the testable cores (T1–T5) carry complete code + tests; the glue tasks (T6–T9) are necessarily longer and give a complete skeleton plus an explicit "implement every method/route the same way" directive with the exact tool/route list — no vague "add error handling." T8's real subprocess and T9's CSS are described concretely (boundary format, layout, control wiring).

**Type consistency:** `DashboardState`/`SourceInputs`/`Result` (T3) are consumed unchanged by T7; `ControlDeps`/`ActionResult`/`EstopResult` (T4) by T7; `RigDirect`/`ServiceState` (T2) by T3/T5; the DeviceStatus/TrackingRaw/etc. source types (T3) are what T6's client methods return and what mergeState reads — names match. Tool names + JSON field names (`pan_deg`, `target_azimuth_deg`, `aircraft[]`, `pos`, `imu`) match the verified codebase surface.
