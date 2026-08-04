# Calibration Fixes and Runtime Tuning — Design

**Date:** 2026-08-04
**Status:** Approved for planning

## Problem

Two defects took a working rig apart in the field this morning, and a third made
them unrecoverable without a restart.

**1. `set_north_zero` discards a solved `cHead`.** `setProvisionalOrientation`
writes `cHead: undefined`, on the reasoning that a north-zero seed has no sighting
to solve a boresight from. But `cHead` describes the **camera's mounting on the
head** — a physical fact — while the orientation describes the **mount's rotation
into ENU**. Replacing the second says nothing about the first.

On this rig the camera is mounted ~31° off axis (`cHead = [0.415, 0.855, 0.310]`).
Running north-zero reverted it to the nominal `[0, 1, 0]`, so the rig began aiming
31° away from where the camera looks. Aircraft left the frame entirely.

**2. The aim-offset clamp is far smaller than the error it must correct.**
`maxAimOffsetDeg` defaults to **5°**. With `cHead` reverted, the operator needed
~31° of trim and could not reach it — the tool instructs the operator to trim, while
making the required trim impossible.

**3. Neither value is adjustable without editing config on the host and
restarting.** Every knob reached for during a field session today —
`maxAimOffsetDeg`, `calibVideoLatencyMs`, `trackLeadMs`, `captureTimeoutMs` — lives
in deploy config, so tuning any of them means SSH, an edit, and a daemon restart,
during which the rig is unavailable.

Separately, **`captureTimeoutMs` is set too tight for its own pipeline.** It defaults
to 4000 ms; measured snapshot duration is 1755–2217 ms, dominated by the wait for the
next keyframe at `-g 60` (one every 2 s at 30 fps). The margin is under 2×, so
snapshots fail intermittently — observed twice in three minutes — while succeeding
every time they are run by hand.

## Design

### Fix 1 — preserve `cHead` across a north-zero

`setProvisionalOrientation` keeps an existing `cHead` rather than clearing it.

The two quantities are independent: `cHead` is camera→mount, the orientation is
mount→ENU. Re-declaring which way is north cannot change how the camera is bolted to
the head. Preserving it is not merely convenient — it is the physically correct
answer, and clearing it asserts a boresight of zero that is known to be wrong.

If no `cHead` has ever been solved the behaviour is unchanged: absent, defaulting to
`[0, 1, 0]`.

### Fix 2 — raise the aim-offset ceiling and make it adjustable

Default `maxAimOffsetDeg` rises from **5° to 20°**, and it becomes runtime-adjustable
(below). The schema already permits up to 45°.

A larger clamp is not a safety relaxation: `nudge_aim_offset` is operator-driven one
press at a time, and the resulting motion is still bounded by `limitGuard` against
the taught travel limits. The clamp's job is to stop a runaway accumulating, not to
bound where the rig may point — that is the limits' job.

20° covers ordinary boresight trim. A first calibration on a badly-aligned camera may
still exceed it, which is what the adjustability is for.

### Fix 3 — a runtime tuning store

A new `TuningStore` at `~/.tb3-mcp/tuning.json`, following `LimitsStore` and
`SectorStore` exactly: Zod-validated, atomic tmp-then-rename writes, all fields
optional, absent means "use the config value".

```ts
maxAimOffsetDeg?: number      // 0 < x <= 45
calibVideoLatencyMs?: number  // 0 < x <= 5000
trackLeadMs?: number          // 0 <= x <= 5000
captureTimeoutMs?: number     // 0 < x <= 60000
```

**Resolution is at point of use, not at startup.** Each consumer asks the store for
its value when it needs it, falling back to config. That is what makes a change take
effect without a restart, and it is the whole point — a value you must restart to
change is not tunable during the session where you discover it is wrong.

Four call sites: the nudge clamp (`track/session.ts`), the sighting extrapolation
(`geo-tools.ts`), the tracking lead (`track/session.ts`), and the snapshot timeout
(`capture/snapshot.ts`).

MCP tools `get_tuning` and `set_tuning` expose it. `set_tuning` accepts a partial
object, validates, persists, and returns the resolved effective values — including
which came from tuning and which from config, so the operator can see what is
actually in force rather than what was requested.

### Fix 4 — capture defaults

`captureTimeoutMs` default rises **4000 → 10000 ms**, and the camera GOP shortens
from `-g 60` to `-g 30`.

The timeout change removes the intermittent failure. The GOP change halves the
worst-case keyframe wait, which shortens snapshot latency, reduces stream latency
generally, and — usefully — reduces the video-latency term that biases every aircraft
sighting.

### Dashboard

A **Tuning** entry in the existing Setup drawer, beside Calibration / Travel limits /
Set home / Track sector / Joystick. Vanilla ES modules, no build step, following the
existing drawer-entry pattern.

Each field shows its effective value, its source (tuned or config default), and its
valid range. Editing posts through the existing `/api/control/*` proxy to `set_tuning`.
A **Reset to default** control per field clears the override.

## Out of scope

**GPU MJPEG decode.** `ffmpeg` is at 148% CPU because the camera emits MJPEG and the
input has no `-hwaccel`, so decode and colour conversion run on the CPU while NVENC
handles only the encode. `mjpeg_cuvid` and the CUDA filters are available on the
installed build, so this is fixable — but verifying it requires taking the camera,
which cannot be done during a calibration session. Tracked separately.

## Testing

1. **`cHead` survives a north-zero.** Solve a calibration, assert `cHead` present, run `set_north_zero`, assert `cHead` is unchanged and pointing for an independent posture is preserved to the same tolerance. This is the regression that cost a field session.
2. **A north-zero with no prior `cHead`** still yields absent/nominal — the fix must not fabricate one.
3. **The nudge clamp honours the tuning store**: set it to 30, confirm a 25° nudge is accepted; set it to 5, confirm the same nudge clamps, and that the clamped result is reported rather than silently truncated.
4. **Every tuned value takes effect without a restart** — set through the store, observe the new value at the consuming call site in the same process. One test per call site; a value that only applies on restart fails the point of the feature.
5. **Absent tuning falls through to config**, and an out-of-range value is rejected without corrupting the stored file.
6. **`set_tuning` reports source per field** — tuned versus config default.
7. **Dashboard smoke**: the Tuning entry renders effective values and sources, and survives a value being absent.

## Rejected alternatives

**Editing `config.json` from the dashboard.** That file is deploy configuration,
under version control on the host and carrying load-bearing local edits. A UI that
rewrites it would fight the deployment and could silently drop hand-made changes. A
separate store keeps operator tuning and deploy config distinct.

**Requiring a restart after a tuning change.** Simpler, and wrong: the values worth
tuning are exactly the ones discovered to be wrong mid-session, and a restart
interrupts tracking and re-runs boot detection.
