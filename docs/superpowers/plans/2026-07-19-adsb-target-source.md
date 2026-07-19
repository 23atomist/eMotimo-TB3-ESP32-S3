# Layer 4 — ADS-B Autonomous Target Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed real aircraft (ADS-B) into the existing Layer-3 tracking loop — a daemon-side ADS-B target source (poll → enrich → follow) plus a host-side autonomous agent that lets a local LLM pick the most interesting trackable aircraft.

**Architecture:** All new code is in the `tb3-mcp` TS/Node ESM daemon. **Phase A** adds `src/adsb/` (pure parse + convert + enrich, an `AdsbSource` poll loop, an `AdsbFollower` that pushes fixes into `TrackingSession`, and `scan_aircraft`/`track_aircraft`/`get_tracked_aircraft` MCP tools). **Phase B** adds `src/agent/` — a standalone MCP-client process whose deterministic loop calls the daemon tools, asks a local OpenAI-compatible LLM to choose a target (constrained JSON), and applies the choice through hysteresis + fail-safe guardrails. The daemon computes the hard, objective facts (reachable / sun-safe / slew-able); the LLM only applies "interesting" judgment over that already-safe set.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥18 (global `fetch`, `AbortSignal.timeout`), Zod, vitest (`fileParallelism:false`), `@modelcontextprotocol/sdk`. Reuses existing geo/track math.

## Global Constraints

- **No `any`.** Use `unknown` + narrowing at boundaries (parsing ADS-B JSON and LLM responses). ESM `.js` import specifiers on every relative import. (`tb3-mcp/src/config.ts` conventions.)
- **The existing 217 tests must stay green.** No changes to the firmware or the L1–L3 control path (`device.ts`, `move.ts`, `track/session.ts` internals, `track/control.ts`, `track/supervisor.ts`). L4 only *feeds* `TrackingSession` through its public methods.
- **`adsbEnabled` and the agent default to inert.** `adsbEnabled` defaults `false`; the agent is a separate opt-in process. Existing deployments are unaffected.
- **Safety is defense-in-depth and authoritative in the daemon.** `scan_aircraft` with `only_trackable:true` exposes ONLY aircraft that are `reachable && sunSafe && slewOk`. `track_aircraft` rejects any hex not in that set. The daemon's sun-guard / pan-tilt limits / deadman / staleness (unchanged) remain the final backstop. The agent's guardrails (hex validity, hysteresis, fail-safe) are additional, not a replacement.
- **Interestingness stays in the LLM.** The daemon never ranks by "cool" — it computes objective flags and surfaces raw signals (type/category/squawk/callsign/hex). `scan_aircraft` sorts by proximity only.
- **Units.** ADS-B altitude is **feet** → meters (× 0.3048); prefer `alt_geom` (WGS84 ellipsoidal, matches the rig height datum) else `alt_baro` (`adsbAltSource: auto|geom|baro`, `auto` = geom-else-baro). Ground speed **knots** → m/s (× 0.514444); vertical rate **ft/min** → m/s (× 0.00508). Heading/track is degrees true, 0=N, through `velocityFromSpeedHeading`.
- **Reuse, don't reinvent:** `enuDirection`/`enuPosition`/`azElRange`/`Geodetic` (`geo/wgs84.js`), `enuToPanTilt` (`geo/orientation.js`), `reachablePanTilt` (`geo-tools.js`), `sunEnu` (`geo/sun.js`), `angleBetweenDeg`/`Vec3`/`Mat3`/`sub`/`scale`/`dot`/`norm` (`geo/vec3.js`), `velocityFromSpeedHeading` (`track/estimator.js`), `Scheduler`/`realScheduler` (`track/session.js`), `text`/`errText`/`SUN_LOCKED_MSG` (`tool-helpers.js`), the `loadConfig` Zod+file+env pattern (`config.js`).

## Phase 0 — Prerequisites (EXTERNAL, user-owned — NOT tasks in this plan)

On the host `192.168.4.104` (Debian 13; RTX 5080 + XDNA2 NPU; see the spec). In progress by the user; the plan does not implement these but Phase B's on-host verification gates on them:

1. **ADS-B feed** — RTL-SDR plugged + enumerating, `readsb`/`dump1090-fa` installed, `aircraft.json` served over HTTP. **Exit criteria:** `curl <adsbUrl>` returns live traffic with `hex`/`lat`/`lon`/`alt_*`/`gs`/`track`.
2. **Local LLM server** — `llama-server` (llama.cpp, CUDA) or vLLM, small instruct model. **Exit criteria:** `POST /v1/chat/completions` with `response_format:{type:"json_schema",…}` returns valid constrained JSON.
3. **Daemon home** — the daemon runs on the host (reaches the SDR + LLM over localhost, the rig over LAN).

---

## File Structure

**Phase A — daemon target source**
- `tb3-mcp/src/adsb/types.ts` — `Aircraft`, `EnrichedAircraft`, `AdsbSnapshot` interfaces.
- `tb3-mcp/src/adsb/parse.ts` — pure `parseAircraftJson(raw): Aircraft[]`.
- `tb3-mcp/src/adsb/convert.ts` — pure ADS-B-field → geo converters (`aircraftAltitudeM`, `aircraftGeodetic`, `aircraftVelocity`).
- `tb3-mcp/src/adsb/enrich.ts` — pure `enrichAircraft(...)` (rig-relative az/el/range + hard flags + `estTrackSec`).
- `tb3-mcp/src/adsb/source.ts` — `AdsbSource` poll loop.
- `tb3-mcp/src/adsb/follower.ts` — `AdsbFollower` (binds a hex → pushes fixes into a `TargetSink`).
- `tb3-mcp/src/adsb-tools.ts` — `scanAircraft`/`trackAircraftCore` pure cores + `registerAdsbTools`.
- **Modify** `tb3-mcp/src/config.ts` (config fields), `tb3-mcp/src/server.ts` (wiring), `tb3-mcp/config.example.json`, `tb3-mcp/README.md`.

**Phase B — host agent**
- `tb3-mcp/src/agent/llm.ts` — `chooseTarget(...)` constrained-JSON LLM call + `Decision` schema.
- `tb3-mcp/src/agent/decide.ts` — pure `decideAction(...)` / `failSafeAction(...)` guardrails.
- `tb3-mcp/src/agent/loop.ts` — pure `runOnce(...)` orchestration over a `RigMcpClient` seam.
- `tb3-mcp/src/agent/mcp-client.ts` — `RigMcpClient` impl wrapping the MCP SDK `Client`.
- `tb3-mcp/src/agent/agent.ts` — `main()` entrypoint.
- **Add** `tb3-mcp/deploy/tb3-agent.service`.

**Tests** (new): `test/adsb-parse.test.ts`, `test/adsb-convert.test.ts`, `test/adsb-enrich.test.ts`, `test/adsb-source.test.ts`, `test/adsb-follower.test.ts`, `test/adsb-tools.test.ts`, `test/agent-llm.test.ts`, `test/agent-decide.test.ts`, `test/agent-loop.test.ts`. **Modify:** `test/config.test.ts`.

Run all tests from `tb3-mcp/`: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"; npm test`. Single file: `npx vitest run test/<file>.ts`.

---

## PHASE A — Daemon target source

### Task 1: L4 config fields

**Files:**
- Modify: `tb3-mcp/src/config.ts` (add to `ConfigSchema`; add env wiring in `loadConfig`)
- Test: `tb3-mcp/test/config.test.ts`

**Interfaces:**
- Produces: new `Config` fields — `adsbEnabled:boolean`, `adsbUrl:string`, `adsbPollHz:number`, `adsbMaxRangeKm:number`, `adsbLostSec:number`, `adsbAltSource:"auto"|"geom"|"baro"`, `llmUrl:string`, `llmModel:string`, `agentTickSec:number`, `agentMinDwellSec:number`, `agentMcpUrl:string`.

- [ ] **Step 1: Write the failing test** — append to `tb3-mcp/test/config.test.ts`:

```typescript
describe("L4 config", () => {
  it("defaults ADS-B off with sane values", () => {
    const c = loadConfig(undefined, {});
    expect(c.adsbEnabled).toBe(false);
    expect(c.adsbPollHz).toBe(1);
    expect(c.adsbMaxRangeKm).toBe(100);
    expect(c.adsbLostSec).toBe(15);
    expect(c.adsbAltSource).toBe("auto");
    expect(c.agentTickSec).toBe(5);
    expect(c.agentMinDwellSec).toBe(25);
  });

  it("reads L4 env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_ADSB_ENABLED: "1",
      TB3_ADSB_URL: "http://10.0.0.9/data/aircraft.json",
      TB3_ADSB_POLL_HZ: "2",
      TB3_ADSB_ALT_SOURCE: "geom",
      TB3_LLM_URL: "http://127.0.0.1:8000/v1/chat/completions",
      TB3_AGENT_MIN_DWELL_SEC: "40",
    });
    expect(c.adsbEnabled).toBe(true);
    expect(c.adsbUrl).toBe("http://10.0.0.9/data/aircraft.json");
    expect(c.adsbPollHz).toBe(2);
    expect(c.adsbAltSource).toBe("geom");
    expect(c.llmUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(c.agentMinDwellSec).toBe(40);
  });

  it("rejects an invalid alt source", () => {
    expect(() => loadConfig(undefined, { TB3_ADSB_ALT_SOURCE: "gps" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/config.test.ts`
Expected: FAIL (`adsbEnabled` etc. undefined; alt-source test does not throw).

- [ ] **Step 3: Add the fields.** In `tb3-mcp/src/config.ts`, add to the `ConfigSchema` object (after `sunGuardTickHz`, before the closing `})` and `.refine`s):

```typescript
    // --- Layer 4: ADS-B target source ---
    adsbEnabled: z.boolean().default(false),
    adsbUrl: z.string().min(1).default("http://127.0.0.1/data/aircraft.json"),
    adsbPollHz: z.number().positive().max(10).default(1),
    adsbMaxRangeKm: z.number().positive().default(100),
    adsbLostSec: z.number().positive().default(15),
    adsbAltSource: z.enum(["auto", "geom", "baro"]).default("auto"),
    // --- Layer 4: host agent + local LLM ---
    llmUrl: z.string().min(1).default("http://127.0.0.1:8000/v1/chat/completions"),
    llmModel: z.string().min(1).default("qwen2.5-14b-instruct"),
    agentTickSec: z.number().positive().max(600).default(5),
    agentMinDwellSec: z.number().nonnegative().max(3600).default(25),
    agentMcpUrl: z.string().min(1).default("http://127.0.0.1:8770/mcp"),
```

In `loadConfig`, add after the existing `set("sunGuardTickHz", …)` line:

```typescript
  set("adsbEnabled", bool(env.TB3_ADSB_ENABLED));
  set("adsbUrl", env.TB3_ADSB_URL);
  set("adsbPollHz", num(env.TB3_ADSB_POLL_HZ));
  set("adsbMaxRangeKm", num(env.TB3_ADSB_MAX_RANGE_KM));
  set("adsbLostSec", num(env.TB3_ADSB_LOST_SEC));
  set("adsbAltSource", env.TB3_ADSB_ALT_SOURCE);
  set("llmUrl", env.TB3_LLM_URL);
  set("llmModel", env.TB3_LLM_MODEL);
  set("agentTickSec", num(env.TB3_AGENT_TICK_SEC));
  set("agentMinDwellSec", num(env.TB3_AGENT_MIN_DWELL_SEC));
  set("agentMcpUrl", env.TB3_AGENT_MCP_URL);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/config.ts tb3-mcp/test/config.test.ts
git commit -m "feat(l4): config fields for ADS-B source + host agent"
```

---

### Task 2: Aircraft types + `parseAircraftJson`

**Files:**
- Create: `tb3-mcp/src/adsb/types.ts`, `tb3-mcp/src/adsb/parse.ts`
- Test: `tb3-mcp/test/adsb-parse.test.ts`

**Interfaces:**
- Produces:
  - `interface Aircraft { hex:string; callsign:string|null; lat:number|null; lon:number|null; altBaroFt:number|null; altGeomFt:number|null; gsKt:number|null; trackDeg:number|null; baroRateFpm:number|null; geomRateFpm:number|null; category:string|null; squawk:string|null; seenPosSec:number|null; rssi:number|null }`
  - `interface EnrichedAircraft extends Aircraft { azimuthDeg:number; elevationDeg:number; rangeM:number; reachable:boolean; sunSafe:boolean; slewOk:boolean; requiredSlewDps:number; estTrackSec:number }`
  - `interface AdsbSnapshot { aircraft:Aircraft[]; fetchedAtMs:number; ok:boolean; error?:string }`
  - `parseAircraftJson(raw: unknown): Aircraft[]` — drops entries with no `hex` or no `lat`/`lon`; lowercases hex; trims callsign; non-finite/absent numerics → null (so `alt_baro:"ground"` → `altBaroFt:null`).

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-parse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAircraftJson } from "../src/adsb/parse.js";

// A dump1090-fa / readsb aircraft.json shape (trimmed to fields we use).
const SAMPLE = {
  now: 1_700_000_000,
  aircraft: [
    { hex: "A1B2C3", flight: "UAL123  ", lat: 37.62, lon: -122.38, alt_baro: 30000,
      alt_geom: 30500, gs: 420, track: 95, baro_rate: -64, category: "A3",
      squawk: "1200", seen_pos: 0.3, rssi: -12.1 },
    { hex: "DEAD01", flight: "", alt_baro: "ground", gs: 0 },          // no lat/lon -> dropped
    { flight: "NOHEX", lat: 1, lon: 2 },                                // no hex -> dropped
    { hex: "BEEF99", lat: 51.0, lon: -0.1, alt_baro: "ground" },        // altBaroFt -> null, kept
  ],
};

describe("parseAircraftJson", () => {
  it("normalizes fields and lowercases hex", () => {
    const out = parseAircraftJson(SAMPLE);
    const a = out.find((x) => x.hex === "a1b2c3");
    expect(a).toBeDefined();
    expect(a!.callsign).toBe("UAL123");           // trimmed
    expect(a!.altBaroFt).toBe(30000);
    expect(a!.altGeomFt).toBe(30500);
    expect(a!.gsKt).toBe(420);
    expect(a!.trackDeg).toBe(95);
    expect(a!.baroRateFpm).toBe(-64);
    expect(a!.category).toBe("A3");
    expect(a!.squawk).toBe("1200");
  });

  it("drops aircraft with no hex or no position", () => {
    const out = parseAircraftJson(SAMPLE);
    expect(out.map((x) => x.hex).sort()).toEqual(["a1b2c3", "beef99"]);
  });

  it("maps non-numeric altitude to null but keeps the aircraft", () => {
    const beef = parseAircraftJson(SAMPLE).find((x) => x.hex === "beef99")!;
    expect(beef.altBaroFt).toBeNull();
    expect(beef.altGeomFt).toBeNull();
  });

  it("is defensive against garbage input", () => {
    expect(parseAircraftJson(null)).toEqual([]);
    expect(parseAircraftJson({})).toEqual([]);
    expect(parseAircraftJson({ aircraft: "nope" })).toEqual([]);
    expect(parseAircraftJson({ aircraft: [null, 42, "x"] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-parse.test.ts`
Expected: FAIL (`Cannot find module '../src/adsb/parse.js'`).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb/types.ts`:

```typescript
export interface Aircraft {
  hex: string;
  callsign: string | null;
  lat: number | null;
  lon: number | null;
  altBaroFt: number | null;
  altGeomFt: number | null;
  gsKt: number | null;
  trackDeg: number | null;
  baroRateFpm: number | null;
  geomRateFpm: number | null;
  category: string | null;
  squawk: string | null;
  seenPosSec: number | null;
  rssi: number | null;
}

export interface EnrichedAircraft extends Aircraft {
  azimuthDeg: number;
  elevationDeg: number;
  rangeM: number;
  reachable: boolean;
  sunSafe: boolean;
  slewOk: boolean;
  requiredSlewDps: number;
  estTrackSec: number;
}

export interface AdsbSnapshot {
  aircraft: Aircraft[];
  fetchedAtMs: number;
  ok: boolean;
  error?: string;
}
```

Create `tb3-mcp/src/adsb/parse.ts`:

```typescript
import { Aircraft } from "./types.js";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

// Normalize a dump1090-fa / readsb aircraft.json body into our Aircraft shape.
// Aircraft with no hex or no position are dropped (they cannot be pointed at).
export function parseAircraftJson(raw: unknown): Aircraft[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { aircraft?: unknown }).aircraft;
  if (!Array.isArray(list)) return [];
  const out: Aircraft[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const hex = strOrNull(r.hex);
    if (hex === null) continue;
    const lat = numOrNull(r.lat);
    const lon = numOrNull(r.lon);
    if (lat === null || lon === null) continue;
    out.push({
      hex: hex.toLowerCase(),
      callsign: strOrNull(r.flight),
      lat, lon,
      altBaroFt: numOrNull(r.alt_baro),   // "ground" (string) → null
      altGeomFt: numOrNull(r.alt_geom),
      gsKt: numOrNull(r.gs),
      trackDeg: numOrNull(r.track),
      baroRateFpm: numOrNull(r.baro_rate),
      geomRateFpm: numOrNull(r.geom_rate),
      category: strOrNull(r.category),
      squawk: strOrNull(r.squawk),
      seenPosSec: numOrNull(r.seen_pos),
      rssi: numOrNull(r.rssi),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb/types.ts tb3-mcp/src/adsb/parse.ts tb3-mcp/test/adsb-parse.test.ts
git commit -m "feat(l4): Aircraft types + parseAircraftJson"
```

---

### Task 3: ADS-B field converters

**Files:**
- Create: `tb3-mcp/src/adsb/convert.ts`
- Test: `tb3-mcp/test/adsb-convert.test.ts`

**Interfaces:**
- Consumes: `Aircraft` (Task 2); `Geodetic` (`geo/wgs84.js`); `Vec3` (`geo/vec3.js`); `velocityFromSpeedHeading(speedMps, headingDeg, climbMps): Vec3` (`track/estimator.js`).
- Produces:
  - `type AltSource = "auto"|"geom"|"baro"`
  - `aircraftAltitudeM(ac: Aircraft, altSource: AltSource): number | null`
  - `aircraftGeodetic(ac: Aircraft, altSource: AltSource): Geodetic | null`
  - `aircraftVelocity(ac: Aircraft): Vec3 | null` (null when `gsKt` or `trackDeg` is null)

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-convert.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { aircraftAltitudeM, aircraftGeodetic, aircraftVelocity } from "../src/adsb/convert.js";
import { Aircraft } from "../src/adsb/types.js";

function ac(p: Partial<Aircraft>): Aircraft {
  return {
    hex: "abc123", callsign: null, lat: 37, lon: -122,
    altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
    baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: null, rssi: null, ...p,
  };
}

describe("aircraftAltitudeM", () => {
  it("auto prefers geom over baro, feet→meters", () => {
    expect(aircraftAltitudeM(ac({ altGeomFt: 10000, altBaroFt: 9800 }), "auto")).toBeCloseTo(3048, 0);
    expect(aircraftAltitudeM(ac({ altGeomFt: null, altBaroFt: 9800 }), "auto")).toBeCloseTo(2987.04, 1);
  });
  it("respects explicit source and returns null when absent", () => {
    expect(aircraftAltitudeM(ac({ altGeomFt: 10000, altBaroFt: 9800 }), "baro")).toBeCloseTo(2987.04, 1);
    expect(aircraftAltitudeM(ac({ altGeomFt: null }), "geom")).toBeNull();
  });
});

describe("aircraftGeodetic", () => {
  it("builds a Geodetic in meters", () => {
    const g = aircraftGeodetic(ac({ lat: 37.5, lon: -122.1, altGeomFt: 10000 }), "auto");
    expect(g).not.toBeNull();
    expect(g!.lat).toBe(37.5);
    expect(g!.height).toBeCloseTo(3048, 0);
  });
  it("is null with no usable altitude", () => {
    expect(aircraftGeodetic(ac({ altBaroFt: null, altGeomFt: null }), "auto")).toBeNull();
  });
});

describe("aircraftVelocity", () => {
  it("converts kt+track+fpm into an ENU velocity (m/s)", () => {
    // Due east (track 90), 100 kt = 51.4444 m/s, climbing 600 fpm = 3.048 m/s.
    const v = aircraftVelocity(ac({ gsKt: 100, trackDeg: 90, geomRateFpm: 600 }))!;
    expect(v[0]).toBeCloseTo(51.4444, 3);  // east
    expect(v[1]).toBeCloseTo(0, 6);        // north
    expect(v[2]).toBeCloseTo(3.048, 3);    // up
  });
  it("falls back baro_rate→geom_rate and defaults climb to 0", () => {
    const v = aircraftVelocity(ac({ gsKt: 100, trackDeg: 0, baroRateFpm: -600, geomRateFpm: null }))!;
    expect(v[1]).toBeCloseTo(51.4444, 3);  // north
    expect(v[2]).toBeCloseTo(-3.048, 3);
    const v2 = aircraftVelocity(ac({ gsKt: 100, trackDeg: 0 }))!;
    expect(v2[2]).toBe(0);
  });
  it("is null without ground speed or track", () => {
    expect(aircraftVelocity(ac({ gsKt: null, trackDeg: 90 }))).toBeNull();
    expect(aircraftVelocity(ac({ gsKt: 100, trackDeg: null }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-convert.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb/convert.ts`:

```typescript
import { Aircraft } from "./types.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";
import { velocityFromSpeedHeading } from "../track/estimator.js";

const FT_TO_M = 0.3048;
const KT_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.3048 / 60;   // ft/min → m/s

export type AltSource = "auto" | "geom" | "baro";

// Aircraft altitude in meters using the configured source. `auto` prefers the
// GPS/geometric (WGS84 ellipsoidal) altitude, which matches the rig's height
// datum; barometric is a pressure altitude and can differ by hundreds of feet.
export function aircraftAltitudeM(ac: Aircraft, altSource: AltSource): number | null {
  let ft: number | null;
  if (altSource === "geom") ft = ac.altGeomFt;
  else if (altSource === "baro") ft = ac.altBaroFt;
  else ft = ac.altGeomFt ?? ac.altBaroFt;   // auto
  return ft === null ? null : ft * FT_TO_M;
}

export function aircraftGeodetic(ac: Aircraft, altSource: AltSource): Geodetic | null {
  if (ac.lat === null || ac.lon === null) return null;
  const height = aircraftAltitudeM(ac, altSource);
  if (height === null) return null;
  return { lat: ac.lat, lon: ac.lon, height };
}

// ENU velocity from aviation fields. Null when speed or track is missing (an
// unusable velocity — the estimator will derive one from successive fixes).
export function aircraftVelocity(ac: Aircraft): Vec3 | null {
  if (ac.gsKt === null || ac.trackDeg === null) return null;
  const climbFpm = ac.geomRateFpm ?? ac.baroRateFpm ?? 0;
  return velocityFromSpeedHeading(ac.gsKt * KT_TO_MPS, ac.trackDeg, climbFpm * FPM_TO_MPS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-convert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb/convert.ts tb3-mcp/test/adsb-convert.test.ts
git commit -m "feat(l4): ADS-B altitude/geodetic/velocity converters"
```

---

### Task 4: `enrichAircraft`

**Files:**
- Create: `tb3-mcp/src/adsb/enrich.ts`
- Test: `tb3-mcp/test/adsb-enrich.test.ts`

**Interfaces:**
- Consumes: `Aircraft`/`EnrichedAircraft` (Task 2); `aircraftGeodetic`/`aircraftVelocity` (Task 3); `enuDirection`/`enuPosition`/`Geodetic` (`geo/wgs84.js`); `enuToPanTilt` (`geo/orientation.js`); `reachablePanTilt` (`geo-tools.js`); `sunEnu` (`geo/sun.js`); `angleBetweenDeg`/`Mat3`/`Vec3`/`sub`/`scale`/`dot`/`norm`/`add`/`normalize` (`geo/vec3.js`); `Config` (`config.js`).
- Produces: `enrichAircraft(ac: Aircraft, rig: Geodetic, R: Mat3, cfg: Config, nowMs: number): EnrichedAircraft | null` (null when the aircraft has no usable altitude → no geodetic).

Notes for the implementer: with an **identity `R`**, `enuToPanTilt` maps az→pan and el→tilt, so pan≈azimuth and tilt≈elevation — the tests rely on this (same convention as `test/supervisor.test.ts`'s `calibratedStore`). `requiredSlewDps` is the line-of-sight angular rate = |v⊥|/range (velocity minus its radial component, over range). `estTrackSec` steps the ENU position forward by `velocity` in 2 s increments up to 120 s and returns the time until it first stops being trackable.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-enrich.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { enrichAircraft } from "../src/adsb/enrich.js";
import { Aircraft } from "../src/adsb/types.js";
import { loadConfig } from "../src/config.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Mat3 } from "../src/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG: Geodetic = { lat: 0, lon: 0, height: 0 };
// Night so the sun is below the horizon and never trips sunSafe in geometry tests.
const NIGHT_MS = Date.UTC(2026, 0, 1, 0, 0, 0);     // ~midnight UTC at lon 0
const cfg = loadConfig(undefined, {});

function ac(p: Partial<Aircraft>): Aircraft {
  return {
    hex: "abc123", callsign: null, lat: null, lon: null,
    altBaroFt: null, altGeomFt: null, gsKt: null, trackDeg: null,
    baroRateFpm: null, geomRateFpm: null, category: null, squawk: null,
    seenPosSec: null, rssi: null, ...p,
  };
}

describe("enrichAircraft geometry", () => {
  it("computes azimuth/elevation/range for a point due north and up", () => {
    // ~1.11 km north (0.01° lat) at 1000 m altitude.
    const e = enrichAircraft(ac({ lat: 0.01, lon: 0, altGeomFt: 3280.84 }), RIG, I, cfg, NIGHT_MS)!;
    expect(e.azimuthDeg).toBeCloseTo(0, 1);
    expect(e.rangeM).toBeCloseTo(1490, -1);         // sqrt(1113^2 + 1000^2) ≈ 1497 (order check)
    expect(e.elevationDeg).toBeGreaterThan(30);
    expect(e.reachable).toBe(true);                 // default limits are full sphere
  });

  it("returns null with no usable altitude", () => {
    expect(enrichAircraft(ac({ lat: 0.01, lon: 0 }), RIG, I, cfg, NIGHT_MS)).toBeNull();
  });

  it("marks below-tilt-limit targets unreachable", () => {
    // Restrict tilt to >= 10°; a low, distant target sits below that.
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "10" });
    const e = enrichAircraft(ac({ lat: 1.0, lon: 0, altGeomFt: 3280 }), RIG, I, c2, NIGHT_MS)!;
    expect(e.elevationDeg).toBeLessThan(10);
    expect(e.reachable).toBe(false);
  });
});

describe("enrichAircraft slew rate", () => {
  it("crossing traffic close in needs a high slew rate; distant is slow", () => {
    // 2 km due north, flying due east at 200 m/s (~389 kt) → LoS rate ≈ 5.7°/s.
    const near = enrichAircraft(
      ac({ lat: 0.018, lon: 0, altGeomFt: 0, gsKt: 200 / 0.514444, trackDeg: 90 }), RIG, I, cfg, NIGHT_MS)!;
    expect(near.requiredSlewDps).toBeGreaterThan(3);
    // 100 km north, same speed → LoS rate ≈ 0.11°/s.
    const far = enrichAircraft(
      ac({ lat: 0.9, lon: 0, altGeomFt: 0, gsKt: 200 / 0.514444, trackDeg: 90 }), RIG, I, cfg, NIGHT_MS)!;
    expect(far.requiredSlewDps).toBeLessThan(1);
    expect(far.slewOk).toBe(true);
  });
});

describe("enrichAircraft sun-safe", () => {
  it("flags an aircraft sitting on the sun as unsafe", () => {
    // Daytime; put the aircraft along the sun's own ENU direction by using a high
    // sun elevation moment. We assert the flag is boolean and consistent with the cone.
    const e = enrichAircraft(ac({ lat: 0.5, lon: 0, altGeomFt: 30000 }), RIG, I, cfg, Date.UTC(2026, 0, 1, 12, 0, 0))!;
    expect(typeof e.sunSafe).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-enrich.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb/enrich.ts`:

```typescript
import { Aircraft, EnrichedAircraft } from "./types.js";
import { Geodetic, enuPosition } from "../geo/wgs84.js";
import { Mat3, Vec3, angleBetweenDeg, add, sub, scale, dot, norm, normalize } from "../geo/vec3.js";
import { enuToPanTilt } from "../geo/orientation.js";
import { reachablePanTilt } from "../geo-tools.js";
import { sunEnu } from "../geo/sun.js";
import { Config } from "../config.js";
import { aircraftGeodetic, aircraftVelocity } from "./convert.js";

const RAD2DEG = 180 / Math.PI;
const EST_STEP_SEC = 2;
const EST_CAP_SEC = 120;

function azElOfUnit(unit: Vec3): { azimuthDeg: number; elevationDeg: number } {
  let azimuthDeg = Math.atan2(unit[0], unit[1]) * RAD2DEG;
  if (azimuthDeg < 0) azimuthDeg += 360;
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, unit[2]))) * RAD2DEG;
  return { azimuthDeg, elevationDeg };
}

function isTrackableAt(
  enu: Vec3, R: Mat3, cfg: Config, sEnu: Vec3,
): boolean {
  const range = norm(enu);
  if (range < 1) return false;
  const unit = normalize(enu);
  const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
  const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
  if ("error" in reach) return false;
  return angleBetweenDeg(unit, sEnu) >= cfg.sunConeDeg;
}

// Seconds the aircraft stays trackable (reachable ∧ sun-safe) from now, stepping
// ENU position forward at constant velocity. Sun motion over ≤120 s is negligible,
// so a single sun vector is used. Returns 0 if not trackable now.
function estimateTrackSec(enu0: Vec3, vel: Vec3 | null, R: Mat3, cfg: Config, sEnu: Vec3, slewOkNow: boolean): number {
  if (!isTrackableAt(enu0, R, cfg, sEnu) || !slewOkNow) return 0;
  if (!vel) return EST_CAP_SEC;   // stationary/unknown: assume it stays put
  for (let t = EST_STEP_SEC; t <= EST_CAP_SEC; t += EST_STEP_SEC) {
    if (!isTrackableAt(add(enu0, scale(vel, t)), R, cfg, sEnu)) return t - EST_STEP_SEC;
  }
  return EST_CAP_SEC;
}

export function enrichAircraft(
  ac: Aircraft, rig: Geodetic, R: Mat3, cfg: Config, nowMs: number,
): EnrichedAircraft | null {
  const g = aircraftGeodetic(ac, cfg.adsbAltSource);
  if (!g) return null;

  const enu = enuPosition(rig, g);
  const range = norm(enu);
  const unit = range > 0 ? normalize(enu) : ([0, 0, 1] as Vec3);
  const { azimuthDeg, elevationDeg } = azElOfUnit(unit);

  const { panDeg, tiltDeg } = enuToPanTilt(R, unit);
  const reach = reachablePanTilt(panDeg, tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
  const reachable = !("error" in reach);

  const sEnu = sunEnu(rig, nowMs);
  const sunSafe = angleBetweenDeg(unit, sEnu) >= cfg.sunConeDeg;

  const vel = aircraftVelocity(ac);
  let requiredSlewDps = 0;
  if (vel && range > 1) {
    const radial = scale(unit, dot(vel, unit));   // component along the line of sight
    const perp = sub(vel, radial);
    requiredSlewDps = (norm(perp) / range) * RAD2DEG;
  }
  const slewOk = requiredSlewDps <= cfg.maxJogDps;

  const estTrackSec = estimateTrackSec(enu, vel, R, cfg, sEnu, slewOk);

  return {
    ...ac,
    azimuthDeg, elevationDeg, rangeM: range,
    reachable, sunSafe, slewOk, requiredSlewDps, estTrackSec,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-enrich.test.ts`
Expected: PASS. (If the `rangeM` order-of-magnitude assertion is brittle, keep only the `toBeGreaterThan`/`toBeLessThan` bounds; do NOT loosen the reachable/slew assertions.)

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb/enrich.ts tb3-mcp/test/adsb-enrich.test.ts
git commit -m "feat(l4): enrichAircraft — rig-relative az/el/range + trackable flags"
```

---

### Task 5: `AdsbSource`

**Files:**
- Create: `tb3-mcp/src/adsb/source.ts`
- Test: `tb3-mcp/test/adsb-source.test.ts`

**Interfaces:**
- Consumes: `parseAircraftJson` (Task 2); `AdsbSnapshot` (Task 2); `Config` (`config.js`); `Scheduler`/`realScheduler` (`track/session.js`).
- Produces:
  - `interface AdsbSourceOpts { scheduler?: Scheduler; now?: () => number; fetchFn?: typeof fetch; onSnapshot?: (s: AdsbSnapshot) => void }`
  - `class AdsbSource { constructor(cfg: Config, opts?: AdsbSourceOpts); start(): void; stop(): void; getSnapshot(): AdsbSnapshot; pollOnceForTest(): Promise<void> }`
  - Poll cadence `Math.max(100, round(1000/adsbPollHz))`; a failed/throwing fetch yields `{ aircraft:[], fetchedAtMs, ok:false, error }` (never throws into the loop) and still fires `onSnapshot`.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-source.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AdsbSource } from "../src/adsb/source.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot } from "../src/adsb/types.js";

const cfg = loadConfig(undefined, { TB3_ADSB_URL: "http://x/aircraft.json" });

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("AdsbSource", () => {
  it("starts empty and populates after a poll", async () => {
    const src = new AdsbSource(cfg, {
      now: () => 1000,
      fetchFn: fakeFetch({ aircraft: [{ hex: "abc", lat: 1, lon: 2, alt_geom: 10000 }] }),
    });
    expect(src.getSnapshot().aircraft).toEqual([]);
    await src.pollOnceForTest();
    const s = src.getSnapshot();
    expect(s.ok).toBe(true);
    expect(s.aircraft.map((a) => a.hex)).toEqual(["abc"]);
    expect(s.fetchedAtMs).toBe(1000);
  });

  it("degrades to ok:false on fetch failure without throwing", async () => {
    const src = new AdsbSource(cfg, {
      now: () => 5,
      fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    await src.pollOnceForTest();
    const s = src.getSnapshot();
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/ECONNREFUSED/);
    expect(s.aircraft).toEqual([]);
  });

  it("fires onSnapshot each poll and runs on the scheduler tick", async () => {
    let fn: (() => void) | null = null;
    const sched = { every: (_ms: number, f: () => void) => { fn = f; return { cancel() { fn = null; } }; } };
    const seen: AdsbSnapshot[] = [];
    const src = new AdsbSource(cfg, {
      scheduler: sched, now: () => 7,
      fetchFn: fakeFetch({ aircraft: [{ hex: "z9", lat: 0, lon: 0, alt_geom: 100 }] }),
      onSnapshot: (s) => seen.push(s),
    });
    src.start();
    fn!();                                  // fire one scheduled tick
    await new Promise((r) => setTimeout(r, 0));  // let the async poll settle
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1].aircraft[0].hex).toBe("z9");
    src.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-source.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb/source.ts`:

```typescript
import { Config } from "../config.js";
import { Scheduler, realScheduler } from "../track/session.js";
import { AdsbSnapshot } from "./types.js";
import { parseAircraftJson } from "./parse.js";

const FETCH_TIMEOUT_MS = 4000;

export interface AdsbSourceOpts {
  scheduler?: Scheduler;
  now?: () => number;
  fetchFn?: typeof fetch;
  onSnapshot?: (s: AdsbSnapshot) => void;
}

export class AdsbSource {
  private snapshot: AdsbSnapshot;
  private timer: { cancel(): void } | null = null;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly onSnapshot?: (s: AdsbSnapshot) => void;

  constructor(private readonly cfg: Config, opts: AdsbSourceOpts = {}) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.onSnapshot = opts.onSnapshot;
    this.snapshot = { aircraft: [], fetchedAtMs: 0, ok: false };
  }

  start(): void {
    if (this.timer) return;
    const ms = Math.max(100, Math.round(1000 / this.cfg.adsbPollHz));
    this.timer = this.scheduler.every(ms, () => { void this.poll(); });
  }
  stop(): void { this.timer?.cancel(); this.timer = null; }

  getSnapshot(): AdsbSnapshot { return this.snapshot; }

  /** Test seam: run exactly one poll and await it. */
  pollOnceForTest(): Promise<void> { return this.poll(); }

  private async poll(): Promise<void> {
    try {
      const r = await this.fetchFn(this.cfg.adsbUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      this.snapshot = { aircraft: parseAircraftJson(body), fetchedAtMs: this.now(), ok: true };
    } catch (e) {
      this.snapshot = {
        aircraft: [], fetchedAtMs: this.now(), ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    this.onSnapshot?.(this.snapshot);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb/source.ts tb3-mcp/test/adsb-source.test.ts
git commit -m "feat(l4): AdsbSource poll loop over aircraft.json"
```

---

### Task 6: `AdsbFollower`

**Files:**
- Create: `tb3-mcp/src/adsb/follower.ts`
- Test: `tb3-mcp/test/adsb-follower.test.ts`

**Interfaces:**
- Consumes: `Aircraft` (Task 2); `AltSource`/`aircraftGeodetic`/`aircraftVelocity` (Task 3); `Geodetic` (`geo/wgs84.js`); `Vec3` (`geo/vec3.js`).
- Produces:
  - `interface TargetSink { start(g: Geodetic, statedVel: Vec3|null, label: string|null): string|null; updateTarget(g: Geodetic, statedVel: Vec3|null): string|null; isActive(): boolean }` — `TrackingSession` satisfies this.
  - `interface FollowerStatus { hex: string|null; lostMs: number|null }`
  - `class AdsbFollower { constructor(sink: TargetSink, altSource: AltSource, lostMsThreshold: number, now?: () => number); bind(hex: string): void; unbind(): void; status(): FollowerStatus; onSnapshot(snap: { aircraft: Aircraft[] }): void }`

Behavior: first snapshot after `bind` calls `sink.start` (fresh estimator), later snapshots call `sink.updateTarget`. Each `bind` resets to first-fix (so a target switch = a fresh `start`). If the bound hex is absent longer than `lostMsThreshold`, or the session goes inactive after the first fix (stopped elsewhere), it `unbind`s.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-follower.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AdsbFollower, type TargetSink } from "../src/adsb/follower.js";
import { Aircraft } from "../src/adsb/types.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Vec3 } from "../src/geo/vec3.js";

function ac(hex: string, p: Partial<Aircraft> = {}): Aircraft {
  return {
    hex, callsign: null, lat: 37, lon: -122, altBaroFt: null, altGeomFt: 10000,
    gsKt: 200, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null,
    squawk: null, seenPosSec: 0, rssi: null, ...p,
  };
}
function fakeSink() {
  const calls: { kind: "start" | "update"; g: Geodetic; vel: Vec3 | null; label?: string | null }[] = [];
  let active = false;
  const sink: TargetSink = {
    start(g, vel, label) { active = true; calls.push({ kind: "start", g, vel, label }); return null; },
    updateTarget(g, vel) { calls.push({ kind: "update", g, vel }); return null; },
    isActive() { return active; },
  };
  return { sink, calls, setActive: (v: boolean) => { active = v; } };
}

describe("AdsbFollower", () => {
  it("starts on first fix then updates on later fixes", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("A1B2C3");
    f.onSnapshot({ aircraft: [ac("a1b2c3")] });   // hex compare is case-insensitive
    f.onSnapshot({ aircraft: [ac("a1b2c3", { lat: 37.1 })] });
    expect(calls.map((c) => c.kind)).toEqual(["start", "update"]);
    expect(calls[0].vel).not.toBeNull();          // gs+track → velocity present
    expect(f.status().hex).toBe("a1b2c3");
  });

  it("re-starts (fresh estimator) when switching to a new hex", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("aaa111"); f.onSnapshot({ aircraft: [ac("aaa111")] });
    f.bind("bbb222"); f.onSnapshot({ aircraft: [ac("bbb222")] });
    expect(calls.map((c) => c.kind)).toEqual(["start", "start"]);
  });

  it("unbinds after the lost threshold when the hex disappears", () => {
    const { sink } = fakeSink();
    let t = 1000;
    const f = new AdsbFollower(sink, "auto", 5000, () => t);
    f.bind("c0ffee"); f.onSnapshot({ aircraft: [ac("c0ffee")] });
    t = 4000; f.onSnapshot({ aircraft: [] });         // gone 3s — still bound
    expect(f.status().hex).toBe("c0ffee");
    t = 7000; f.onSnapshot({ aircraft: [] });         // gone 6s > 5s — released
    expect(f.status().hex).toBeNull();
  });

  it("self-heals: unbinds when the session was stopped elsewhere", () => {
    const { sink, setActive } = fakeSink();
    const f = new AdsbFollower(sink, "auto", 15000, () => 1000);
    f.bind("d00d00"); f.onSnapshot({ aircraft: [ac("d00d00")] });  // start → active
    setActive(false);                                              // stop_tracking elsewhere
    f.onSnapshot({ aircraft: [ac("d00d00")] });
    expect(f.status().hex).toBeNull();
  });

  it("skips a fix with no usable altitude but stays bound", () => {
    const { sink, calls } = fakeSink();
    const f = new AdsbFollower(sink, "geom", 15000, () => 1000);
    f.bind("e1e1e1");
    f.onSnapshot({ aircraft: [ac("e1e1e1", { altGeomFt: null })] });  // geom missing under "geom"
    expect(calls.length).toBe(0);
    expect(f.status().hex).toBe("e1e1e1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-follower.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb/follower.ts`:

```typescript
import { Aircraft } from "./types.js";
import { AltSource, aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";

export interface TargetSink {
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null): string | null;
  updateTarget(g: Geodetic, statedVel: Vec3 | null): string | null;
  isActive(): boolean;
}

export interface FollowerStatus { hex: string | null; lostMs: number | null; }

export class AdsbFollower {
  private hex: string | null = null;
  private firstFix = true;
  private lastSeenMs = 0;

  constructor(
    private readonly sink: TargetSink,
    private readonly altSource: AltSource,
    private readonly lostMsThreshold: number,
    private readonly now: () => number = Date.now,
  ) {}

  bind(hex: string): void {
    this.hex = hex.toLowerCase();
    this.firstFix = true;
    this.lastSeenMs = this.now();   // start the lost clock from bind
  }
  unbind(): void { this.hex = null; this.firstFix = true; this.lastSeenMs = 0; }

  status(): FollowerStatus {
    return { hex: this.hex, lostMs: this.hex === null ? null : this.now() - this.lastSeenMs };
  }

  onSnapshot(snap: { aircraft: Aircraft[] }): void {
    if (this.hex === null) return;
    // Self-heal: after acquisition, if tracking was stopped elsewhere, release.
    if (!this.firstFix && !this.sink.isActive()) { this.unbind(); return; }

    const ac = snap.aircraft.find((a) => a.hex.toLowerCase() === this.hex);
    if (!ac) {
      if (this.now() - this.lastSeenMs > this.lostMsThreshold) this.unbind();
      return;
    }
    const g = aircraftGeodetic(ac, this.altSource);
    if (!g) return;   // no usable altitude this frame; stay bound
    const vel = aircraftVelocity(ac);
    if (this.firstFix) {
      this.sink.start(g, vel, ac.callsign ?? ac.hex);
      this.firstFix = false;
    } else {
      this.sink.updateTarget(g, vel);
    }
    this.lastSeenMs = this.now();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-follower.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb/follower.ts tb3-mcp/test/adsb-follower.test.ts
git commit -m "feat(l4): AdsbFollower — bind a hex, push fixes into the tracking session"
```

---

### Task 7: `scan_aircraft` / `track_aircraft` / `get_tracked_aircraft`

**Files:**
- Create: `tb3-mcp/src/adsb-tools.ts`
- Test: `tb3-mcp/test/adsb-tools.test.ts`

**Interfaces:**
- Consumes: `AdsbSource` (Task 5); `AdsbFollower`/`FollowerStatus` (Task 6); `enrichAircraft` (Task 4); `EnrichedAircraft`/`AdsbSnapshot` (Task 2); `CalibrationStore` (`calibration.js`); `Config`/`Geodetic`/`Mat3`; `TrackingSession` (`track/session.js`); `SunSupervisor` (`track/supervisor.js`); `McpServer`; `z`; `text`/`errText`/`SUN_LOCKED_MSG` (`tool-helpers.js`).
- Produces (pure cores + a registrar):
  - `interface ScanParams { maxRangeKm: number; onlyTrackable: boolean; limit: number }`
  - `isTrackable(e: EnrichedAircraft): boolean` → `e.reachable && e.sunSafe && e.slewOk`
  - `scanAircraft(snap: AdsbSnapshot, rig: Geodetic|null, R: Mat3|null, cfg: Config, nowMs: number, p: ScanParams): { error: string } | { aircraft: EnrichedAircraft[] }`
  - `registerAdsbTools(server: McpServer, source: AdsbSource, follower: AdsbFollower, store: CalibrationStore, cfg: Config, session: TrackingSession, supervisor: SunSupervisor): void`

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-tools.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scanAircraft, isTrackable, type ScanParams } from "../src/adsb-tools.js";
import { loadConfig } from "../src/config.js";
import type { AdsbSnapshot } from "../src/adsb/types.js";
import { Geodetic } from "../src/geo/wgs84.js";
import { Mat3 } from "../src/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG: Geodetic = { lat: 0, lon: 0, height: 0 };
const NIGHT = Date.UTC(2026, 0, 1, 0, 0, 0);
const cfg = loadConfig(undefined, {});
const P: ScanParams = { maxRangeKm: 100, onlyTrackable: true, limit: 20 };

function snap(aircraft: AdsbSnapshot["aircraft"]): AdsbSnapshot {
  return { aircraft, fetchedAtMs: 1000, ok: true };
}
function raw(hex: string, lat: number, altFt = 10000): AdsbSnapshot["aircraft"][number] {
  return {
    hex, callsign: null, lat, lon: 0, altBaroFt: null, altGeomFt: altFt,
    gsKt: 100, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null,
    squawk: null, seenPosSec: 0, rssi: null,
  };
}

describe("scanAircraft", () => {
  it("errors when not calibrated", () => {
    const r = scanAircraft(snap([]), null, null, cfg, NIGHT, P);
    expect("error" in r).toBe(true);
  });

  it("sorts by proximity and caps to the limit", () => {
    const r = scanAircraft(snap([raw("far", 0.5), raw("near", 0.05)]), RIG, I, cfg, NIGHT,
      { ...P, limit: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(1);
    expect(r.aircraft[0].hex).toBe("near");
  });

  it("filters out unreachable aircraft when only_trackable", () => {
    const c2 = loadConfig(undefined, { TB3_TILT_MIN: "80" });   // only near-zenith reachable
    const r = scanAircraft(snap([raw("low", 1.0, 3000)]), RIG, I, c2, NIGHT, P);
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
    const r2 = scanAircraft(snap([raw("low", 1.0, 3000)]), RIG, I, c2, NIGHT, { ...P, onlyTrackable: false });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.aircraft).toHaveLength(1);        // still returned when the filter is off
  });

  it("drops aircraft beyond max range", () => {
    const r = scanAircraft(snap([raw("near", 0.05)]), RIG, I, cfg, NIGHT, { ...P, maxRangeKm: 1 });
    if ("error" in r) throw new Error(r.error);
    expect(r.aircraft).toHaveLength(0);
  });
});

describe("isTrackable", () => {
  it("requires all three hard flags", () => {
    const base = { reachable: true, sunSafe: true, slewOk: true } as never;
    expect(isTrackable(base)).toBe(true);
    expect(isTrackable({ ...base, sunSafe: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adsb-tools.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/adsb-tools.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "./config.js";
import { CalibrationStore } from "./calibration.js";
import { Geodetic } from "./geo/wgs84.js";
import { Mat3 } from "./geo/vec3.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { enrichAircraft } from "./adsb/enrich.js";
import { AdsbSnapshot, EnrichedAircraft } from "./adsb/types.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

const NOT_CALIBRATED = "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";

export interface ScanParams { maxRangeKm: number; onlyTrackable: boolean; limit: number; }

export function isTrackable(e: EnrichedAircraft): boolean {
  return e.reachable && e.sunSafe && e.slewOk;
}

export function scanAircraft(
  snap: AdsbSnapshot, rig: Geodetic | null, R: Mat3 | null,
  cfg: Config, nowMs: number, p: ScanParams,
): { error: string } | { aircraft: EnrichedAircraft[] } {
  if (!rig || !R) return { error: NOT_CALIBRATED };
  const maxRangeM = p.maxRangeKm * 1000;
  const enriched = snap.aircraft
    .map((a) => enrichAircraft(a, rig, R, cfg, nowMs))
    .filter((e): e is EnrichedAircraft => e !== null)
    .filter((e) => e.rangeM <= maxRangeM)
    .filter((e) => !p.onlyTrackable || isTrackable(e))
    .sort((a, b) => a.rangeM - b.rangeM);
  return { aircraft: enriched.slice(0, p.limit) };
}

// Compact per-aircraft view for tool output and the LLM prompt.
function view(e: EnrichedAircraft) {
  return {
    hex: e.hex, callsign: e.callsign, category: e.category, squawk: e.squawk,
    altitude_m: null as number | null,   // filled below to keep field order stable
    ground_speed_kt: e.gsKt,
    azimuth_deg: Number(e.azimuthDeg.toFixed(1)),
    elevation_deg: Number(e.elevationDeg.toFixed(1)),
    range_km: Number((e.rangeM / 1000).toFixed(1)),
    required_slew_dps: Number(e.requiredSlewDps.toFixed(2)),
    est_track_sec: e.estTrackSec,
    reachable: e.reachable, sun_safe: e.sunSafe, slew_ok: e.slewOk,
  };
}

export function registerAdsbTools(
  server: McpServer, source: AdsbSource, follower: AdsbFollower,
  store: CalibrationStore, cfg: Config, session: TrackingSession, supervisor: SunSupervisor,
): void {
  const rigR = (): { rig: Geodetic | null; R: Mat3 | null } => {
    const p = store.get();
    return { rig: p.rig ?? null, R: store.getOrientation() };
  };

  server.registerTool(
    "scan_aircraft",
    {
      description:
        "List aircraft seen via ADS-B, enriched with rig-relative azimuth/elevation/range and the " +
        "objective trackable flags (reachable, sun_safe, slew_ok). Defaults to only the trackable ones, " +
        "sorted nearest-first. Interestingness is the caller's judgement.",
      inputSchema: {
        max_range_km: z.number().positive().optional().describe(`max slant range in km (default ${cfg.adsbMaxRangeKm})`),
        only_trackable: z.boolean().optional().describe("only aircraft that are reachable, sun-safe, and within slew rate (default true)"),
        limit: z.number().int().positive().max(100).optional().describe("max rows (default 20)"),
      },
    },
    async ({ max_range_km, only_trackable, limit }) => {
      const { rig, R } = rigR();
      const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(), {
        maxRangeKm: max_range_km ?? cfg.adsbMaxRangeKm,
        onlyTrackable: only_trackable ?? true,
        limit: limit ?? 20,
      });
      if ("error" in res) return errText(res.error);
      const rows = res.aircraft.map((e) => {
        const v = view(e);
        v.altitude_m = Math.round(
          // recompute the meters used for the fix so the row matches what track_aircraft would point at
          (e.altGeomFt ?? e.altBaroFt ?? 0) * 0.3048,
        );
        return v;
      });
      return text(JSON.stringify({ ok: source.getSnapshot().ok, count: rows.length, aircraft: rows }, null, 2));
    },
  );

  server.registerTool(
    "track_aircraft",
    {
      description: "Begin tracking a specific aircraft by ICAO hex. The hex must currently be trackable (see scan_aircraft).",
      inputSchema: { hex: z.string().min(1).describe("ICAO 24-bit hex, e.g. a1b2c3") },
    },
    async ({ hex }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      const { rig, R } = rigR();
      const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(),
        { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 });
      if ("error" in res) return errText(res.error);
      const wanted = hex.toLowerCase();
      const found = res.aircraft.find((e) => e.hex === wanted);
      if (!found) return errText(`aircraft ${wanted} is not currently trackable (not seen, out of range, unreachable, in the sun, or too fast)`);
      follower.bind(wanted);
      follower.onSnapshot(source.getSnapshot());   // push the first fix now (session.start)
      return text(JSON.stringify({
        tracking: wanted, callsign: found.callsign,
        azimuth_deg: Number(found.azimuthDeg.toFixed(1)),
        elevation_deg: Number(found.elevationDeg.toFixed(1)),
        range_km: Number((found.rangeM / 1000).toFixed(1)),
      }, null, 2));
    },
  );

  server.registerTool(
    "get_tracked_aircraft",
    { description: "Report which aircraft hex the follower is currently bound to (or null), and how long since its last fix.", inputSchema: {} },
    async () => {
      const s = follower.status();
      return text(JSON.stringify({ hex: s.hex, lost_ms: s.lostMs, session_active: session.isActive() }, null, 2));
    },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adsb-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/adsb-tools.ts tb3-mcp/test/adsb-tools.test.ts
git commit -m "feat(l4): scan_aircraft / track_aircraft / get_tracked_aircraft tools"
```

---

### Task 8: Wire the source into the daemon

**Files:**
- Modify: `tb3-mcp/src/server.ts` (construct `AdsbSource` + `AdsbFollower`, wire the poll→follower, register tools)
- Modify: `tb3-mcp/config.example.json` (document the new keys), `tb3-mcp/README.md` (a short L4 section)
- Test: full suite must stay green; add `tb3-mcp/test/adsb-wire.test.ts` (a light construction/integration check)

**Interfaces:**
- Consumes: everything from Tasks 5–7; `buildApp`/`main` in `server.js`.
- Produces: an `AdsbSource` whose `onSnapshot` drives `follower.onSnapshot`, registered `registerAdsbTools` in `buildApp`, and `source.start()` in `main` gated on `cfg.adsbEnabled`.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/adsb-wire.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AdsbSource } from "../src/adsb/source.js";
import { AdsbFollower } from "../src/adsb/follower.js";
import { loadConfig } from "../src/config.js";

// The source's onSnapshot must drive the follower (this is the wiring server.ts does).
describe("adsb wiring", () => {
  it("a source poll delivers the snapshot to the follower", async () => {
    const cfg = loadConfig(undefined, { TB3_ADSB_URL: "http://x/aircraft.json" });
    let started = false;
    const sink = {
      start() { started = true; return null; },
      updateTarget() { return null; },
      isActive() { return started; },
    };
    const follower = new AdsbFollower(sink, cfg.adsbAltSource, cfg.adsbLostSec * 1000, () => 1000);
    follower.bind("abc");
    const src = new AdsbSource(cfg, {
      now: () => 1000,
      fetchFn: (async () => ({ ok: true, json: async () => ({ aircraft: [{ hex: "abc", lat: 1, lon: 2, alt_geom: 10000 }] }) })) as unknown as typeof fetch,
      onSnapshot: (s) => follower.onSnapshot(s),
    });
    await src.pollOnceForTest();
    expect(started).toBe(true);        // first fix reached the sink via the wiring
  });
});
```

- [ ] **Step 2: Run the test to verify it fails/passes**

Run: `npx vitest run test/adsb-wire.test.ts`
Expected: PASS already (it exercises Task 5/6 units) — this test documents the wiring contract `server.ts` must honor. Proceed to wire the real daemon.

- [ ] **Step 3: Wire `server.ts`.** Add imports near the other tool imports:

```typescript
import { AdsbSource } from "./adsb/source.js";
import { AdsbFollower } from "./adsb/follower.js";
import { registerAdsbTools } from "./adsb-tools.js";
```

Change `buildApp`'s signature to accept the source + follower, and register the tools alongside the others:

```typescript
export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
): Express {
  // ...unchanged up to the registration block...
        registerTools(server, device, cfg, session, supervisor, store);
        registerGeoTools(server, device, cfg, store, session, supervisor);
        registerTrackTools(server, session, supervisor);
        registerSunTools(server, device, cfg, store, supervisor);
        registerAdsbTools(server, source, follower, store, cfg, session, supervisor);
  // ...
}
```

In `main()`, after the `supervisor` is created and started, before `buildApp`:

```typescript
  const follower = new AdsbFollower(session, cfg.adsbAltSource, cfg.adsbLostSec * 1000);
  const source = new AdsbSource(cfg, { onSnapshot: (s) => follower.onSnapshot(s) });
  if (cfg.adsbEnabled) {
    source.start();
    console.log(`[tb3-mcp] ADS-B source polling ${cfg.adsbUrl} at ${cfg.adsbPollHz}Hz`);
  }
  const app = buildApp(device, cfg, store, session, supervisor, source, follower);
```

(`TrackingSession` already satisfies `TargetSink` — `start`/`updateTarget`/`isActive` are public.)

- [ ] **Step 4: Update docs.** In `tb3-mcp/config.example.json` add the keys with defaults:

```json
  "adsbEnabled": false,
  "adsbUrl": "http://127.0.0.1/data/aircraft.json",
  "adsbPollHz": 1,
  "adsbMaxRangeKm": 100,
  "adsbLostSec": 15,
  "adsbAltSource": "auto",
  "llmUrl": "http://127.0.0.1:8000/v1/chat/completions",
  "llmModel": "qwen2.5-14b-instruct",
  "agentTickSec": 5,
  "agentMinDwellSec": 25,
  "agentMcpUrl": "http://127.0.0.1:8770/mcp"
```

In `tb3-mcp/README.md`, add a short "Layer 4 — ADS-B target source" section describing `scan_aircraft`/`track_aircraft`/`get_tracked_aircraft`, that `adsbEnabled` defaults off, and that the host agent is a separate process (`npm run agent`, added in Task 12).

- [ ] **Step 5: Verify the whole suite + type-check**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx tsc -p tsconfig.json --noEmit && npm test`
Expected: tsc clean; ALL tests pass (217 existing + the new adsb tests).

- [ ] **Step 6: Commit**

```bash
git add tb3-mcp/src/server.ts tb3-mcp/config.example.json tb3-mcp/README.md tb3-mcp/test/adsb-wire.test.ts
git commit -m "feat(l4): wire AdsbSource+AdsbFollower into the daemon, register tools"
```

---

## PHASE B — Host agent

### Task 9: LLM chooser (`chooseTarget`)

**Files:**
- Create: `tb3-mcp/src/agent/llm.ts`
- Test: `tb3-mcp/test/agent-llm.test.ts`

**Interfaces:**
- Consumes: `z`.
- Produces:
  - `const DecisionSchema` → `type Decision = { action: "track"|"keep"|"stop"; hex?: string; reason: string }`
  - `interface ChooseInput { trackable: AircraftBrief[]; current: { hex: string|null; label: string|null; state: string; pointingErrorDeg: number|null } }` where `AircraftBrief = { hex; callsign; category; squawk; altitude_m; ground_speed_kt; azimuth_deg; elevation_deg; range_km; est_track_sec }`
  - `const SYSTEM_PROMPT: string` (the "most interesting" policy)
  - `chooseTarget(llmUrl: string, model: string, input: ChooseInput, fetchFn?: typeof fetch, timeoutMs?: number): Promise<Decision>` — POSTs an OpenAI-compatible chat completion with `response_format:{type:"json_schema",…,strict:true}`, parses `choices[0].message.content` as JSON, validates with `DecisionSchema`. Throws on HTTP error, missing content, or invalid JSON.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/agent-llm.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { chooseTarget, DecisionSchema, type ChooseInput } from "../src/agent/llm.js";

const INPUT: ChooseInput = {
  trackable: [
    { hex: "abc123", callsign: "UAL1", category: "A3", squawk: "1200", altitude_m: 9000,
      ground_speed_kt: 420, azimuth_deg: 90, elevation_deg: 30, range_km: 40, est_track_sec: 60 },
  ],
  current: { hex: null, label: null, state: "stopped", pointingErrorDeg: null },
};

function llmReturning(content: string, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ choices: [{ message: { content } }] }) })) as unknown as typeof fetch;
}

describe("chooseTarget", () => {
  it("parses a valid decision", async () => {
    const d = await chooseTarget("http://llm/v1/chat/completions", "m",
      INPUT, llmReturning(JSON.stringify({ action: "track", hex: "abc123", reason: "only heavy nearby" })));
    expect(d).toEqual({ action: "track", hex: "abc123", reason: "only heavy nearby" });
  });

  it("throws on HTTP error", async () => {
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning("{}", false))).rejects.toThrow(/HTTP 500/);
  });

  it("throws on malformed content", async () => {
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning("not json"))).rejects.toThrow();
    await expect(chooseTarget("http://llm", "m", INPUT, llmReturning(JSON.stringify({ action: "banana" })))).rejects.toThrow();
  });

  it("schema accepts keep/stop without a hex", () => {
    expect(DecisionSchema.parse({ action: "keep", reason: "current is good" }).action).toBe("keep");
    expect(DecisionSchema.parse({ action: "stop", reason: "nothing worth it" }).action).toBe("stop");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/agent-llm.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/agent/llm.ts`:

```typescript
import { z } from "zod";

export const DecisionSchema = z.object({
  action: z.enum(["track", "keep", "stop"]),
  hex: z.string().optional(),
  reason: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface AircraftBrief {
  hex: string;
  callsign: string | null;
  category: string | null;
  squawk: string | null;
  altitude_m: number | null;
  ground_speed_kt: number | null;
  azimuth_deg: number;
  elevation_deg: number;
  range_km: number;
  est_track_sec: number;
}

export interface ChooseInput {
  trackable: AircraftBrief[];
  current: { hex: string | null; label: string | null; state: string; pointingErrorDeg: number | null };
}

export const SYSTEM_PROMPT =
  "You choose which aircraft a camera rig should track. You are given a list of aircraft that are " +
  "ALL already reachable, sun-safe, and within the rig's slew rate — you only need to judge which is " +
  "MOST INTERESTING to film. Prefer, roughly in order: emergency squawks (7500 hijack, 7600 radio " +
  "failure, 7700 general emergency); military or state aircraft (odd hex ranges, no callsign, unusual " +
  "categories); heavies and rare types (A388, B748, A345, warbirds); then anything unusual (odd " +
  "callsign, very low/very high, loitering). If you are already tracking a good target, KEEP it unless " +
  "a clearly more interesting one appears — do not thrash. If nothing is worth filming, STOP. " +
  'Respond ONLY as JSON {"action":"track"|"keep"|"stop","hex"?:string,"reason":string}. ' +
  "For action \"track\", hex MUST be one of the listed hexes.";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["track", "keep", "stop"] },
    hex: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action", "reason"],
  additionalProperties: false,
};

export async function chooseTarget(
  llmUrl: string, model: string, input: ChooseInput,
  fetchFn: typeof fetch = fetch, timeoutMs = 10000,
): Promise<Decision> {
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "decision", schema: RESPONSE_SCHEMA, strict: true } },
  };
  const r = await fetchFn(llmUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("LLM response had no message content");
  return DecisionSchema.parse(JSON.parse(content));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/agent-llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/agent/llm.ts tb3-mcp/test/agent-llm.test.ts
git commit -m "feat(l4): chooseTarget — constrained-JSON LLM target chooser"
```

---

### Task 10: Decision guardrails (`decideAction` / `failSafeAction`)

**Files:**
- Create: `tb3-mcp/src/agent/decide.ts`
- Test: `tb3-mcp/test/agent-decide.test.ts`

**Interfaces:**
- Consumes: `Decision` (Task 9).
- Produces:
  - `type Action = { kind: "track"; hex: string } | { kind: "keep" } | { kind: "stop" }`
  - `interface DecideInput { decision: Decision; trackableHexes: Set<string>; currentHex: string|null; currentHealthy: boolean; msSinceLastSwitch: number; minDwellMs: number }`
  - `decideAction(inp: DecideInput): Action` — enforces: hallucinated/unknown hex → keep; already on that hex → keep; switching off a healthy current before `minDwellMs` → keep; explicit stop with nothing bound → keep.
  - `failSafeAction(currentHex: string|null, currentHealthy: boolean): Action` — keep if nothing bound or current healthy; stop if bound-but-unhealthy.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/agent-decide.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decideAction, failSafeAction, type DecideInput } from "../src/agent/decide.js";

function base(p: Partial<DecideInput>): DecideInput {
  return {
    decision: { action: "keep", reason: "" },
    trackableHexes: new Set(["aaa", "bbb"]),
    currentHex: null, currentHealthy: false,
    msSinceLastSwitch: 999999, minDwellMs: 25000, ...p,
  };
}

describe("decideAction", () => {
  it("tracks a valid new hex when idle", () => {
    expect(decideAction(base({ decision: { action: "track", hex: "aaa", reason: "" } })))
      .toEqual({ kind: "track", hex: "aaa" });
  });
  it("rejects a hallucinated hex → keep", () => {
    expect(decideAction(base({ decision: { action: "track", hex: "zzz", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
  it("keeps when the pick is the current target", () => {
    expect(decideAction(base({ currentHex: "aaa", decision: { action: "track", hex: "aaa", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
  it("blocks switching off a healthy current before min-dwell", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: true, msSinceLastSwitch: 5000,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "keep" });
  });
  it("allows a switch after min-dwell", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: true, msSinceLastSwitch: 30000,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "track", hex: "bbb" });
  });
  it("allows switching away from an UNHEALTHY current immediately", () => {
    expect(decideAction(base({
      currentHex: "aaa", currentHealthy: false, msSinceLastSwitch: 100,
      decision: { action: "track", hex: "bbb", reason: "" },
    }))).toEqual({ kind: "track", hex: "bbb" });
  });
  it("stops on an explicit stop when bound; keeps when idle", () => {
    expect(decideAction(base({ currentHex: "aaa", decision: { action: "stop", reason: "" } })))
      .toEqual({ kind: "stop" });
    expect(decideAction(base({ currentHex: null, decision: { action: "stop", reason: "" } })))
      .toEqual({ kind: "keep" });
  });
});

describe("failSafeAction", () => {
  it("keeps when idle or current healthy, stops a lost current", () => {
    expect(failSafeAction(null, false)).toEqual({ kind: "keep" });
    expect(failSafeAction("aaa", true)).toEqual({ kind: "keep" });
    expect(failSafeAction("aaa", false)).toEqual({ kind: "stop" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/agent-decide.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/agent/decide.ts`:

```typescript
import { Decision } from "./llm.js";

export type Action =
  | { kind: "track"; hex: string }
  | { kind: "keep" }
  | { kind: "stop" };

export interface DecideInput {
  decision: Decision;
  trackableHexes: Set<string>;
  currentHex: string | null;
  currentHealthy: boolean;
  msSinceLastSwitch: number;
  minDwellMs: number;
}

// Turn an advisory LLM decision into a safe action. The daemon has already
// guaranteed every trackable hex is reachable/sun-safe/slew-able; here we only
// stop the agent thrashing and reject hallucinated hexes.
export function decideAction(inp: DecideInput): Action {
  const d = inp.decision;
  if (d.action === "stop") return inp.currentHex === null ? { kind: "keep" } : { kind: "stop" };
  if (d.action === "keep") return { kind: "keep" };

  // action === "track"
  const hex = d.hex?.toLowerCase();
  if (!hex || !inp.trackableHexes.has(hex)) return { kind: "keep" };   // hallucinated / stale
  if (hex === inp.currentHex) return { kind: "keep" };                 // already on it
  // Don't drop a healthy current target until it has had its dwell.
  if (inp.currentHex !== null && inp.currentHealthy && inp.msSinceLastSwitch < inp.minDwellMs) {
    return { kind: "keep" };
  }
  return { kind: "track", hex };
}

// On an LLM fault (timeout/error/invalid), don't guess: hold a healthy target,
// stop one that is already lost, do nothing when idle.
export function failSafeAction(currentHex: string | null, currentHealthy: boolean): Action {
  if (currentHex === null) return { kind: "keep" };
  return currentHealthy ? { kind: "keep" } : { kind: "stop" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/agent-decide.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/agent/decide.ts tb3-mcp/test/agent-decide.test.ts
git commit -m "feat(l4): agent decision guardrails — hysteresis + fail-safe"
```

---

### Task 11: Agent loop core (`runOnce`)

**Files:**
- Create: `tb3-mcp/src/agent/loop.ts`
- Test: `tb3-mcp/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `chooseTarget`/`ChooseInput`/`AircraftBrief`/`Decision` (Task 9); `decideAction`/`failSafeAction`/`Action` (Task 10).
- Produces:
  - `interface RigMcpClient { scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]>; getTracked(): Promise<{ hex: string|null }>; getStatus(): Promise<{ state: string; label: string|null; pointingErrorDeg: number|null }>; track(hex: string): Promise<void>; stop(): Promise<void> }`
  - `interface LoopState { lastSwitchMs: number }`
  - `interface LoopDeps { client: RigMcpClient; choose: (input: ChooseInput) => Promise<Decision>; cfg: { maxRangeKm: number; minDwellMs: number }; now: () => number }`
  - `runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }>` — scans, reads current, calls `choose` (fail-safe on throw), applies `decideAction`, issues `track`/`stop`, and updates `lastSwitchMs` only on a `track`. `currentHealthy` = the bound hex is present in the current trackable scan.

- [ ] **Step 1: Write the failing test** — create `tb3-mcp/test/agent-loop.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runOnce, type RigMcpClient, type LoopDeps, type LoopState } from "../src/agent/loop.js";
import type { AircraftBrief, ChooseInput, Decision } from "../src/agent/llm.js";

function brief(hex: string): AircraftBrief {
  return { hex, callsign: null, category: null, squawk: null, altitude_m: 9000,
    ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 30, range_km: 40, est_track_sec: 60 };
}
function client(over: Partial<RigMcpClient> = {}): { c: RigMcpClient; calls: string[] } {
  const calls: string[] = [];
  const c: RigMcpClient = {
    scanAircraft: async () => [brief("aaa"), brief("bbb")],
    getTracked: async () => ({ hex: null }),
    getStatus: async () => ({ state: "stopped", label: null, pointingErrorDeg: null }),
    track: async (h) => { calls.push(`track:${h}`); },
    stop: async () => { calls.push("stop"); },
    ...over,
  };
  return { c, calls };
}
function deps(c: RigMcpClient, choose: (i: ChooseInput) => Promise<Decision>, now = 100000): LoopDeps {
  return { client: c, choose, cfg: { maxRangeKm: 100, minDwellMs: 25000 }, now: () => now };
}

describe("runOnce", () => {
  it("tracks the LLM's pick and stamps the switch time", async () => {
    const { c, calls } = client();
    const out = await runOnce(deps(c, async () => ({ action: "track", hex: "bbb", reason: "" })), { lastSwitchMs: 0 });
    expect(calls).toEqual(["track:bbb"]);
    expect(out.action).toEqual({ kind: "track", hex: "bbb" });
    expect(out.state.lastSwitchMs).toBe(100000);
  });

  it("fails safe (stop) when the LLM throws and current is lost", async () => {
    // Bound to ccc, but ccc is NOT in the current scan → unhealthy.
    const { c, calls } = client({ getTracked: async () => ({ hex: "ccc" }) });
    const out = await runOnce(deps(c, async () => { throw new Error("llm down"); }), { lastSwitchMs: 0 });
    expect(calls).toEqual(["stop"]);
    expect(out.action).toEqual({ kind: "stop" });
  });

  it("keeps (no tool call) when the LLM throws and current is healthy", async () => {
    const { c, calls } = client({ getTracked: async () => ({ hex: "aaa" }) });   // aaa is in scan
    const out = await runOnce(deps(c, async () => { throw new Error("llm down"); }), { lastSwitchMs: 0 });
    expect(calls).toEqual([]);
    expect(out.action).toEqual({ kind: "keep" });
  });

  it("respects min-dwell: keeps a healthy current despite a different pick", async () => {
    const { c, calls } = client({ getTracked: async () => ({ hex: "aaa" }) });
    const out = await runOnce(deps(c, async () => ({ action: "track", hex: "bbb", reason: "" }), 100000),
      { lastSwitchMs: 90000 });   // only 10s since last switch < 25s
    expect(calls).toEqual([]);
    expect(out.action).toEqual({ kind: "keep" });
    expect(out.state.lastSwitchMs).toBe(90000);   // unchanged
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/agent-loop.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** Create `tb3-mcp/src/agent/loop.ts`:

```typescript
import { AircraftBrief, ChooseInput, Decision } from "./llm.js";
import { Action, decideAction, failSafeAction } from "./decide.js";

export interface RigMcpClient {
  scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]>;
  getTracked(): Promise<{ hex: string | null }>;
  getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }>;
  track(hex: string): Promise<void>;
  stop(): Promise<void>;
}

export interface LoopState { lastSwitchMs: number; }

export interface LoopDeps {
  client: RigMcpClient;
  choose: (input: ChooseInput) => Promise<Decision>;
  cfg: { maxRangeKm: number; minDwellMs: number };
  now: () => number;
}

export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  const trackable = await deps.client.scanAircraft({ maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, limit: 20 });
  const tracked = await deps.client.getTracked();
  const status = await deps.client.getStatus();

  const trackableHexes = new Set(trackable.map((a) => a.hex.toLowerCase()));
  const currentHex = tracked.hex ? tracked.hex.toLowerCase() : null;
  const currentHealthy = currentHex !== null && trackableHexes.has(currentHex);

  let action: Action;
  try {
    const decision = await deps.choose({
      trackable,
      current: { hex: currentHex, label: status.label, state: status.state, pointingErrorDeg: status.pointingErrorDeg },
    });
    action = decideAction({
      decision, trackableHexes, currentHex, currentHealthy,
      msSinceLastSwitch: deps.now() - state.lastSwitchMs, minDwellMs: deps.cfg.minDwellMs,
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
  else if (action.kind === "stop") { await deps.client.stop(); }

  return { action, state: { lastSwitchMs } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/agent-loop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/agent/loop.ts tb3-mcp/test/agent-loop.test.ts
git commit -m "feat(l4): agent loop core (runOnce) over an MCP-client seam"
```

---

### Task 12: MCP-client adapter + agent entrypoint + deploy

**Files:**
- Create: `tb3-mcp/src/agent/mcp-client.ts` (`RigMcpClient` over the MCP SDK), `tb3-mcp/src/agent/agent.ts` (`main()`), `tb3-mcp/deploy/tb3-agent.service`
- Modify: `tb3-mcp/package.json` (add an `agent` script)

**Interfaces:**
- Consumes: `RigMcpClient`/`runOnce`/`LoopState` (Task 11); `chooseTarget` (Task 9); `AircraftBrief` (Task 9); `loadConfig`/`Config` (`config.js`); `Scheduler`/`realScheduler` (`track/session.js`); the MCP SDK `Client` + `StreamableHTTPClientTransport`.
- Produces: `class McpRigClient implements RigMcpClient` that calls the daemon tools (`scan_aircraft`, `get_tracked_aircraft`, `get_tracking_status`, `track_aircraft`, `stop_tracking`) and parses their JSON text content; `main()` that connects, then runs `runOnce` every `agentTickSec`.

Notes: MCP tools return `{ content: [{ type:"text", text }] }`; parse `JSON.parse(text)` and narrow with a small Zod schema per tool. Map `scan_aircraft`'s `{ aircraft: [...] }` rows to `AircraftBrief`. `getStatus` reads `get_tracking_status`'s `state`/`label`/`pointing_error_deg`. This task has **no unit test** (it is live I/O); it is gated by `tsc --noEmit` and the full suite staying green. The tested cores (Tasks 9–11) carry the logic.

- [ ] **Step 1: Implement the MCP client adapter.** Create `tb3-mcp/src/agent/mcp-client.ts`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { RigMcpClient } from "./loop.js";
import { AircraftBrief } from "./llm.js";

const ScanRow = z.object({
  hex: z.string(), callsign: z.string().nullable(), category: z.string().nullable(),
  squawk: z.string().nullable(), altitude_m: z.number().nullable(),
  ground_speed_kt: z.number().nullable(), azimuth_deg: z.number(), elevation_deg: z.number(),
  range_km: z.number(), est_track_sec: z.number(),
});
const ScanBody = z.object({ aircraft: z.array(ScanRow) });
const TrackedBody = z.object({ hex: z.string().nullable() });
const StatusBody = z.object({ state: z.string(), label: z.string().nullable(), pointing_error_deg: z.number().nullable() });

function textOf(result: unknown): string {
  const r = result as { content?: { type: string; text?: string }[] };
  const t = r.content?.find((c) => c.type === "text")?.text;
  if (typeof t !== "string") throw new Error("tool returned no text content");
  return t;
}

export class McpRigClient implements RigMcpClient {
  private client: Client;
  constructor(private readonly url: string, private readonly token?: string) {
    this.client = new Client({ name: "tb3-agent", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const opts = this.token ? { requestInit: { headers: { authorization: `Bearer ${this.token}` } } } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), opts);
    await this.client.connect(transport);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<string> {
    return textOf(await this.client.callTool({ name, arguments: args }));
  }

  async scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; limit: number }): Promise<AircraftBrief[]> {
    const body = ScanBody.parse(JSON.parse(
      await this.call("scan_aircraft", { max_range_km: p.maxRangeKm, only_trackable: p.onlyTrackable, limit: p.limit })));
    return body.aircraft;
  }
  async getTracked(): Promise<{ hex: string | null }> {
    return { hex: TrackedBody.parse(JSON.parse(await this.call("get_tracked_aircraft", {}))).hex };
  }
  async getStatus(): Promise<{ state: string; label: string | null; pointingErrorDeg: number | null }> {
    const b = StatusBody.parse(JSON.parse(await this.call("get_tracking_status", {})));
    return { state: b.state, label: b.label, pointingErrorDeg: b.pointing_error_deg };
  }
  async track(hex: string): Promise<void> { await this.call("track_aircraft", { hex }); }
  async stop(): Promise<void> { await this.call("stop_tracking", {}); }
}
```

- [ ] **Step 2: Implement the entrypoint.** Create `tb3-mcp/src/agent/agent.ts`:

```typescript
import { loadConfig } from "../config.js";
import { realScheduler } from "../track/session.js";
import { McpRigClient } from "./mcp-client.js";
import { chooseTarget } from "./llm.js";
import { runOnce, type LoopState } from "./loop.js";

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env.TB3_CONFIG ?? "config.json");
  const client = new McpRigClient(cfg.agentMcpUrl, cfg.mcpToken);
  await client.connect();
  console.log(`[tb3-agent] connected to ${cfg.agentMcpUrl}; LLM ${cfg.llmUrl} (${cfg.llmModel})`);

  let state: LoopState = { lastSwitchMs: 0 };
  let running = false;
  const tickMs = Math.max(1000, Math.round(cfg.agentTickSec * 1000));
  realScheduler.every(tickMs, () => {
    if (running) return;   // never overlap a tick
    running = true;
    void runOnce({
      client,
      choose: (input) => chooseTarget(cfg.llmUrl, cfg.llmModel, input),
      cfg: { maxRangeKm: cfg.adsbMaxRangeKm, minDwellMs: cfg.agentMinDwellSec * 1000 },
      now: Date.now,
    }, state)
      .then((r) => { state = r.state; if (r.action.kind !== "keep") console.log(`[tb3-agent] ${JSON.stringify(r.action)}`); })
      .catch((e: unknown) => console.error("[tb3-agent] tick error:", e))
      .finally(() => { running = false; });
  });
  console.log(`[tb3-agent] deciding every ${cfg.agentTickSec}s (min-dwell ${cfg.agentMinDwellSec}s)`);
}

const isEntry = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) { main().catch((e) => { console.error(e); process.exit(1); }); }
```

- [ ] **Step 3: Add the run script + deploy unit.** In `tb3-mcp/package.json` `"scripts"`, add:

```json
    "agent": "node dist/agent/agent.js",
    "agent:dev": "tsx src/agent/agent.ts"
```

(Verified against `package.json`: the daemon uses `"start": "node dist/server.js"` and `"dev": "tsx src/server.ts"`; these mirror that exactly — compiled for prod, `tsx` for dev. The deploy unit runs `npm run build` then `npm run agent`.)

Create `tb3-mcp/deploy/tb3-agent.service` (mirror `tb3-mcp.service`):

```ini
[Unit]
Description=TB3 ADS-B autonomous tracking agent
After=network-online.target tb3-mcp.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/atomist/TB3-ESP32/tb3-mcp
Environment=TB3_CONFIG=/home/atomist/TB3-ESP32/tb3-mcp/config.json
ExecStartPre=/usr/bin/npm run build
ExecStart=/usr/bin/npm run agent
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Verify build + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx tsc -p tsconfig.json --noEmit && npm test`
Expected: tsc clean (the SDK `Client`/`StreamableHTTPClientTransport` imports resolve — they are already a dependency for the server); ALL tests pass.

- [ ] **Step 5: Commit**

```bash
git add tb3-mcp/src/agent/mcp-client.ts tb3-mcp/src/agent/agent.ts tb3-mcp/deploy/tb3-agent.service tb3-mcp/package.json
git commit -m "feat(l4): MCP-client adapter + autonomous agent entrypoint + deploy unit"
```

---

## Integration / hardware verification (after all tasks, on the host)

Gated by Phase-0 exit criteria. Not unit tests — a manual on-host runbook:

1. **Feed:** `curl "$TB3_ADSB_URL"` returns live aircraft. Set `adsbEnabled:true` + `adsbUrl` in `config.json`; start the daemon; call `scan_aircraft` (via any MCP client / `mcp` inspector) → a sensible nearest-first trackable list.
2. **Manual track:** with a solved calibration, `track_aircraft` a hex from the list → the rig acquires and follows; `get_tracking_status` shows falling `pointing_error_deg`; `stop_tracking` halts and the follower unbinds (`get_tracked_aircraft` → `hex:null`).
3. **Safety:** confirm `scan_aircraft` never lists an aircraft in the sun cone / below the tilt limit / above the slew ceiling, and `track_aircraft` on such a hex is refused.
4. **Agent:** start `npm run agent` against the live LLM → it autonomously picks an interesting aircraft, follows, and does not thrash (switch no more often than `agentMinDwellSec`); killing the LLM makes it fail safe (holds a healthy target, stops a lost one).

---

## Self-Review

**Spec coverage:** AdsbSource (T5), enrich with reachable/sunSafe/slewOk/estTrackSec (T4), follower first-bind-start/lost/switch/self-heal (T6), scan_aircraft/track_aircraft (+ get_tracked_aircraft) (T7), config incl. adsbAltSource (T1), wiring (T8), LLM constrained-JSON chooser (T9), hysteresis + fail-safe (T10), agent loop (T11), MCP client + entrypoint + deploy (T12). Altitude ft→m + geom/baro (T3), velocity kt/fpm→m/s (T3), interestingness-in-LLM (T9 prompt + daemon proximity-only sort). Phase 0 documented as external. All covered.

**Placeholder scan:** none — every code/test step carries complete code and exact commands.

**Type consistency:** `Aircraft`/`EnrichedAircraft`/`AdsbSnapshot` (T2) are consumed unchanged by T3–T8; `AircraftBrief`/`ChooseInput`/`Decision` (T9) by T10–T12; `Action`/`RigMcpClient`/`LoopState` names match across T10–T12; `TargetSink` (T6) matches `TrackingSession`'s `start`/`updateTarget`/`isActive` signatures verified against `track/session.ts`. `scan_aircraft` JSON field names (`pointing_error_deg`, `hex`, `aircraft`) match what `mcp-client.ts` parses.
