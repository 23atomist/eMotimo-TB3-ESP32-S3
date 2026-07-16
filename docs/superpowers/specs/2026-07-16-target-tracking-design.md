# Target Tracking (Layer 3) — Design

**Status:** approved (2026-07-16)

**Goal:** Let an LLM command the TB3 to **follow a moving geographic target** — an aircraft, drone, or vehicle given as `lat / lon / height` with an optional velocity — keeping it in frame continuously rather than pointing at it once.

**Context:** This is layer 3, the final layer of the [three-layer LLM-control roadmap](2026-07-15-mcp-control-design.md). Layer 1 (`mcp-control`) provides the MCP daemon, `goto_angle`, `jog`, and a 5 Hz telemetry feed. Layer 2 (`geo-pointing`) provides the calibrated mount→ENU rotation `R` and `point_at`, which converts a geographic target into pan/tilt. Layer 3 closes the loop: it makes that pointing **continuous and self-correcting** against a target that moves.

**The problem:** `point_at` is a one-shot. Pointing at a moving target requires (a) a model of where the target *is* between fixes, (b) sustained rate control rather than discrete moves, and (c) a safety envelope — because this is the first layer that commands motion with **no human in the loop**, on a rig with **no endstops**.

---

## Architecture

Layer 3 **extends the same `tb3-mcp` daemon**, for layer 2's reasoning: the control loop's entire job is to read telemetry and command the rig, and both already live in this process.

**The genuinely new architectural element is a background control loop.** Everything in layers 1 and 2 is request-scoped — a tool call blocks to arrival and returns. Tracking is open-ended and must survive between tool calls, so layer 3 introduces the daemon's first continuously-running control element. (The 5 Hz telemetry subscription is the only other always-on component.) This is the layer's main architectural risk and should carry the most review attention.

### New modules

| Module | Responsibility | Depends on |
|---|---|---|
| `src/track/estimator.ts` | Target state: last fix + velocity; extrapolate to time `t` (pure) | geo/wgs84, geo/vec3 |
| `src/track/control.ts` | Control law: (rig pointing, target direction + angular rate) → joystick vector (pure) | geo/*, config |
| `src/track/session.ts` | State machine, tick loop, safety gates, re-acquire | estimator, control, device |
| `src/track-tools.ts` | The four MCP tools | session, calibration |

### Layer-1 refactor: a sticky jog vector

`device.jog(x, y, aux, durationMs)` today **blocks** for its duration, re-sending the joystick vector at 10 Hz, then zeroes it. A servo needs a rate it can update continuously.

`Device` gains a single owned `currentJogVector` plus **one** keep-alive timer, exposed as `setJogVector(x, y, aux)` / `clearJog()`. The existing timed `jog` tool is reimplemented on top of it (set, wait, clear). One keep-alive owner — no duelling timers.

### Arbitration

- `goto_angle` and `jog` while a session is active → refused (`"tracking active; stop_tracking first"`).
- `stop` always wins: it kills the session and clears the jog vector, consistent with layer 1.

### Data flow

```
start_tracking / update_target
        │
        ▼
  [estimator]  last fix + velocity, extrapolated to now + lead
        │
        ▼  target ENU direction + pan/tilt angular rate
  [control]  rate = feedforward + Kp·error ──◀── rig pan/tilt (telemetry steps → R)
        │
        ▼  joystick vector (TTL-stamped)
  device.setJogVector() ──▶ 10 Hz keep-alive ──▶ /ws
```

---

## Target estimator

Pure. Holds the last fix (`lat, lon, height, t_fix`) and a velocity, and extrapolates with a **constant-velocity model in the rig's ENU frame** (the rig's location is already known from layer 2's calibration profile). The fix is converted to ENU once via layer 2's `geodeticToEcef` + ENU rotation; extrapolation is then linear in ENU.

Straight-line ENU is an excellent model at this scale: a 300 mph target over a 10 s extrapolation covers ~1.3 km, across which earth curvature drops ~0.13 m — far below any achievable pointing accuracy.

**Velocity sources**, in precedence order:
1. Stated by the client (`speed_mps` + `heading_deg` + `climb_mps`), converted to an ENU vector.
2. Finite-differenced from two successive fixes.
3. Zero (stationary target).

---

## Control law

### Feedforward

Because we have an analytic target model **and** a calibrated `R`, the required slew rate is *known*, not inferred. The pan/tilt angular rate is obtained by finite-differencing the estimator across a small δ:

```
rate_ff = (panTilt(t + δ) − panTilt(t)) / δ
```

This is deliberate over hand-deriving the closed-form Jacobian. The estimate is **noiseless by construction** — a smooth analytic function, not a sensor reading — so there is no noise for differencing to amplify, and it avoids a chunk of error-prone math and test surface. It is a first-order approximation rather than exact (pan/tilt is a nonlinear `atan2`/`asin` of a linearly-extrapolated position), but at δ = 10 ms the error is negligible against realistic target dynamics. The closed-form Jacobian remains available if a future need arises.

### The law

```
rate  = rate_ff + Kp · error
error = target pan/tilt − rig pan/tilt      (rig from telemetry; pan wrapped to ±180°)
```

Then `|rate|` is clamped to `maxJogDps` per axis and mapped to joystick deflection using **layer 1's existing jog mapping, unchanged**.

Pan error is wrapped to `(−180, 180]` so the rig always takes the short way round. That half-open interval matches `mountToPanTilt`'s `atan2`, keeping one angle convention across the codebase.

### P, not PID — deliberately

Feedforward does the heavy lifting, so the proportional term only cleans up residual bias. An integral term would fight the feedforward and wind up against the limits; a derivative term on an open-loop step count amplifies noise without adding information. If measurement later reveals a persistent offset, an integral term can be added **then, for a reason**.

### Lead

The estimator is evaluated at `now + trackLeadMs` (default 150 ms) to cover command latency and rig lag. This is free, since velocity is already in hand.

### Measured pointing error

Every tick, the true angular separation between where the rig points and where the target is — both as ENU unit vectors, via layer 2's `angleBetweenDeg` — is computed and reported. This scalar is the layer's primary deliverable: v1 does not commit to an accuracy figure, it **measures and reports** what the hardware can actually hold, and a real target is set for v2 from that evidence.

---

## Safety envelope

This is the first component in the stack that commands **sustained motion with no human in the loop**, on a rig with **no endstops**. It warrants the heaviest review.

Every gate is evaluated each tick, before any rate is commanded:

- **Soft limits.** The session owns this, because the jog path does not enforce them. The check is on the **predicted** position, not the current one: if the commanded rate would carry an axis beyond `[panMin, panMax]` / `[tiltMin, tiltMax]` within the next tick plus a stopping margin, that axis' rate is zeroed. Enforced per-axis — pan may hold at a limit while tilt continues tracking.
- **Stale telemetry → stop.** A servo without feedback is a runaway. No telemetry for `trackStaleTelemetryMs` (default 1000 ms, ~5 missed ticks) → zero the rate, enter `waiting`.
- **Stale target → stop.** No fix within `trackMaxTargetAgeMs` (default 5000 ms) → stop, enter `waiting`. Extrapolating a stale fix indefinitely means confidently pointing at a fiction; the extrapolation horizon must be bounded.
- **Deadman → end session.** Silence for `trackDeadmanMs` (default 120000 ms) ends the session outright, so a forgotten session cannot lurk and lurch back into motion when a stray update lands.
- **Program engaged → stop.** If the physical operator enters a built-in program, the rig is being driven elsewhere; the session yields.
- **Rate clamp.** `|rate| ≤ maxJogDps` per axis, always.
- **`stop` always wins**, consistent with layer 1.

### The sticky-rate failure mode

The most dangerous failure available to this design is **a sticky rate plus a dead loop**: if the control loop throws, stalls, or the daemon wedges *after* setting a jog vector, the rig slews until something breaks. A `try/catch` in the session is insufficient — it cannot fire if the event loop stalls.

The defense therefore lives in **`Device`, where the hazardous state actually is**. `setJogVector()` stamps the vector with a TTL (`jogVectorTtlMs`, default 500 ms). The keep-alive timer refuses to re-send a vector older than its TTL and zeroes it instead. The session must keep proving it is alive for the rig to keep moving.

A session crash, an unhandled rejection, an event-loop stall — all converge on "the rig stops." This mirrors the firmware's own joystick keep-alive: the component holding the hazard is the component that times it out.

---

## MCP tool surface

Four new tools alongside layers 1 and 2.

**Contract change:** every layer-1/2 tool blocks to arrival and returns a result. These return **immediately** — tracking outlives the call, and the client polls `get_tracking_status`. This deliberately breaks the daemon's existing convention and must be documented in the README.

| Tool | Args | Returns / effect |
|---|---|---|
| `start_tracking` | `lat, lon, height_m, speed_mps?, heading_deg?, climb_mps?, label?` | Requires a solved layer-2 calibration. Seeds the fix, acquires with a goto, starts the servo. Returns session state immediately. |
| `update_target` | `lat, lon, height_m, speed_mps?, heading_deg?, climb_mps?` | Feeds a new fix; refreshes the deadman. |
| `stop_tracking` | — | Ends the session, clears the jog vector. |
| `get_tracking_status` | — | State, target az/el/range, rig pan/tilt, **pointing error (°)**, commanded rates, data staleness, and the waiting reason if applicable. |

Velocity is stated aviation-naturally (`speed_mps`, `heading_deg`, `climb_mps`) and converted to ENU internally — an LLM reasons about "450 knots heading 270" far more reliably than an ENU vector. All three are optional; omitted → derived from successive fixes → zero. SI units throughout, matching `height_m`.

### Session state machine

```
stopped ──▶ acquiring ──▶ tracking ⇄ waiting        (any state ──▶ stopped)
```

| From | To | Trigger |
|---|---|---|
| `stopped` | `acquiring` | `start_tracking` |
| `acquiring` | `tracking` | goto arrived; target reachable and fresh |
| `tracking` | `waiting` | any safety gate trips (limit / stale telemetry / stale target / program engaged) |
| `tracking` | `acquiring` | pointing error > `trackReacquireDeg` (catch up with a goto rather than rate-crawl) |
| `waiting` | `acquiring` | target reachable **and** fresh again (auto-reacquire) |
| *any* | `stopped` | `stop_tracking`, the `stop` tool, or deadman expiry |

Both re-entries into `acquiring` funnel through the same goto-based acquisition. Note the two distinct error quantities: the **control error** is per-axis (pan and tilt separately, feeding the proportional term), while the **pointing error** driving `trackReacquireDeg` and reported by `get_tracking_status` is the true angular separation between boresight and target.

- **`acquiring`** — the initial or catch-up goto. A large error is better closed by an accel-limited coordinated move than by rate-crawling.
- **`tracking`** — the servo is running.
- **`waiting`** — motion stopped, target still being estimated, carrying a machine-readable reason: `below_tilt_limit`, `pan_limit`, `target_stale`, `telemetry_stale`, or `program_engaged`. Auto-reacquires when the target is both reachable and fresh again.
- **`stopped`** — no session.

Input validation (zod at the tool boundary) reuses layer 2's conventions: `lat ∈ [−90, 90]`, `lon ∈ [−180, 180]`, `height_m` within the shared sane band, all finite.

---

## Configuration

New keys, all with defaults and env overrides, following layer 1/2 conventions:

| key | default | meaning |
|---|---|---|
| `trackTickHz` | `10` | control loop rate |
| `trackKp` | `1.0` | proportional gain (°/s of rate per ° of error) |
| `trackLeadMs` | `150` | lead time to cover command + rig latency |
| `trackMaxTargetAgeMs` | `5000` | fix older than this → stop and wait |
| `trackStaleTelemetryMs` | `1000` | telemetry older than this → stop and wait |
| `trackDeadmanMs` | `120000` | total silence before the session ends outright |
| `trackReacquireDeg` | `10` | pointing error above which the session drops back to `acquiring` |
| `jogVectorTtlMs` | `500` | keep-alive refuses to re-send a vector older than this |

---

## Testing strategy

A real-time control loop is a flaky-test factory unless designed against.

**Inject the clock and the scheduler.** The session takes a `now()` function and a tick scheduler rather than reaching directly for `Date.now()` / `setInterval`. Tests drive time explicitly instead of sleeping. This is what makes the tests below deterministic, and it matches the codebase's established bias toward pure, injectable units.

**Pure unit tests:**

- **`estimator`** — extrapolate a known position + velocity against hand-computed ENU truth; zero velocity holds position; velocity correctly derived from two successive fixes.
- **`control`** — zero error + moving target ⇒ pure feedforward; static target + error ⇒ pure proportional; **pan wraparound** (rig at 179°, target at −179° ⇒ error +2°, not −358°); clamp saturates at `maxJogDps`.
- **Safety gates** — each in isolation: predicted-limit stop (per-axis), stale telemetry, stale target, deadman, program-engaged.
- **TTL watchdog** — set a vector, never refresh it, advance time, assert `Device` zeroes the vector and stops. **The single most important test in this layer.**
- **Session state machine** — transitions under an injected clock: `acquiring → tracking → waiting → acquiring → tracking`, and `stop` from every state.

**Closed-loop simulation (highest value).** The mock TB3 already simulates motion for `goto`. Extend it to **integrate the jog vector into its step counters**, so a commanded rate actually moves the mock. Then fly a synthetic target along a known track, run the real session and real control law against the mock, and assert **pointing error stays bounded across the whole pass**. This proves the controller end-to-end in software with no hardware, and exercises the same error metric that `get_tracking_status` reports.

**Hardware validation** is the final step, in the order given under Risks below.

---

## Risks and open items

1. **Task 0 — verify the jog path on hardware before building on it.** Layer 1's `/api/goto` hang was caused by `DFSetup()` never running from the boot menu, leaving motor motion params at zero and the move planner producing `NaN`. The joystick/jog path may carry the **same uninitialized-params exposure**, depending on which screen the device sits on — and the entire layer-3 servo rides that path. Sustained jog-from-boot-menu must be verified on hardware **first**, as an explicit task, rather than discovered at integration. If it is affected, the fix mirrors the goto fix (initialize motion params on the jog path) and belongs in layer 3's firmware scope.

2. **Layer 3 inherits layer 2's unvalidated calibration.** Any heading error in `R` appears directly as pointing error. Hardware validation order must be: **validate layer 2's two-landmark calibration first, then layer 3.** Otherwise a tracking miss is ambiguous between a controller bug and a calibration bug. Layer 2's hardware calibration is still pending as of this spec (PR #3).

3. **Open-loop rate accuracy is unknown.** `maxJogDps` maps deflection to °/s only approximately (layer 1 documents this as best-effort and calibratable). The feedforward term is only as good as that mapping; the proportional term exists to absorb the residual. How well this works is exactly what the measured pointing error will tell us — hence the "measure and report" posture rather than a committed accuracy figure.

---

## Out of scope (this layer)

- **Any target source other than client-push.** The estimator is fed through a small source interface so a live feed (ADS-B, MQTT, HTTP) can be added as a second source later, but v1 ships **client-push only**: no external feeds, no aircraft-selection UX, no feed auth or rate limits.
- **Video-based tracking.** No processing of the camera feed and no visual servoing; the target's position comes from the client, not from pixels.
- **Multi-target tracking.** One session, one target.
- **Atmospheric refraction and lever-arm correction** — inherited as out of scope from layer 2.
- **An integral or derivative control term** — deliberately deferred until measurement justifies one.
