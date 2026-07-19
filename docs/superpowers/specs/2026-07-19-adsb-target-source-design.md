# Layer 4 — ADS-B Autonomous Target Source — Design

**Status:** approved design, pre-implementation
**Branch:** `feat/adsb-target-source` (off `main` @ a3fb1e1)
**Goal:** Turn real aircraft into moving targets for the existing Layer-3 tracking loop. The daemon becomes a great **ADS-B target source** an LLM can see through and act on; a host-side agent closes the loop by letting a local small LLM autonomously pick the **most interesting** trackable aircraft.

## Context

Layer 3 shipped **client-push only** with a deliberate **pluggable source + estimator** split: `TrackingSession.start(geodetic, velocity, label)` / `updateTarget(geodetic, velocity)` / `stop()` consume geographic fixes and drive a constant-velocity ENU estimator + feedforward-P rate servo, already guarded by pan/tilt limits, a sun-guard, telemetry-staleness and deadman timeouts. ADS-B provides exactly that payload (lat/lon/alt + ground speed + heading + climb), so L4 slots in as a **source** without touching the estimator, control law, or session.

The *judgment* of which aircraft to track ("most interesting") lives in an LLM, not in daemon code. The daemon computes only the hard, objective facts (reachable, sun-safe, within slew rate, still flying) and surfaces the raw signals (type, category, squawk, callsign, hex); the LLM applies interestingness over that already-safe set.

## Hardware reality (probed 2026-07-19)

Host `192.168.4.104` ("b", Debian 13, x86_64): **RTX 5080 Laptop GPU 16 GB** (CUDA), **AMD XDNA2 NPU** live (`amdxdna`, `/dev/accel/accel0`), cameras on host (`/dev/video0-3`), 32 GB RAM. **Not yet installed** (Phase-0 prerequisites): no RTL-SDR plugged in, no `dump1090`/`readsb`, no local LLM server (only `python3`). Everything for L4 co-locates on this host — daemon + LLM + dump1090 + (future) vision — so **no cross-machine hop** exists in any real-time loop.

## Architecture — two deliverables, both in the `tb3-mcp` repo

```
dump1090/readsb          ┌─────────────── tb3-mcp daemon (on the host) ───────────────┐
  aircraft.json  ──1Hz──▶│ AdsbSource → snapshot → AdsbFollower → session.updateTarget │──▶ L3 servo ──▶ rig
      (HTTP)             │                    ▲            │                             │
                         │         scan_aircraft │  track_aircraft(hex)                 │
                         └───────────────────────┼───────────────────────────────────── ┘
                                          MCP     │ (localhost)
                         ┌───────────────────────┴────────── host agent (on the host) ──┐
                         │ every N s: scan_aircraft + status → prompt local LLM →        │
                         │            {track hex | keep | stop} → apply (with hysteresis)│
                         └────────────────────────────────┬───────────────────────────── ┘
                                                    OpenAI-compat /v1/chat/completions
                                                    (llama.cpp, response_format json_schema)
```

The agent is an **MCP client** — the exact interface Claude would use — so the local-model path and a Claude-driven path are identical and swappable.

## Phase 0 — Prerequisites on the host (sequenced first, validated independently)

1. **RTL-SDR + ADS-B decoder.** Plug the dongle, confirm it enumerates (`lsusb`), install `rtl-sdr` + `readsb` (or `dump1090-fa`), serve `aircraft.json` over HTTP. **Exit criteria:** real traffic present in the JSON.
2. **Local LLM server.** Stand up `llama-server` (llama.cpp, CUDA on the 5080) or vLLM; pull a small instruct model (Qwen2.5-7B/14B GGUF fits 16 GB). **Exit criteria:** `/v1/chat/completions` with `response_format: json_schema` returns valid constrained JSON for a canned "pick the target" request.
3. **Daemon home.** The daemon runs on the host (reaches SDR + LLM over localhost, rig over LAN). Existing `tb3-mcp/deploy/` units apply.

These are environment setup — not code we author — but the plan sequences and gates on them.

## Daemon-side components (new, under `tb3-mcp/src/adsb/`)

### `source.ts` — `AdsbSource`
Polls the `aircraft.json` URL on the existing `Scheduler` seam (~1 Hz, `adsbPollHz`). A **pure `parseAircraftJson(raw): Aircraft[]`** normalizes the dump1090-fa/readsb dialect into a hex-keyed list, dropping aircraft with no position. `AdsbSource` exposes `start()`, `stop()`, and `getSnapshot(): { aircraft: Aircraft[]; fetchedAtMs: number; ok: boolean; error?: string }`. HTTP/parse failures degrade to `ok:false` (never throw into the loop).

Normalized `Aircraft` fields (all nullable except `hex`): `hex`, `callsign` (from `flight`, trimmed), `lat`, `lon`, `altBaroFt`, `altGeomFt`, `gsKt`, `trackDeg`, `baroRateFpm`, `geomRateFpm`, `category`, `squawk`, `seenPosSec`, `rssi`.

### `enrich.ts` — pure
`enrichAircraft(ac, rig, R, cfg): EnrichedAircraft`. Given one aircraft + rig geodetic + calibration `R` + limits, compute rig-relative **azimuthDeg / elevationDeg / rangeM** (via existing WGS84→ECEF→ENU math), plus the hard flags:
- **reachable** — pan/tilt inside `[panMin,panMax]`×`[tiltMin,tiltMax]` (reuses `reachablePanTilt`).
- **sunSafe** — outside the sun cone (reuses the sun position + angle math from the sun-guard layer).
- **slewOk** — predicted angular rate = tangential speed ÷ range < `maxJogDps`.
- **estTrackSec** — coarse estimate of how long it stays in-window (reachable ∧ sunSafe ∧ slewOk), from current position + velocity.

Pure and deterministic → fully unit-testable from known geometry.

### `follower.ts` — `AdsbFollower`
Holds the bound hex. `bind(hex)`, `unbind()`, `onSnapshot(snapshot)`, `status(): { hex: string|null; lostMs: number|null }`. On each snapshot: if the bound hex is present with a position, convert its fix (lat/lon/alt→`Geodetic` in the rig's datum; gs/track/climb→velocity `Vec3`) and call `session.updateTarget` (or `session.start` on first bind). If the hex is absent past `adsbLostSec`, mark it lost (the session's own `target_stale`/deadman then applies). Deterministic → unit-testable with a mock session.

### `adsb-tools.ts` — MCP tools
- **`scan_aircraft`** — params: `max_range_km?` (default `adsbMaxRangeKm`), `only_trackable?` (default true → reachable ∧ sunSafe ∧ slewOk), `limit?` (default 20). Returns the enriched list, filtered, sorted (proximity by default), capped. This is the LLM's "what's flying near me" view. It surfaces raw signals (type/category/squawk/callsign/hex) but **does not rank by interestingness**.
- **`track_aircraft`** — param: `hex`. Binds the follower and starts the session on that aircraft's current fix. Returns tracking status. Rejects a hex not currently in the trackable set.
- Reuse **`stop_tracking`** (extended to also `follower.unbind()`) and **`get_tracking_status`**.

### Wiring
`main()` constructs `AdsbSource` + `AdsbFollower`; `source.start()`; the poll pushes each snapshot to `follower.onSnapshot`. `registerAdsbTools(server, source, follower, session, cfg, store)`. `stop_tracking` unbinds the follower.

### New config (opt-in; Zod + file + env, matching `config.ts`)
`adsbEnabled` (default `false`), `adsbUrl` (aircraft.json URL), `adsbPollHz` (1), `adsbMaxRangeKm` (100), `adsbLostSec` (15), `adsbAltSource` (`auto`|`geom`|`baro`, default `auto`).

## Host-side agent (`tb3-mcp/src/agent/` — new process, TS/Node, MCP client)

Standalone `agent.ts` with `main()`, deployable on the host (own systemd unit). Connects to the daemon MCP endpoint via the MCP SDK `Client` + StreamableHTTP transport (localhost).

**Decide loop** every `agentTickSec` (~5 s):
1. `scan_aircraft` → trackable enriched set.
2. `get_tracking_status` → current target + health.
3. Build a compact prompt: the trackable list (hex, callsign, type/category, squawk, alt, gs, az/el, range, estTrackSec) + what is tracked now + the "most interesting" policy.
4. POST to the LLM with `response_format: json_schema` → `{ action: "track"|"keep"|"stop", hex?: string, reason: string }`.
5. **Deterministic guardrails around the model output** (where robustness lives):
   - **Hex validity** — reject a hex not in the current trackable set (hallucination → treat as `keep`).
   - **Switch hysteresis** — do not drop a healthy current target unless it is lost, or the model picks a different one *and* `agentMinDwellSec` (~25 s) has elapsed since the last switch. Prevents thrashing.
   - **Apply** — `track_aircraft(hex)` / do nothing / `stop_tracking`.
   - **Fail-safe** — LLM timeout/error/invalid JSON → keep current; stop only if current is already lost.

### Safety model — defense in depth
- The **daemon** owns the hard constraints: sun-guard, pan/tilt limits, slew ceiling, telemetry staleness, deadman. The LLM only ever sees the **already-safe** set (`only_trackable`), so it **cannot** select something dangerous or unreachable.
- The **agent** owns behavioral guardrails: hex validity, hysteresis, rate-limited switching, fail-safe.
- The **LLM is advisory**; deterministic code has the final say at both layers.

### Agent config
`agentMcpUrl`, `agentMcpToken?`, `llmUrl`, `llmModel`, `agentTickSec` (5), `agentMinDwellSec` (25), plus the system prompt encoding the "most interesting" policy (prefer heavies / unusual types / military hex ranges / emergency squawks 7500/7600/7700 / unusual callsigns; keep a good current target; avoid thrashing).

## Technical decisions

- **Altitude datum.** ADS-B altitude is in **feet** → convert to meters. Prefer **`alt_geom`** (WGS84 ellipsoidal — matches the rig's geodetic height datum); fall back to **`alt_baro`** with the known caveat (pressure altitude, MSL-ish not ellipsoidal, can differ by hundreds of feet). `adsbAltSource=auto` → geom-if-present-else-baro. Matters most for near/overhead aircraft, where altitude error maps directly into elevation angle; for distant traffic, slant range is horizontal-dominated.
- **Velocity.** `gs` (kt→m/s) + `track` (deg true) + `baro_rate`/`geom_rate` (ft/min→m/s) through the existing `velocityFromSpeedHeading`, so the estimator has a real velocity for good lead/extrapolation. Absent gs/track → pass `null`; the estimator derives velocity from successive fixes.
- **Interestingness stays in the LLM.** The daemon never ranks by "cool" — it surfaces the raw signals and the objective trackable flags. This is the entire point of the chooser design and keeps the daemon deterministic and testable.
- **Selection priority = "most interesting"** among the trackable set (heavies, unusual types, military hex, emergency squawks, unusual callsigns), tie-broken by proximity when type data is thin.

## Testing strategy

- **Daemon (vitest, deterministic):**
  - `parseAircraftJson` — real dump1090-fa/readsb JSON fixtures, including missing/partial fields and no-position aircraft.
  - `enrich` — known geometry → expected az/el/range and each hard flag (reachable/sunSafe/slewOk) at boundaries.
  - `follower` — mock session: first-bind `start`, subsequent `updateTarget`, velocity conversion, lost after `adsbLostSec`, switch on rebind, unbind on stop.
- **Agent (vitest):** decision-application logic with a mock MCP client + mock LLM returning canned JSON — hex validation, hysteresis (min-dwell), fail-safe on LLM error, correct track/keep/stop application. The LLM prompt/model itself is an integration smoke-test, not a unit test.
- **Integration / hardware:** real `aircraft.json` + real `llama-server` + the rig — the final on-host run. Phase-0 exit criteria (traffic flowing, constrained JSON returned) gate this.

## Success criteria

1. Daemon builds clean, `adsbEnabled` opt-in; with a live `aircraft.json`, `scan_aircraft` returns a correctly enriched, filtered, sorted trackable list, and `track_aircraft(hex)` drives the L3 servo to follow that aircraft (verified on the rig).
2. All hard safety constraints hold under L4: the follower/agent can never point at the sun, past a limit, or above the slew ceiling — the daemon rejects such targets before the LLM ever sees them.
3. The host agent runs the full autonomous loop on the host: local LLM picks the most interesting trackable aircraft, the rig follows, switching is hysteresis-damped (no thrashing), and LLM faults fail safe.
4. Daemon + agent unit suites green; no regression to the existing 217 tests.

## Out of scope (future layers)

- **Image confirmation / visual servoing (L5).** A vision module that verifies/refines pointing from the camera. L4 leaves a clean seam: it would add a pixel-offset→angle **bias** to the follower's aim, structurally like the sun-guard adds a constraint. On-host placement: XDNA2 NPU for an always-on detection gate, RTX 5080 for heavy work, CPU for glue. Not built here.
- Multi-target / multi-camera, recording/triggering the camera, historical replay, non-ADS-B sources (drones/marine AIS).

## Guardrails

- `adsbEnabled` defaults **false** — L4 is inert unless configured, so existing deployments are unaffected.
- The daemon's L1–L3 safety (limits, sun-guard, deadman, staleness) is authoritative and unchanged; L4 only *feeds* the session, never bypasses its guards.
- No changes to the firmware or the L1–L3 control path. No `any`; ESM `.js` imports; vitest `fileParallelism:false` — match the existing daemon conventions.
