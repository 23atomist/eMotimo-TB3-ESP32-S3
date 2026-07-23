# Azimuth-Sector Tracking Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict ADS-B tracking to a configured open azimuth arc so the rig never chases a plane into the operator's house, with an in-track auto-stop if a tracked plane drifts out of the arc.

**Architecture:** A persisted `TrackSector {enabled,startDeg,endDeg}` (world-azimuth, north-wrap-aware) drives a pure `inArc` predicate. `enrichAircraft` gains an `inSector` flag and `isTrackable` gains `&& inSector`, so out-of-arc planes drop from the trackable list and `track_aircraft` refuses them. The tracking `tick()` re-checks the target azimuth each update and holds (`outside_sector`) if it leaves the arc. The sector lives in its own atomic JSON store (separate from calibration, so recalibration doesn't wipe it) with `get_track_sector`/`set_track_sector` tools, and a dashboard compass-ring widget sets it. Default-disabled = inert.

**Tech Stack:** TypeScript/Node ESM, vitest (`fileParallelism:false`), Zod. Dashboard is vanilla JS/CSS, no build step. No new runtime dependencies.

## Global Constraints

- No `any`; all imports use `.js` specifiers; ESM.
- Default sector is **disabled** (`enabled:false` ≡ full 360°); `inArc` returns `true` when disabled. The feature is **inert until an arc is set** — the existing test suite must stay green unchanged (this is the backward-compat guardrail).
- New params added to existing functions default to a disabled sector (same pattern the codebase uses for optional additive params), so existing callers/tests are unaffected.
- The open arc sweeps **clockwise from `startDeg` to `endDeg`**: if `start ≤ end`, inside = `start ≤ az ≤ end`; if `start > end` (wraps north), inside = `az ≥ start || az ≤ end`. Bearings normalize to `[0,360)`. Boundaries inclusive.
- The sector store is **separate from `CalibrationStore`** — it must survive `clear_calibration`/recalibration.
- The filter is purely subtractive: it only removes planes from trackable and holds a track; it never commands motion. Manual jog/goto/point_at stay unrestricted.
- Build/test from `tb3-mcp/`: `export PATH="/Volumes/ExtData/homebrew/bin:$PATH"`; single file `npx vitest run test/<file>.ts`; full `npm test`; type-check `npm run build` (tsc).

---

## File Structure

- **Create `src/track/sector.ts`** — `TrackSector` type, `DISABLED_SECTOR` const, `inArc(azDeg, sector)` pure predicate.
- **Create `src/sector-store.ts`** — `SectorStore` (atomic JSON, Zod, load-never-throws), mirroring `CalibrationStore`.
- **Create `src/sector-tools.ts`** — `registerSectorTools` (`get_track_sector`, `set_track_sector`).
- **Modify `src/adsb/types.ts`** — `EnrichedAircraft.inSector: boolean`.
- **Modify `src/adsb/enrich.ts`** — `enrichAircraft` gains a `sector` param (default disabled); sets `inSector`.
- **Modify `src/adsb-tools.ts`** — `isTrackable` gains `&& e.inSector`; `scanAircraft` gains a `sector` param; `registerAdsbTools` gains a `sectorStore` param and reads it per call.
- **Modify `src/track/session.ts`** — constructor gains a `sectorProvider` param (default disabled); `tick()` holds `outside_sector` when the target leaves the arc; `WaitReason` gains `"outside_sector"`.
- **Modify `src/config.ts`** — `sectorFile` optional path.
- **Modify `src/server.ts`** — construct `SectorStore`, thread it to the session (`sectorProvider`), `buildApp`, and the tool registrations.
- **Modify dashboard** — `src/dashboard/client.ts`, `src/dashboard/controls.ts`, the dashboard server route, `dashboard/public/{index.html,app.js,style.css}`.

Order: 1 (pure predicate) → 2 (store) → 3 (enrich+gate) → 4 (tools+scan/track wiring) → 5 (in-track stop) → 6 (server wiring) → 7 (dashboard). Each task is independently testable.

---

### Task 1: `inArc` predicate + `TrackSector`

**Files:**
- Create: `tb3-mcp/src/track/sector.ts`
- Test: `tb3-mcp/test/sector.test.ts`

**Interfaces:**
- Produces: `interface TrackSector { enabled: boolean; startDeg: number; endDeg: number }`; `const DISABLED_SECTOR: TrackSector`; `function inArc(azDeg: number, sector: TrackSector): boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/sector.test.ts
import { describe, it, expect } from "vitest";
import { inArc, DISABLED_SECTOR, TrackSector } from "../src/track/sector.js";

const arc = (startDeg: number, endDeg: number): TrackSector => ({ enabled: true, startDeg, endDeg });

describe("inArc", () => {
  it("disabled sector is always inside", () => {
    for (const az of [0, 90, 180, 270, 359]) expect(inArc(az, DISABLED_SECTOR)).toBe(true);
    expect(inArc(123, { enabled: false, startDeg: 10, endDeg: 20 })).toBe(true);
  });

  it("non-wrapping arc: inside between start and end, inclusive", () => {
    const s = arc(90, 270);
    expect(inArc(180, s)).toBe(true);
    expect(inArc(90, s)).toBe(true);   // start boundary inclusive
    expect(inArc(270, s)).toBe(true);  // end boundary inclusive
    expect(inArc(89.9, s)).toBe(false);
    expect(inArc(0, s)).toBe(false);
    expect(inArc(300, s)).toBe(false);
  });

  it("north-wrapping arc (300 -> 60) includes the slice through north", () => {
    const s = arc(300, 60);
    expect(inArc(0, s)).toBe(true);
    expect(inArc(350, s)).toBe(true);
    expect(inArc(30, s)).toBe(true);
    expect(inArc(300, s)).toBe(true);
    expect(inArc(60, s)).toBe(true);
    expect(inArc(120, s)).toBe(false);
    expect(inArc(200, s)).toBe(false);
    expect(inArc(61, s)).toBe(false);
  });

  it("normalizes azimuths outside [0,360) before testing", () => {
    expect(inArc(-10, arc(300, 60))).toBe(true);   // -10 -> 350, inside
    expect(inArc(370, arc(300, 60))).toBe(true);    // 370 -> 10, inside
  });

  it("zero-width enabled arc (start === end) admits only that exact bearing", () => {
    const s = arc(90, 90);
    expect(inArc(90, s)).toBe(true);
    expect(inArc(91, s)).toBe(false);
    expect(inArc(89, s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector.test.ts`
Expected: FAIL — module `sector.js` not found.

- [ ] **Step 3: Implement**

```typescript
// tb3-mcp/src/track/sector.ts
export interface TrackSector { enabled: boolean; startDeg: number; endDeg: number; }

export const DISABLED_SECTOR: TrackSector = { enabled: false, startDeg: 0, endDeg: 360 };

// Normalize any angle to [0, 360).
function norm360(deg: number): number { return ((deg % 360) + 360) % 360; }

// True if azDeg falls within the open arc that sweeps clockwise from startDeg
// to endDeg. A disabled sector admits everything. When start <= end the arc is
// the simple interval; when start > end the arc wraps through north (360/0).
export function inArc(azDeg: number, sector: TrackSector): boolean {
  if (!sector.enabled) return true;
  const az = norm360(azDeg);
  const start = norm360(sector.startDeg);
  const end = norm360(sector.endDeg);
  if (start <= end) return az >= start && az <= end;
  return az >= start || az <= end;
}
```

Note: `DISABLED_SECTOR.endDeg` is 360 only as a sentinel; `inArc` short-circuits on `enabled:false`, so the value is never used in the interval test.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/track/sector.ts tb3-mcp/test/sector.test.ts && git commit -m "feat(sector): inArc predicate + TrackSector (north-wrap aware)"
```

---

### Task 2: `SectorStore` (persistence)

**Files:**
- Create: `tb3-mcp/src/sector-store.ts`
- Test: `tb3-mcp/test/sector-store.test.ts`

**Interfaces:**
- Consumes: `TrackSector`, `DISABLED_SECTOR` from `./track/sector.js`.
- Produces: `class SectorStore { constructor(filePath: string); load(): void; get(): TrackSector; set(sector: TrackSector): void }`.

**Pattern:** mirror `src/calibration.ts` `CalibrationStore` — Zod schema, atomic write (`tmp` + `renameSync`), `load()` never throws (missing/corrupt → default), `get()` returns a copy.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/sector-store.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectorStore } from "../src/sector-store.js";

const file = () => join(mkdtempSync(join(tmpdir(), "sector-")), "sector.json");

describe("SectorStore", () => {
  it("defaults to a disabled sector when the file is missing", () => {
    const s = new SectorStore(file());
    s.load();
    expect(s.get()).toEqual({ enabled: false, startDeg: 0, endDeg: 360 });
  });

  it("persists and reloads a sector", () => {
    const f = file();
    const a = new SectorStore(f);
    a.load();
    a.set({ enabled: true, startDeg: 300, endDeg: 60 });
    const b = new SectorStore(f);
    b.load();
    expect(b.get()).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
  });

  it("falls back to the disabled default on a corrupt file (never throws)", () => {
    const f = file();
    writeFileSync(f, "{ not json");
    const s = new SectorStore(f);
    s.load();
    expect(s.get().enabled).toBe(false);
  });

  it("get() returns a copy, not the internal reference", () => {
    const s = new SectorStore(file());
    s.load();
    const a = s.get();
    a.startDeg = 999;
    expect(s.get().startDeg).not.toBe(999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector-store.test.ts`
Expected: FAIL — `SectorStore` not found.

- [ ] **Step 3: Implement**

```typescript
// tb3-mcp/src/sector-store.ts
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { TrackSector, DISABLED_SECTOR } from "./track/sector.js";

const SectorSchema = z.object({
  enabled: z.boolean(),
  startDeg: z.number(),
  endDeg: z.number(),
});

export class SectorStore {
  private sector: TrackSector = { ...DISABLED_SECTOR };
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.sector = { ...DISABLED_SECTOR }; return; }
      this.sector = SectorSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      this.sector = { ...DISABLED_SECTOR };   // missing/corrupt → disabled; never throw
    }
  }

  get(): TrackSector { return { ...this.sector }; }

  set(sector: TrackSector): void {
    this.sector = { enabled: sector.enabled, startDeg: sector.startDeg, endDeg: sector.endDeg };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.sector, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/sector-store.ts tb3-mcp/test/sector-store.test.ts && git commit -m "feat(sector): SectorStore atomic JSON persistence"
```

---

### Task 3: `inSector` enrichment + `isTrackable` gate

**Files:**
- Modify: `tb3-mcp/src/adsb/types.ts`, `tb3-mcp/src/adsb/enrich.ts`, `tb3-mcp/src/adsb-tools.ts`
- Test: `tb3-mcp/test/enrich-sector.test.ts` (new); extend `tb3-mcp/test/adsb-tools.test.ts` if present

**Interfaces:**
- Consumes: `inArc`, `TrackSector`, `DISABLED_SECTOR` from `../track/sector.js` (from `src/adsb/*` use `../track/sector.js`; from `src/adsb-tools.ts` use `./track/sector.js`).
- Produces: `EnrichedAircraft.inSector: boolean`; `enrichAircraft(ac, rig, R, cfg, nowMs, sector = DISABLED_SECTOR)`; `isTrackable` includes `&& e.inSector`; `scanAircraft(..., p, sector = DISABLED_SECTOR)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tb3-mcp/test/enrich-sector.test.ts
import { describe, it, expect } from "vitest";
import { enrichAircraft } from "../src/adsb/enrich.js";
import { isTrackable } from "../src/adsb-tools.js";
import { DISABLED_SECTOR } from "../src/track/sector.js";
import type { Aircraft } from "../src/adsb/types.js";
import type { Config } from "../src/config.js";
import type { Mat3 } from "../src/geo/vec3.js";

// A rig at the equator/prime-meridian with identity orientation: ENU azimuth of
// a target is a plain compass bearing, so we can place a plane at a known az.
const rig = { lat: 0, lon: 0, height: 0 };
const R: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const cfg = { adsbAltSource: "geom", panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90, sunConeDeg: 25, maxJogDps: 19 } as unknown as Config;

// A slow plane due EAST (bearing ~90°), a few km out, well above the horizon.
function planeEast(): Aircraft {
  return {
    hex: "abc123", callsign: "TEST", lat: 0.0, lon: 0.05, altBaroFt: null, altGeomFt: 20000,
    gsKt: 5, trackDeg: 90, baroRateFpm: null, geomRateFpm: 0, category: null, squawk: null,
    seenPosSec: 0, rssi: null,
  };
}

describe("enrichAircraft inSector + isTrackable", () => {
  it("disabled sector default leaves inSector true (backward compatible)", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0)!;   // no sector arg
    expect(e.inSector).toBe(true);
    expect(e.azimuthDeg).toBeGreaterThan(80);
    expect(e.azimuthDeg).toBeLessThan(100);
  });

  it("an arc excluding the plane's bearing sets inSector false and makes it not trackable", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0, { enabled: true, startDeg: 180, endDeg: 350 })!;
    expect(e.inSector).toBe(false);
    // reachable+sunSafe+slewOk may be true, but the sector gate must drop it:
    expect(isTrackable(e)).toBe(false);
  });

  it("an arc including the plane's bearing keeps it trackable", () => {
    const e = enrichAircraft(planeEast(), rig, R, cfg, 0, { enabled: true, startDeg: 45, endDeg: 135 })!;
    expect(e.inSector).toBe(true);
    expect(isTrackable(e)).toBe(e.reachable && e.sunSafe && e.slewOk);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/enrich-sector.test.ts`
Expected: FAIL — `enrichAircraft` takes no sector / `inSector` missing.

- [ ] **Step 3: Add `inSector` to the type**

In `tb3-mcp/src/adsb/types.ts`, add to `EnrichedAircraft` (after `slewOk`):

```typescript
  inSector: boolean;
```

- [ ] **Step 4: Thread the sector into `enrichAircraft`**

In `tb3-mcp/src/adsb/enrich.ts`: add the import and the param + computed flag.

```typescript
// add to imports:
import { TrackSector, DISABLED_SECTOR, inArc } from "../track/sector.js";

// change the signature (append the sector param with a disabled default):
export function enrichAircraft(
  ac: Aircraft, rig: Geodetic, R: Mat3, cfg: Config, nowMs: number,
  sector: TrackSector = DISABLED_SECTOR,
): EnrichedAircraft | null {
  // ... unchanged body up to azimuthDeg being computed ...

  // after `const slewOk = ...` and before the return, add:
  const inSector = inArc(azimuthDeg, sector);

  return {
    ...ac,
    azimuthDeg, elevationDeg, rangeM: range,
    reachable, sunSafe, slewOk, inSector, requiredSlewDps, estTrackSec,
  };
}
```

- [ ] **Step 5: Gate `isTrackable` + thread the sector through `scanAircraft`**

In `tb3-mcp/src/adsb-tools.ts`:

```typescript
// add to imports:
import { TrackSector, DISABLED_SECTOR } from "./track/sector.js";

// gate:
export function isTrackable(e: EnrichedAircraft): boolean {
  return e.reachable && e.sunSafe && e.slewOk && e.inSector;
}

// scanAircraft: append the sector param (disabled default) and pass it to enrich:
export function scanAircraft(
  snap: AdsbSnapshot, rig: Geodetic | null, R: Mat3 | null,
  cfg: Config, nowMs: number, p: ScanParams, sector: TrackSector = DISABLED_SECTOR,
): { error: string } | { aircraft: EnrichedAircraft[] } {
  if (!rig || !R) return { error: NOT_CALIBRATED };
  const maxRangeM = p.maxRangeKm * 1000;
  const enriched = snap.aircraft
    .map((a) => enrichAircraft(a, rig, R, cfg, nowMs, sector))
    .filter((e): e is EnrichedAircraft => e !== null)
    .filter((e) => e.rangeM <= maxRangeM)
    .filter((e) => !p.onlyTrackable || isTrackable(e))
    .sort((a, b) => a.rangeM - b.rangeM);
  return { aircraft: enriched.slice(0, p.limit) };
}
```

Add `inSector` to the compact `view()` object (mirror `reachable`/`sun_safe`/`slew_ok`): `in_sector: e.inSector,`.

- [ ] **Step 6: Run tests + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/enrich-sector.test.ts && npm test`
Expected: new tests PASS; full suite green (existing enrich/adsb tests don't pass a sector → `DISABLED_SECTOR` → `inSector:true` → no change).

- [ ] **Step 7: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/adsb/types.ts tb3-mcp/src/adsb/enrich.ts tb3-mcp/src/adsb-tools.ts tb3-mcp/test/enrich-sector.test.ts && git commit -m "feat(sector): inSector enrichment + isTrackable gate"
```

---

### Task 4: sector MCP tools + wire scan/track to the sector

**Files:**
- Create: `tb3-mcp/src/sector-tools.ts`
- Modify: `tb3-mcp/src/adsb-tools.ts` (`registerAdsbTools` gains a `sectorStore` param; `scan_aircraft` + `track_aircraft` pass `sectorStore.get()`)
- Test: `tb3-mcp/test/sector-tools.test.ts`

**Interfaces:**
- Consumes: `SectorStore` from `./sector-store.js`; `TrackSector` from `./track/sector.js`.
- Produces: `registerSectorTools(server: McpServer, sectorStore: SectorStore): void` registering `get_track_sector` + `set_track_sector`; `registerAdsbTools(..., sectorStore: SectorStore)` reads `sectorStore.get()` per call.

- [ ] **Step 1: Write the failing test** (the pure store-backed set/get semantics the tool wraps)

```typescript
// tb3-mcp/test/sector-tools.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SectorStore } from "../src/sector-store.js";
import { applySectorUpdate } from "../src/sector-tools.js";

const store = () => { const s = new SectorStore(join(mkdtempSync(join(tmpdir(), "st-")), "s.json")); s.load(); return s; };

describe("applySectorUpdate (the set_track_sector core)", () => {
  it("stores a valid sector and returns it", () => {
    const s = store();
    const r = applySectorUpdate(s, { startDeg: 300, endDeg: 60, enabled: true });
    expect(r).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
    expect(s.get()).toEqual({ enabled: true, startDeg: 300, endDeg: 60 });
  });

  it("rejects out-of-range bearings without persisting", () => {
    const s = store();
    expect(() => applySectorUpdate(s, { startDeg: -5, endDeg: 60, enabled: true })).toThrow();
    expect(() => applySectorUpdate(s, { startDeg: 0, endDeg: 400, enabled: true })).toThrow();
    expect(s.get().enabled).toBe(false);   // nothing persisted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector-tools.test.ts`
Expected: FAIL — `applySectorUpdate` not found.

- [ ] **Step 3: Implement `sector-tools.ts`**

```typescript
// tb3-mcp/src/sector-tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SectorStore } from "./sector-store.js";
import { TrackSector } from "./track/sector.js";
import { text } from "./tool-helpers.js";

const bearing = z.number().min(0).max(360);

// Validated set: bearings in [0,360]; throws (no persist) otherwise. A bearing
// of exactly 360 is allowed and normalized by inArc; the store keeps it as-is.
export function applySectorUpdate(
  store: SectorStore, args: { startDeg: number; endDeg: number; enabled: boolean },
): TrackSector {
  const parsed = z.object({ startDeg: bearing, endDeg: bearing, enabled: z.boolean() }).parse(args);
  const sector: TrackSector = { enabled: parsed.enabled, startDeg: parsed.startDeg, endDeg: parsed.endDeg };
  store.set(sector);
  return store.get();
}

const wire = (s: TrackSector) => ({ enabled: s.enabled, start_deg: s.startDeg, end_deg: s.endDeg });

export function registerSectorTools(server: McpServer, sectorStore: SectorStore): void {
  server.registerTool(
    "get_track_sector",
    { description: "Report the tracking azimuth sector (open arc of bearings tracking is restricted to). enabled=false means no restriction.", inputSchema: {} },
    async () => text(JSON.stringify(wire(sectorStore.get()))),
  );
  server.registerTool(
    "set_track_sector",
    {
      description: "Set the tracking azimuth sector — the OPEN arc (clockwise from start_deg to end_deg, true-north bearings) that tracking is restricted to. enabled=false disables the restriction. Planes outside the arc become untrackable; a track that leaves the arc holds.",
      inputSchema: {
        start_deg: bearing.describe("open-arc start bearing, degrees true north [0,360]"),
        end_deg: bearing.describe("open-arc end bearing, degrees (arc sweeps clockwise start->end; may wrap north)"),
        enabled: z.boolean().describe("false = no azimuth restriction"),
      },
    },
    async ({ start_deg, end_deg, enabled }) => {
      const s = applySectorUpdate(sectorStore, { startDeg: start_deg, endDeg: end_deg, enabled });
      return text(JSON.stringify({ ...wire(s), note: enabled ? "tracking restricted to the open arc" : "azimuth restriction off" }));
    },
  );
}
```

- [ ] **Step 4: Thread the sector store into `registerAdsbTools`**

In `tb3-mcp/src/adsb-tools.ts`, add `sectorStore: SectorStore` as the final param of `registerAdsbTools`, import `SectorStore`, and pass `sectorStore.get()` to the two `scanAircraft(...)` calls (in `scan_aircraft` and `track_aircraft`):

```typescript
import { SectorStore } from "./sector-store.js";

export function registerAdsbTools(
  server: McpServer, source: AdsbSource, follower: AdsbFollower,
  store: CalibrationStore, cfg: Config, session: TrackingSession, supervisor: SunSupervisor,
  sectorStore: SectorStore,
): void {
  // ... in scan_aircraft's handler:
  const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(), { ... }, sectorStore.get());
  // ... in track_aircraft's handler (same trailing arg):
  const res = scanAircraft(source.getSnapshot(), rig, R, cfg, Date.now(),
    { maxRangeKm: cfg.adsbMaxRangeKm, onlyTrackable: true, limit: 1000 }, sectorStore.get());
```

(`track_aircraft` already rejects any hex not in the `onlyTrackable` set, so an out-of-arc plane is refused with no extra code.)

- [ ] **Step 5: Run tests + full suite**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/sector-tools.test.ts && npm run build`
Expected: sector-tools tests PASS; tsc will fail to build until Task 6 updates the `registerAdsbTools` call site in `server.ts` and its test callers — that is expected here (this task changes the signature; Task 6 wires it). Run `npm test` after Task 6, not here. If you prefer a green build at each task, do Task 6's `server.ts`/`server.test.ts` signature update as the last step of this task instead — either is acceptable as long as the final state builds.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/sector-tools.ts tb3-mcp/src/adsb-tools.ts tb3-mcp/test/sector-tools.test.ts && git commit -m "feat(sector): get/set_track_sector tools + wire scan/track to the sector"
```

---

### Task 5: in-track auto-stop

**Files:**
- Modify: `tb3-mcp/src/track/session.ts`
- Test: `tb3-mcp/test/session-sector.test.ts` (new)

**Interfaces:**
- Consumes: `TrackSector`, `DISABLED_SECTOR`, `inArc` from `./sector.js`.
- Produces: `TrackingSession` constructor gains a trailing `sectorProvider: () => TrackSector = () => DISABLED_SECTOR`; `WaitReason` gains `"outside_sector"`.

- [ ] **Step 1: Write the failing test**

Read `test/tracking-sim.test.ts` first to reuse its device/store/scheduler harness (a fake device + a calibrated `CalibrationStore` + a manual scheduler). The test drives one target that is inside the arc, then one outside, and asserts the session holds with reason `outside_sector` for the outside one.

```typescript
// tb3-mcp/test/session-sector.test.ts  — adapt the harness to tracking-sim.test.ts's helpers
import { describe, it, expect } from "vitest";
// import the same fakes tracking-sim.test.ts uses (fake Device, calibrated store, manual Scheduler)
import { TrackingSession } from "../src/track/session.js";

describe("in-track azimuth-sector stop", () => {
  it("holds with reason 'outside_sector' when the target's bearing leaves the arc", () => {
    // Arrange: a calibrated session whose target is at a known azimuth. Build it
    // with a sectorProvider returning an arc that EXCLUDES that azimuth.
    // Use the same fake device/store/manual-scheduler construction as
    // tracking-sim.test.ts; pass the sectorProvider as the trailing ctor arg.
    // Feed a fix at a bearing outside the arc, run one tick.
    // Assert: session.status().state === "waiting" && reason === "outside_sector".
    // Then feed a fix INSIDE the arc, tick, assert it is no longer outside_sector.
    // (Concrete target coordinates + fake wiring come from the existing harness;
    //  the load-bearing assertion is the outside_sector hold.)
  });
});
```

Implementer: build this test concretely against `tracking-sim.test.ts`'s existing helpers — the assertion to pin is `status().reason === "outside_sector"` when the target is outside the provided arc, and NOT that reason when inside.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/session-sector.test.ts`
Expected: FAIL — `"outside_sector"` is not a `WaitReason`, and no sector check exists.

- [ ] **Step 3: Implement**

In `tb3-mcp/src/track/session.ts`:

```typescript
// imports:
import { TrackSector, DISABLED_SECTOR, inArc } from "./sector.js";

// WaitReason union — add the new value:
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "program_engaged" | "not_calibrated"
  | "device_busy" | "goto_failed" | "outside_sector";

// constructor — append the sector provider (default disabled keeps every
// existing caller/test behaviourally identical):
  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly sectorProvider: () => TrackSector = () => DISABLED_SECTOR,
  ) {}

// a small module helper (DRY with recordAim's azimuth math):
function enuAzimuthDeg(enuUnit: Vec3): number {
  let az = (Math.atan2(enuUnit[0], enuUnit[1]) * 180) / Math.PI;
  if (az < 0) az += 360;
  return az;
}
```

In `tick()`, immediately after the `const aim = targetAimAt(...)` / `if (!aim) { this.wait("target_stale"); return; }` guard and BEFORE the `reachablePanTilt` block, add:

```typescript
    // Azimuth-sector filter: if the target's bearing has left the open arc,
    // stop chasing it and hold (do not park). Reuses wait()'s stop path.
    if (!inArc(enuAzimuthDeg(aim.enuUnit), this.sectorProvider())) {
      this.recordAim(aim);
      this.wait("outside_sector");
      return;
    }
```

(Optionally refactor `recordAim` to call `enuAzimuthDeg` for its `azimuth` computation — DRY, and it keeps the two azimuth derivations identical. `Vec3` is already imported in session.ts.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npx vitest run test/session-sector.test.ts && npm test`
Expected: PASS; full suite green (existing session tests construct without a `sectorProvider` → disabled → `inArc` always true → no behavior change).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/track/session.ts tb3-mcp/test/session-sector.test.ts && git commit -m "feat(sector): in-track auto-stop (hold outside_sector when target leaves the arc)"
```

---

### Task 6: server wiring + config

**Files:**
- Modify: `tb3-mcp/src/config.ts`, `tb3-mcp/src/server.ts`
- Test: `tb3-mcp/test/config.test.ts` (extend), `tb3-mcp/test/server.test.ts` (update `buildApp` callers + tool-count)

**Interfaces:**
- Consumes: `SectorStore`, `registerSectorTools`.
- Produces: `buildApp(..., sectorStore: SectorStore)`; `main()` constructs the `SectorStore`, threads `() => sectorStore.get()` into the session and passes `sectorStore` to `buildApp`.

- [ ] **Step 1: Add `sectorFile` config + failing config test**

In `tb3-mcp/src/config.ts` add to the schema (near `calibrationFile`): `sectorFile: z.string().optional(),`. Add a `test/config.test.ts` case asserting it parses (mirror the existing `calibrationFile` test if present; otherwise assert `loadConfig(undefined, {}).sectorFile` is `undefined`). Match the file's existing `loadConfig` call shape.

- [ ] **Step 2: Update `buildApp` signature + wiring in `server.ts`**

```typescript
// imports:
import { SectorStore } from "./sector-store.js";
import { registerSectorTools } from "./sector-tools.js";

// buildApp — append sectorStore:
export function buildApp(
  device: Device, cfg: Config, store: CalibrationStore, session: TrackingSession,
  supervisor: SunSupervisor, source: AdsbSource, follower: AdsbFollower,
  sectorStore: SectorStore,
): Express {
  // ... inside the initialize branch, alongside the other register* calls:
  registerAdsbTools(server, source, follower, store, cfg, session, supervisor, sectorStore);
  registerSectorTools(server, sectorStore);
  // ...
}

// main() — construct the store, thread it to the session + buildApp:
  const sectorFile = cfg.sectorFile ?? join(homedir(), ".tb3-mcp", "sector.json");
  const sectorStore = new SectorStore(sectorFile);
  sectorStore.load();
  const session = new TrackingSession(device, cfg, store, Date.now, realScheduler, () => sectorStore.get());
  // ... build supervisor/follower/source as before ...
  const app = buildApp(device, cfg, store, session, supervisor, source, follower, sectorStore);
```

Import `realScheduler` from `./track/session.js` in `server.ts` (it is exported there) so the explicit 4th/5th ctor args are correct, or pass `Date.now, realScheduler` explicitly as shown.

- [ ] **Step 3: Update the `buildApp` test callers + tool-count**

In `tb3-mcp/test/server.test.ts`: every `buildApp(...)` call gains a trailing `new SectorStore(<tmp path>)` (loaded), and the registered-tool-count assertion increases by **2** (`get_track_sector`, `set_track_sector`). Grep the test for the current expected count and bump it; grep for `buildApp(` to find all call sites.

- [ ] **Step 4: Run the full suite + build**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npm run build && npm test`
Expected: tsc clean; full suite green (tool-count updated). This is where Task 4's signature change becomes green end-to-end.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/config.ts tb3-mcp/src/server.ts tb3-mcp/test/config.test.ts tb3-mcp/test/server.test.ts && git commit -m "feat(sector): wire SectorStore into the daemon + register sector tools"
```

---

### Task 7: dashboard compass-ring widget

**Files:**
- Modify: `tb3-mcp/src/dashboard/client.ts`, `tb3-mcp/src/dashboard/controls.ts`, the dashboard server route file (grep `runAction`/`/api/control/` under `src/dashboard/`), `tb3-mcp/dashboard/public/index.html`, `tb3-mcp/dashboard/public/app.js`, `tb3-mcp/dashboard/public/style.css`

**Verification:** on-host manual (vanilla JS, no automated E2E — same convention as the rest of the dashboard). `npm run build` must stay clean and `npm test` green (the TS changes to client/controls are type-checked; the widget is untested JS).

This task wires the sector end to end through the dashboard, following the existing control pattern (`jog` / `calibrate/*` are the reference: a `McpDashboardClient` method → a `ControlDeps` method → a `runAction` case → a POST from `app.js`).

- [ ] **Step 1: Add client methods** — in `src/dashboard/client.ts`, mirroring `getSun`/`jog`:

```typescript
const TrackSectorZ = z.object({ enabled: z.boolean(), start_deg: z.number(), end_deg: z.number() });

async getTrackSector(): Promise<{ enabled: boolean; startDeg: number; endDeg: number }> {
  const b = TrackSectorZ.parse(JSON.parse(await this.call("get_track_sector", {})));
  return { enabled: b.enabled, startDeg: b.start_deg, endDeg: b.end_deg };
}
async setTrackSector(startDeg: number, endDeg: number, enabled: boolean): Promise<void> {
  await this.call("set_track_sector", { start_deg: startDeg, end_deg: endDeg, enabled });
}
```

- [ ] **Step 2: Add a control action** — in `src/dashboard/controls.ts`, add to `ControlDeps`:

```typescript
  getTrackSector(): Promise<{ enabled: boolean; startDeg: number; endDeg: number }>;
  setTrackSector(startDeg: number, endDeg: number, enabled: boolean): Promise<void>;
```

and a `runAction` case:

```typescript
      case "sector/set":
        await d.setTrackSector(num(body.start_deg), num(body.end_deg), body.enabled === true);
        return { ok: true, message: "tracking sector set" };
```

Wire the two new `ControlDeps` methods to the `McpDashboardClient` in the dashboard server file where `ControlDeps` is constructed (grep for the object that provides `track`/`jog`/`solveCalibration`). Expose the current sector to the frontend either by adding it to the state snapshot the SSE poller builds (preferred — add a `getTrackSector` read to the `collect()` set and a `sector` field on `DashboardState`) OR via a `GET /api/sector` route. The simpler path for a rudimentary widget: a `GET` route returning `client.getTrackSector()`; the plan leaves the exact placement to match the dashboard server's existing route style, but the widget must be able to (a) read the current sector on load and (b) POST `sector/set` on change.

- [ ] **Step 3: Build the compass widget** — in `dashboard/public/index.html` add a container near the tracking panel; in `app.js` render an SVG compass ring (N up, E right) with:
  - the **open arc** drawn as a shaded wedge from `startDeg` to `endDeg` (clockwise; handle the north-wrap case by splitting the wedge at 0° when `start > end`),
  - two draggable handles at `startDeg` and `endDeg` (pointer events → bearing = `atan2` of the pointer relative to center, converted to compass degrees),
  - numeric readouts of the two bearings and an **enable** checkbox,
  - on load: `fetch` the current sector and render it; on drag-end / checkbox change: `POST /api/control/sector/set` with `{ start_deg, end_deg, enabled }` (debounced), using the same control-POST helper `app.js` already uses for jog/calibrate.
  Style the ring/handles/wedge in `style.css`. The trackable list already reflects `isTrackable`, so no list code changes.

- [ ] **Step 4: Verify build + suite, then manual on-host**

Run: `cd tb3-mcp && export PATH="/Volumes/ExtData/homebrew/bin:$PATH" && npm run build && npm test`
Expected: tsc clean; suite green (no new automated tests here; the client/controls types compile).
On-host manual (document as the verification, not code): the widget renders, dragging updates + persists the arc (survives a daemon restart), out-of-arc planes leave the trackable list, and an active track holds when its plane crosses the boundary.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/ExtData2/coding/TB3-ESP32 && git add tb3-mcp/src/dashboard/client.ts tb3-mcp/src/dashboard/controls.ts tb3-mcp/dashboard/public tb3-mcp/src/dashboard && git commit -m "feat(sector): dashboard compass-ring sector widget"
```

---

## Self-Review

**Spec coverage:** Model/`inArc` → Task 1. Persistence (separate store) → Task 2. `inSector` enrichment + `isTrackable` gate (drops from list + refuses `track_aircraft`) → Task 3. `get/set_track_sector` tools + scan/track wiring → Task 4. In-track auto-stop (hold, not park) → Task 5. Config + server wiring + tool-count → Task 6. Compass-ring dashboard widget → Task 7. Wraparound + zero-width + disabled-default all covered in Task 1 tests. Error handling (corrupt file → default, out-of-range → tool error) → Tasks 2, 4. Every spec section maps to a task.

**Placeholder scan:** Task 5 Step 1 and Task 7 Step 3 are intentionally described against the existing harness/patterns rather than transcribed line-for-line — the tracking-sim fake wiring and the dashboard's control-POST helper are load-bearing existing code the implementer must read and match; the concrete assertions (`reason === "outside_sector"`; read-on-load + POST-on-change) are explicit. All daemon logic steps carry complete code.

**Type consistency:** `TrackSector {enabled,startDeg,endDeg}`, `DISABLED_SECTOR`, and `inArc(azDeg, sector)` are defined once (Task 1) and consumed by name in Tasks 2–6. `EnrichedAircraft.inSector` (Task 3) is set by `enrichAircraft` and read by `isTrackable`. The wire shape is consistently snake_case (`start_deg`/`end_deg`/`enabled`) at the tool/HTTP boundary and camelCase (`startDeg`/`endDeg`) in TS. `sectorProvider: () => TrackSector` (Task 5) is fed `() => sectorStore.get()` (Task 6). `registerAdsbTools`'s new trailing `sectorStore` param (Task 4) is supplied by `buildApp` (Task 6).
