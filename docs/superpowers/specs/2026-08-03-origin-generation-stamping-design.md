# Origin Generation Stamping — Design

**Date:** 2026-08-03
**Status:** Approved for planning
**Completes:** `2026-08-02-reboot-rezero-design.md`, `2026-08-03-rezero-frame-convention-design.md`
**Blocks:** merge of `feat/reboot-rezero`

## Problem

Twice now the same defect has shipped in this subsystem, and been caught only by a
reviewer running an experiment:

- **First:** Δtilt was measured against `imuMounting.dBase` (cumulative) while Δpan
  was measured against the live orientation (incremental), and both were applied as
  increments. Cycle 2 silently 2° wrong with the residual under the reject threshold.
- **Second (current blocker):** the frame convention says *every solve runs against
  the baseline*. That is true for pan and **false for tilt**. `solveTiltOffset`
  measures against `imuMounting.dBase`, whose origin is `characterize_imu`.
  `setOriginOffset` stores that number as an offset from `baseline`, whose origin is
  `solve_calibration`. They agree only if both artifacts were produced at the same
  step origin — an invariant nowhere stated, recorded, or enforced.

`setGravityCalibration` writes a new baseline and zeroes `originOffset` while
leaving `dBase` untouched, so re-solving in an already-offset frame desynchronises
them. Reproduced, solve → reboot → re-zero → **re-solve** → reboot → re-zero:

| first offset | result |
|---|---|
| −23.33° | `applied:false`, *"the tripod appears to have moved"* — hard lockout on a false diagnosis |
| −1.00° | `applied:true`, residual **0.04°**, pointing error **1.11°** — silently wrong |

The trigger is a one-click dashboard path: **Solve** is enabled whenever two valid
sightings exist, so "take better sightings and re-solve" requires no re-characterise.

**The shape is identical both times: two artifacts anchored to different step
origins, consumed as if they shared one.** The previous two specs each fixed one
instance. This one fixes the class.

## The generalisation

The rig has **five frame-dependent artifacts**, each meaningful only relative to the
step origin in force when it was produced:

| artifact | produced by | stamped today |
|---|---|---|
| `imuMounting` (`rS`, `dBase`) | `characterize_imu` | ✗ |
| `baseline` (`R0`, `cHead0`) | `solve_calibration` / `set_north_zero` | ✗ |
| `originOffset` | a completed re-zero | ✗ (implicitly current) |
| taught limit edges | `teach_limit` | ✓ `edgeBootId` |
| `landmark` | `set_landmark` | ✗ |

**Exactly one is stamped, and it is the only one that has stopped producing this
class of bug.** `edgeBootId` was introduced to fix the re-taught-edge regression and
has been correct since, including across a daemon restart.

**The rule: every frame-dependent artifact records the origin generation it was
produced under, and any code combining two artifacts reconciles their generations
explicitly rather than assuming they match.**

Stamping alone is not the fix — it is what makes the fix possible, and what makes a
future violation a loud failure instead of a silent 1° error.

## The tilt anchor

Stamping tells you *whether* two artifacts disagree. For the one place two anchors
genuinely combine, you also need to *reconcile* them.

Define `T(g)` = the tilt-reading offset of origin generation `g` relative to the
generation `characterize_imu` ran in. By construction `T(characterize_gen) = 0`, and
**`solveTiltOffset` always returns `T(current)`** — it measures against `dBase`, so
that is the quantity it computes, whatever the baseline is doing.

Record `baseline.tiltAnchorDeg = T(baseline_gen)`. Then:

```
originOffset.tiltDeg = solveTiltOffset(...) − baseline.tiltAnchorDeg
```

Today the code takes `solveTiltOffset(...)` directly, which is correct only while
`tiltAnchorDeg` happens to be 0 — i.e. only until the first re-solve after a re-zero.

Two writers must maintain it:

- **`solve_calibration` / `set_north_zero`** (writes a baseline at the current
  generation): read gravity at that moment, and set
  `tiltAnchorDeg = solveTiltOffset(...)`, with `originOffset = {0, 0}`.
- **`characterize_imu`** (re-anchors so `T(current)` becomes 0): every stored `T(·)`
  shifts by −`T_old(current)`, so `tiltAnchorDeg_new = −originOffset.tiltDeg`.
  Derive this in the implementation and pin it with a test rather than trusting the
  algebra here.

Pan needs no anchor: `solvePanOffset` measures against `R0`, so it already returns
an offset from the baseline's own origin.

## Failing loudly

A stamp mismatch that cannot be reconciled must refuse with a message naming the
actual cause. Today `"the tripod appears to have moved"` covers three distinct
situations — a genuinely disturbed tripod, a stale `rS`, and this frame mismatch —
and it sent the operator to re-level a tripod that was fine.

`geo-tools.ts` already computes `imuDisagreeDeg`, which is approximately the
cumulative Δtilt. It is surfaced only when `headingResidualDeg > 3`, and its comment
("`R_s` is stale") is now wrong: after a legitimate re-zero that disagreement is
*expected*. Rework it to consult the stamps instead of inferring from magnitude.

## Also in scope

Four findings from the same review, each cheap and safety-relevant.

**I-A — the guard is disarmed for the first 5–11 s after a daemon restart.**
`realScheduler.every` is `setInterval`, which first fires at `intervalMs`, so no
`observe()` runs until t+5 s, and the two-host `fetchDeviceUptimeMs` retry can push
detection to the second tick. In exactly the case the unobserved-reboot check exists
for, `calibration.json` still says `needsRezero:false`, so every gated tool runs on
the stale origin until the first tick lands. **Fix:** run one tick before
`app.listen()`.

**I-B — clearing pan limits removes cable protection from `characterize_imu`.**
`sweepPositionsFor` derives its waypoints from `effLimits()`, so with pan cleared and
the ±180° config ceiling it builds a ~354° pan sweep and drives it unattended.
Re-characterising after a reboot is a natural operator action. The clear-on-reboot
decision stands; its blast radius was not recorded. **Fix:** `characterize_imu`
refuses when pan is untaught and `needsRezero` is set, naming both conditions.

**I-C — the dashboard has no re-zero awareness at all** (`grep -rn "rezero"
dashboard/` returns nothing). The operator's primary surface shows a normally
calibrated rig while every automated motion tool refuses, pan limits are gone, and
sun protection is degraded. **Fix:** surface `needs_rezero`, the missing pan limits,
and the degraded sun guard, with the remediation. `SunSupervisor` stays ungated —
gating it removes sun protection rather than degrading it — but "documented in a tool
an operator must think to call" is not communication.

**M-1 — `bootId()` returns `0` when `boot.json` is missing or corrupt**, and `0` is
indistinguishable from a real generation. Reproduced: with `boot.json` lost, an edge
freshly taught under generation 5 was shifted from −70 to −103. **Fix:** an unknown
generation is a distinct value that means "do not shift", not a number.

**M-2 — `residual_deg` reads as an accuracy figure and is not one.** With one unknown
fitted to one constraint it is nearly blind to centring error: 0.132° reported for a
2.7°-wrong re-zero. Rename to `fit_residual_deg` and state in the tool description
that pointing accuracy equals centring accuracy.

## Explicitly out of scope

Everything both ledgers triaged as deferred: the CJS `require` in a test, gating tests
that infer from error text, `main()` and `rezero-tools.ts` length, the absent shutdown
path, `clearAxis` leaving a stamp behind, and the split "moving" messages. None
interacts with generation stamping.

## Testing

**The acceptance criterion is a test that exercises the production path**, because
that is the crack this defect fell through. The existing multi-cycle test builds
calibrations with `setBaseline` — which has **zero production callers** — and
hardcodes one `bootId`, so it never touches `setGravityCalibration` and never sees a
generation change.

1. **Re-solve after a re-zero.** solve → reboot → re-zero → **re-solve from fresh
   sightings** → reboot → re-zero. Assert pointing error < 0.1° and no false refusal.
   This fails on the current branch at the final step and is the headline test.
2. **Production-path multi-cycle.** Rewrite the existing acceptance test to establish
   its calibration via `setGravityCalibration`, and to advance `bootId` each cycle so
   `edgeBootId` reconciliation is genuinely exercised.
3. **`characterize_imu` re-anchor.** Re-characterise mid-sequence and confirm
   subsequent re-zeros stay correct — pinning the `tiltAnchorDeg = −originOffset.tiltDeg`
   derivation.
4. **Mismatch refuses loudly.** Force an unreconcilable stamp mismatch and assert the
   refusal names the frame mismatch, not the tripod.
5. **I-A:** a poller started with a device that has already rebooted marks
   `needsRezero` before any tool call can succeed.
6. **I-B:** `characterize_imu` refuses when pan is untaught and `needsRezero` is set.
7. **M-1:** a lost `boot.json` causes edges to be left alone, not shifted.

Tests 1 and 2 must be confirmed to FAIL before implementation. Three defects in this
project were bad tests rather than bad code; a test that passes before the fix proves
nothing.

## Rejected alternatives

**Re-stamp `dBase` on re-solve.** Measured in the previous spec: it breaks the
pan/tilt decoupling, which holds only because `dBase` sits ~1.45° off the pan axis in
the original frame. `dBase` must stay where `characterize_imu` put it.

**Force a re-characterise on every re-solve.** Correct but wasteful — `characterize_imu`
is a seven-posture sweep, and the mount→ENU orientation is unaffected by a re-solve.
It also does not fix the class, only this instance.

**Stamp nothing; document the ordering constraint.** This is what the last two specs
effectively did, and the constraint was violated within one plan each time. The
failure mode is silent and sub-threshold, so documentation cannot catch it.
