# TB3 Ops Dashboard Redesign — Design

**Status:** design, approved 2026-07-28. Follows the MediaMTX/WebRTC transport work
(`docs/superpowers/specs/2026-07-26-mediamtx-webrtc-design.md`) and the drift-calibration,
joystick, and travel-limit features added on `feat/mediamtx-webrtc`.

## Problem

The dashboard accreted. Each feature was added on its own merits — camera, jog, tracking,
ADS-B list, radar, sector, sun guard, capture status, rig view, video stats, joystick,
calibration — and nobody stepped back. The operator's verdict, in the field:

> "we need to re-visit the entire UI there are so many functions now not clear"

Two concrete failures behind that:

1. **Roughly half the daemon's 32 MCP tools have no dashboard control at all.**
   Missing entirely: `characterize_imu`, `set_north_zero`, `teach_limit`,
   `get_taught_limits`, `clear_taught_limits`, `set_home`, `track_aircraft`,
   `point_at`, `goto_angle`, `capture_snapshot`, `start_recording`, `stop_recording`,
   `set_capture_mode`, `list_programs`, `select_program`. The operator asked directly
   how to trigger `teach_limit` and `set_home` — the answer was "you can't, from the UI."
   Notably `track_aircraft` is missing, which is the *first step* of the drift-calibration
   procedure the operator designed.

2. **Calibration is now a multi-step procedure with real dependencies, presented as a
   flat pile of buttons.** Get the order wrong and it fails in ways that aren't obvious.
   Nothing tells you `set_north_zero` needs `characterize_imu` first, or that solving
   needs two sightings that are ≥20° apart.

## Context: the operator's actual workflow

Established during field bring-up 2026-07-27/28. Landmarks are unavailable at the site,
so calibration runs off aircraft:

```
rig location → characterize_imu → set_north_zero
                                       ↓  (provisional orientation; tracking possible)
                        track a plane → trim to centre → sight
                                       ↓  (×2, well separated)
                                  solve_calibration
```

The trim step exists because a plane crosses a zoomed field of view in ~2 seconds, which
is unusable by hand. Once *tracking*, the rig slews with the plane and it becomes nearly
stationary in frame, giving the whole pass to centre it. **The operator must see the video
throughout.** This is the constraint that rules out a mode-switching design.

## Scope

**In scope:** a re-layout of `dashboard/public/` around operator tasks; a Setup drawer
containing guided procedures; splitting `app.js` (1463 lines) and `style.css` (1016 lines),
both past the project's 800-line ceiling.

**Which currently-missing tools get UI, and where** — stated explicitly, because "add the
missing controls" is otherwise ambiguous:

| Tool | Home | Rationale |
|---|---|---|
| `track_aircraft` | Cockpit — aircraft row `[Track]` | First step of the calibration workflow; its absence is the operator's immediate blocker |
| `characterize_imu` | Setup → Calibration step 2 | Procedure step with prerequisites |
| `set_north_zero` | Setup → Calibration step 3 | Procedure step; requires step 2 |
| `teach_limit`, `get_taught_limits`, `clear_taught_limits` | Setup → Travel limits | Procedure, four edges |
| `set_home` | Setup → its own entry, with confirmation | Destructive; clears calibration *and* limits |
| `capture_snapshot` | Cockpit — `[snap]` in the CAM block | One-press action during observation |
| `start_recording` / `stop_recording` / `set_capture_mode` | Cockpit — CAM block | Adjacent to the existing capture-status chip |

**Deliberately given no UI:** `point_at`, `point_at_azel`, `goto_angle` — jog, the
joystick, and `[Track]` already cover every way an operator aims, and absolute-angle entry
is an MCP/automation affordance, not an operator one. `list_programs` / `select_program` —
unused, no demand. `get_*` read-only tools — their data already reaches the UI via SSE.

**Out of scope (YAGNI):** any change to daemon behaviour, tools, or gating — this is a
re-layout, not a re-plumb; phone/tablet optimisation (operator confirmed desktop-first);
theming.

## Approach

Three approaches were weighed:

- **Modes (Fly / Calibrate / Observe)** — cleanest screens, but hides the video during
  calibration, which is precisely when the operator needs to see the plane being centred.
  **Rejected on that alone.**
- **Regroup in place, nothing hidden** — least disruptive, but leaves calibration as a
  pile of buttons that can't express step order or prerequisites.
- **Cockpit + procedures drawer** — chosen.

The organising insight: the 32 tools divide into two kinds of thing that want opposite
treatment.

| | examples | wants |
|---|---|---|
| **Continuous** | video, radar, rig view, telemetry, tracking, E-STOP | always visible, at a glance |
| **Procedural** | calibration, teach limits, set home, IMU sweep | a guided sequence you enter and leave |

Today both sit in the same visual register. That is the root cause of "so many functions."

## Layout — the cockpit

```
┌────────────────────────────────────────────────────────────────────────┐
│  TB3   [PROVISIONAL]  rig ●  sun ●  svc ●        [Setup ▾]   [E-STOP]  │
├──────────────┬─────────────────────────────────────┬───────────────────┤
│  AIRCRAFT    │                                     │   RIG VIEW        │
│              │                                     │   pose + travel   │
│ UAL123  47°  │           VIDEO                     │   envelope        │
│   31°  8.2km │        crosshair + stats            ├───────────────────┤
│  [Track][○]  │                                     │   RADAR           │
│              │                                     │   az / range      │
│ DAL540 106°  │                                     ├───────────────────┤
│   14° 41.7km ├─────────────────────────────────────┤   TELEMETRY       │
│  [Track][○]  │  AIM   ◀ ▲ ▼ ▶   [joystick ●]       │   pan/tilt  batt  │
│              │  TRIM  +1.8 / −0.4    [clear]       │   IMU  age        │
│              │  CAM   [on] [snap]  capture: REC    │   services        │
└──────────────┴─────────────────────────────────────┴───────────────────┘
│  errors / toasts                                                       │
└────────────────────────────────────────────────────────────────────────┘
```

**Video is the centre of gravity.** Framing, trimming and sighting are all *looking at
that image*. It gets the space and it never disappears, including during procedures.

**The aircraft list is the action surface.** Each row carries inline `[Track]` and
`[Sight]`. Selecting a plane and acting on it are currently disconnected; this closes that
and supplies the missing `track_aircraft` control.

**E-STOP is fixed furniture** — top-right, always, never scrolled, never covered by the
drawer or strip, never repositioned between states. Its location must be hittable without
looking.

**The AIM block changes meaning with tracking state** — direction controls drive the rig
when idle and the trim offset when tracking — with the active mode named on screen and the
live offset shown beside it. That number is the measurement being taken, so it is displayed,
not hidden.

Moved out of the cockpit into Setup: **Track Sector** (a policy set once a session, whose
compass widget occupies prime space) and the **joystick mapping/deadzone** panel. Both move
**as-is** — the existing sector compass and joystick diagnostic panel are relocated, not
redesigned or reimplemented. Only their home changes.

## The Setup drawer

Holds Calibration, Travel limits, Set home, Track sector, Joystick.

Procedures split by whether they need the video:

```
CONFIG steps   →  in the drawer, full width
AIMING steps   →  drawer collapses to a slim strip over the live cockpit
```

Calibration, with prerequisites made visible:

```
CALIBRATION                                    [PROVISIONAL]
 1  Rig location        33.3832, −112.1413, 341m       [edit]     ✓
 2  IMU characterised   rms 1.4°                       [redo]     ✓
 3  North zero          heading set from pointing      [redo]     ✓
    ── tracking now possible ──
 4  Sighting 1          QXE2320  brg 330° el 35°                  ✓
 5  Sighting 2          needs a plane ≥20° away        [start] ←  now
 6  Solve               needs 2 sightings              (blocked)
```

Steps 1–3 run in the drawer. Starting step 4 or 5 collapses it to:

```
┌──────────────────────────────────────────────────────────┐
│ SIGHTING 2   trim the plane to centre    +1.8 / −0.4     │
│              DAL540                [Sight it]  [cancel]  │
└──────────────────────────────────────────────────────────┘
```

Full cockpit live beneath. Trim by stick or arrows, watch the plane centre, press Sight it.

**Teach limits** follows the same pattern: config in the drawer, then a strip —
*"jog to the right-hand cable tension, then capture"* — with `[Set pan max here]`, once per
edge. Four independent edges.

The landmark path (`sight_landmark`) remains available as an alternative to steps 4–5.

**Blocked steps state their reason** — `needs 2 sightings`, `needs a plane ≥20° away` — not
merely a greyed control. Why a step is unavailable is the most useful thing this UI can say,
and it is exactly what is missing today.

**Destructive actions confirm explicitly.** `set_home` silently invalidates both the
calibration *and* the taught travel limits; today it is visually indistinguishable from any
other button. It gets a confirmation naming what it will clear.

The header badge (`UNCALIBRATED` / `PROVISIONAL` / `CALIBRATED`) is always visible, because
the meaning of almost every other control depends on it. `PROVISIONAL` must remain visually
distinct from `CALIBRATED` — it is a seed good enough to track from, and must never be
mistaken for a solve.

## State

Every displayed mode is **derived from daemon state already on the SSE stream** —
`calibration.calibrated`/`provisional`, `tracking.state`, `camera.source`, `estopLatched`,
`sunLocked`, `adsb.aircraft`, taught limits. No local flags that can drift from the rig.

The one necessary exception is *procedure position* (which calibration step is active),
which is UI-local. Each step's **completion**, however, is derived from daemon state, so a
refresh mid-procedure recovers rather than losing the operator's place.

## Safety

Carried over unchanged — this is a re-layout, not a re-plumb:

- E-STOP fixed in the header; never covered by drawer or strip; never repositioned by state.
- Every motion control keeps its existing gating: E-STOP latch, sun lock, travel limits,
  and the 5° trim clamp. All enforcement remains server-side.
- Trim clamp and travel-limit proximity stay visible while aiming — they are what prevent
  grinding the gears and what stop a bad offset being measured.
- Sun-guard and Auto toggles stay in the cockpit, not the drawer: they change rig behaviour
  and must not be two clicks deep.

## Files

`app.js` (1463 lines) and `style.css` (1016) are both well past this project's 800-line
ceiling; this work is the right moment to split them rather than after.

- New: a cockpit module and a procedures/drawer module, plus a pure step-gating module.
- Unchanged: the existing pure modules — `camera-panel.js`, `camera-mode.js`, `whep.js`,
  `video-stats.js`, `capture-label.js`, `jog-ramp.js`, `jog-hold.js`, `nudge-hold.js`,
  `joystick-math.js`, `joystick-hold.js`, `rigmath.js`, `minimap.js`. Their tests are a
  genuine regression guard across a large visual change.
- `dashboard/public/` stays vanilla ES modules, served static, **no build step**, no new
  dependencies.

## Testing

Layout cannot be unit-tested and this design does not pretend otherwise. What can be, and
must be:

- **Step gating** — a pure function from daemon state to `{done, available, blocked, reason}`
  per calibration step. This is where the real logic lives, and where a bug would silently
  permit solving on one sighting.
- **Mode derivation** — state → which controls are active and which label the AIM block
  shows (jog vs trim).
- **Destructive-action guards** — `set_home` requires confirmation, and the confirmation
  names what it clears.

All existing tests must pass unchanged. The pure modules are not changing, so that is a real
guard rather than a formality.

## Deployment risk

This is a large visual change landing on a branch under active field test, on top of ~15
unmerged commits. It should be built on **its own branch off `feat/mediamtx-webrtc`**, so
the operator can fall back to the working dashboard by switching branches rather than
unpicking commits mid-session.
