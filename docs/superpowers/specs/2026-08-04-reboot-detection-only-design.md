# Reboot Detection Only — Design

**Date:** 2026-08-04
**Status:** Approved for planning
**Supersedes:** the *recovery* half of `2026-08-02-reboot-rezero-design.md`, `2026-08-03-rezero-frame-convention-design.md`, `2026-08-03-origin-generation-stamping-design.md`
**Unblocks:** merge of `feat/reboot-rezero`

## Decision

Three plans, twenty-one tasks and three consecutive blocking final reviews produced the
same defect three times: two artifacts anchored to different step origins, consumed as if
they shared one. Each spec enumerated the instances visible at the time; each review found
one that was not.

- Block 1: Δtilt cumulative, Δpan incremental, both applied as increments — cycle 2 silently 2° wrong, residual under the reject threshold.
- Block 2: `solveTiltOffset` anchored to `characterize_imu`, `setOriginOffset` storing it against `baseline` — re-solve after a re-zero gave `applied:true`, residual 0.04°, 1.11° error.
- Block 3: `limits.appliedOffset` anchored to the previous baseline, reset by nothing — **pointing perfect, taught tilt ceiling 23.26° over-permissive at the field-measured drift**, on the axis that reached a mechanical stop.

The operator's decision is to **keep the detection half and drop the recovery half.**

The detection half has survived all three reviews unchallenged and closes the 2026-08-02
incident: the rig notices it has rebooted and refuses to move rather than driving on an
origin that no longer exists. The recovery half — solving Δtilt/Δpan and folding them back
into the calibration and the limits — is what keeps producing silent, sub-threshold errors,
and it is the part whose value was only ever convenience.

**What is lost:** after a reboot the operator re-teaches limits, re-runs `characterize_imu`,
and re-solves, as they do today. **What is gained:** the rig will not silently point wrong
or enforce a limit 23° past where it was taught.

## What is kept

- **Boot detection.** `BootWatcher`/`detectBoot`, including the unobserved-reboot case (daemon down across the power cycle), and `BootWatchPoller` with its immediate tick before `app.listen()`.
- **`needsRezero`** on the calibration profile, and `rezeroGuard`.
- **Motion gating.** `point_at`, `point_at_azel`, `start_tracking`, `track_aircraft`, and `TrackingSession.tick()`. Jog and `teach_limit` stay open.
- **`SunSupervisor` stays ungated** — gating it removes sun protection rather than degrading it — and reports itself degraded in `get_rezero_status` and on the dashboard.
- **The `characterize_imu` sweep guard**, strengthened (below).
- **The dashboard banner.**
- **The OTA rollback fix**, the BNO055 driver and `/api/i2cscan` — already in the branch's ancestry and untouched by this change.

## What is removed

Everything whose only purpose was reconciling frames:

- `src/geo/rezero.ts` entirely (`solveTiltOffset`, `solvePanOffset`, `applyPanOffset`, `applyTiltOffset`, the residual constants) and its tests.
- `rezeroFromEnu`, `generationMismatchReason`, and the MCP tools `set_landmark`, `rezero_from_landmark`, `rezero_from_aircraft`.
- Calibration profile: `baseline`, `originOffset`, `tiltAnchorDeg`, `landmark`, and the `bootId` stamps on `imuMounting`/`baseline`/`landmark`. `getOrientation()`/`getCHead()` return to reading `orientation`/`cHead` directly.
- `LimitsStore`: `appliedOffset`, `shiftToOffset`, `edgeBootId`, `setBootId`/`getBootId`.
- `reanchorTiltForCharacterize`.

**Removing the dead machinery is deliberate, not tidiness.** Leaving inert
frame-reconciliation code in the one subsystem whose defining bug was frame reconciliation
invites a future reader to assume it is load-bearing and build on it. The `UNKNOWN_GENERATION`
sentinel, the `=== 0` anchor test and the `!==` generation comparison were each a step in
one of the three defects; none should survive with no caller.

## What changes

**`onReboot` becomes detection only.** Read nothing from the IMU, solve nothing. On a
detected reboot: clear the taught limits on **both** axes, set `needsRezero`, log. Tilt is
cleared rather than shifted because there is no longer anything that could shift it
correctly — and a stale tilt limit is what reached the mechanical stop.

This also removes the stale-posture failure mode (I3 of the first review) by construction:
no gravity is read, so no gravity can be paired with a stale posture.

**`rezeroGuard`'s message must not name tools that no longer exist.** The remedy becomes:
teach the pan and tilt limits, run `characterize_imu`, then `solve_calibration`. The current
text points at `rezero_from_landmark`, which is being deleted.

**`panSweepGuard` refuses whenever `needsRezero` is set**, regardless of whether pan has
been re-taught. The current condition (`needsRezero && pan untaught`) was disarmed by
re-teaching pan — which the guard's own message instructed — and that reopened the gap it
was dispatched to close. With no re-zero to complete, the honest rule is simply: do not
characterise on an origin the daemon knows is stale. Re-teaching the limits first is
correct and expected; the guard should clear only when the calibration is re-solved.

**`get_rezero_status` keeps `needs_rezero`, the remedy, and the degraded sun-guard report.**
It drops the landmark, the anchor, and `fit_residual_deg`, which have no meaning without the
solving path.

## Migration

A `calibration.json` written by the current branch may carry `baseline`/`originOffset`/
`landmark`. Removing the schema fields must not make it fail to parse. Zod strips unknown
keys by default; confirm that and pin it with a test loading a profile containing all the
removed fields.

An operator whose profile was written under the current branch has an `orientation`/`cHead`
that is correct for the origin it was solved in. Since the removed `originOffset` was zero
except transiently between a reboot and a completed re-zero, adopting `orientation`/`cHead`
directly is correct for any profile in a settled state.

## Testing

1. **A reboot clears both axes' limits, sets `needsRezero`, and reads no gravity.** Assert the IMU is never called — that is what makes the stale-posture class unreachable.
2. **All five gates still refuse** while `needsRezero` is set, and jog/`teach_limit` still work.
3. **`TrackingSession.tick()` parks** and does not resume when telemetry recovers.
4. **`characterize_imu` refuses while `needsRezero` is set even with pan re-taught** — the I2 bypass must be closed.
5. **`rezeroGuard`'s message names only tools that exist**, asserted against the live tool registry rather than a string literal, so deleting a tool later breaks the test.
6. **A profile containing the removed fields loads** and yields the same pointing as before.
7. **A completed recalibration clears `needsRezero`** — `solve_calibration` and `set_north_zero` must still do this, since they are now the only way out.

## Rejected alternatives

**A fourth plan fixing C1/I1/I2/I3.** All four have prototyped fixes and C1's is one line
per baseline writer. Rejected because the same reasoning produced three specs that each
missed an artifact, and the failure mode is silent and sub-threshold — the class of bug that
documentation and enumeration have now demonstrably failed to contain three times.

**Keeping the recovery code but disabling it behind a flag.** Rejected: dead frame code in
this subsystem is the hazard, and a flag that is never on is worse than deletion because it
reads as supported.
