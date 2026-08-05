# Vision Lock — Design

**Date:** 2026-08-05
**Status:** Approved for planning
**Followed by:** vision-derived calibration (separate spec, depends on this one)

## Problem

The rig tracks from ADS-B alone. After a good calibration that is sub-degree on a
well-received target, but a systematic residual remains — measured in the field
2026-08-04:

| where the mount points | trim the operator had to apply |
|---|---|
| far left | −1.20° |
| centre | ~0.00°, needing +1.13° in tilt |
| right side | −1.13° |

The residual is a function of **where the mount is pointing**, not of time. It is a
geometry error, and the operator currently removes it by hand, one button press at a
time, for every pass.

Its cause is known: the calibration solve had a 66° azimuth spread but only a **1.35°
elevation spread** (both sightings at ~7° elevation, in the bottom 14% of the rig's
1.2–52.3° reachable range). Heading is well constrained; base lean is effectively
guessed. Hand-sighting a high-elevation aircraft is awkward, so the spread stays poor.

A camera that can see the aircraft can close this loop without the operator.

## Design

ADS-B keeps driving tracking at 10 Hz, unchanged. Vision runs as a **slow outer loop**
at ~1 Hz that corrects the bias through the existing bounded aim offset.

The split is deliberate: ADS-B handles fast dynamics well and vision does not need to.
Correcting a pointing-dependent bias at 1 Hz is ample, and a slow loop means a wrong
detection has little authority and is quickly overridden by later good ones.

`nudgeOffset` is the entry point. Its own comment already names this caller:

> *"Mechanical on purpose: apply a delta, return the resulting (clamped) offset. This is
> the exact interface a future automatic (vision-based) corrector will drive instead of a
> human nudging buttons."*

### Components

**1. Detector sidecar.** A small HTTP service (`POST /detect` → candidate boxes with
confidence) running YOLO on the RTX 5080. It is a **separate process**, in the pattern
already established by `llama-server` and `mediamtx`.

Rationale: the MCP daemon stays free of Python and of new npm dependencies, the model can
be swapped or restarted without touching the daemon, and a detector crash degrades
tracking to today's behaviour rather than taking the daemon down.

**2. Posture history.** A ring buffer of `(timeMs, panDeg, tiltDeg)` from the telemetry
stream, answering `postureAt(tMs)` by interpolation. Required because a frame describes
the past.

**3. Frame source.** Delivers frames tagged with their **exposure time**, not their
arrival time.

The existing snapshot path takes **1755–2217 ms**, dominated by waiting for the next
keyframe, and cannot serve a 1 Hz loop. This design needs a lower-latency path — a
persistent decode rather than a per-frame ffmpeg invocation. The shortened GOP (60 → 30)
already specified in the calibration-fixes-and-tuning plan helps and is not sufficient on
its own.

The mechanism is a plan-level choice; the acceptance criterion is fixed: **frames must
arrive at ≥ 1 Hz, each carrying an exposure timestamp, with end-to-end latency stable
enough that the step-response measurement can pin it.** A source whose latency varies
unpredictably from frame to frame cannot be paired with posture and does not qualify,
however fast its average.

**4. Step-response calibration.** One procedure yields both unknowns:

- Command a known aim-offset delta.
- Observe **when** the image starts to move → **video latency**.
- Observe **how far** the detection moves in pixels → **degrees per pixel**.

Neither value is configured. Both are measured, because both change: deg/pixel changes
whenever the operator zooms, and no constant survives that. The measurement re-verifies
continuously — every commanded correction during normal tracking is another observation
of the same scale factor, so drift is detected rather than accumulated.

`calibVideoLatencyMs` already exists in config for sighting extrapolation; the measured
value supersedes it as the authority for this loop.

**5. Consistency gate.** ADS-B already predicts where the aircraft should appear. A
detection is accepted only if it falls near that prediction.

This is what makes a mediocre detector safe. Birds, cloud edges, terrain at the frame
margin and the second aircraft in view are rejected on geometry, without the detector
needing to be clever. It also means detector confidence is a secondary signal, not the
primary one.

**6. Corrector.** Converts the accepted detection's pixel offset from frame centre into
an angular error, using the posture at exposure and the measured deg/pixel, then applies a
**fraction** of it via `nudgeOffset`.

Gain below 1 is required, not stylistic: it makes the loop converge instead of oscillate,
and bounds how far any single bad detection can move the mount. **Start at 0.3**, runtime
adjustable — the right value depends on frame rate and latency, both of which are measured
rather than known in advance.

The existing `MAX_OFFSET_DEG` clamp still applies underneath. A proposed correction beyond
the **sanity bound — half the frame's narrower field of view** — is discarded rather than
clamped: a correction that large means the detection was wrong, and clamping it would apply
a wrong answer at reduced magnitude. The bound is expressed in field-of-view terms, not
degrees, so it stays correct across zoom changes; a detection implying the aircraft is
further off-axis than the frame can see is self-contradictory by construction.

### Failure behaviour

Nothing detected, several candidates surviving the gate, detector unreachable, posture
unavailable for the exposure time, or correction beyond the sanity bound: **contribute
nothing this cycle.** ADS-B tracking continues untouched.

The worst case of the whole feature is exactly the behaviour the rig has today. That is
the property that makes it safe to run unattended.

## The frame-posture pairing hazard

A pixel offset is meaningless without the posture **at exposure**. Pairing a 2-second-old
frame with the mount's current posture computes a correction between two different
pointing directions.

This project has now produced that same bug shape three times in other subsystems:

- ADS-B fixes stamped at arrival rather than at their true age — diagnosed in the field
  2026-08-04 as a 1.91 s lag against a 1.58 s position age, presenting as a trim that grew
  with closing range.
- Δtilt measured cumulatively while Δpan was measured incrementally, both applied as
  increments.
- `solveTiltOffset` anchored to `characterize_imu` while `setOriginOffset` stored against
  `baseline`.

Each was silent, sub-threshold, and found only by a reviewer running an experiment. This
design must not add a fourth instance, so the pairing is stated as an explicit invariant:
**every frame carries its exposure time, and posture is always looked up at that time —
never read from the present.**

## Out of scope

**Vision-derived calibration.** Recording sightings from detections, accumulating them
across the sky, and re-solving orientation and `cHead` from a weighted N-point fit. This is
the higher-value half — it removes operator centring error entirely and fixes the
elevation starvation by collecting passively at elevations that are awkward to sight by
hand — but it depends on the pairing and deg/pixel proven here, and a wrong detection
there corrupts the calibration rather than jiggling a bounded offset. Separate spec, built
second.

**Running the detector on the XDNA2 NPU.** The `amdxdna` driver is loaded and
`/dev/accel/accel0` exists, but there is no userspace: no `onnxruntime`, no XRT tooling, no
Vitis/Ryzen-AI install. Standing that stack up on Debian is a project in itself, and the
1 Hz rate requirement means it would optimise something that is not binding. The Radeon
890M via the already-installed ROCm 7.14 is the fallback if GPU contention ever appears.

**Grid search for aircraft not in frame.** ADS-B pointing already puts the aircraft in
frame; searching for one that isn't there solves a problem the rig no longer has.

## Testing

1. **Frame-posture pairing, proved by mutation.** Pair the frame with the mount's *current*
   posture instead of its posture at exposure; the test MUST fail. A pairing test that
   still passes under that mutation is not testing anything, and this is the defect class
   that has escaped three previous reviews in this project.
2. **Pixel → angle.** Synthetic frame, marker at a known pixel, known posture and
   deg/pixel: assert the computed angular error. Include off-centre in both axes with
   distinct, non-equal, opposite-signed values, so an axis swap or a sign slip cannot pass.
3. **Step-response calibration recovers both unknowns.** Synthetic sequence with a known
   injected latency and known pixel displacement: assert both the recovered latency and the
   recovered deg/pixel. Then assert a zoom change (different true deg/pixel) is re-measured
   rather than retaining the stale value.
4. **The consistency gate rejects a decoy.** A high-confidence detection far from the ADS-B
   prediction must be discarded. Assert the correction applied is zero, not merely small.
5. **Convergence, not oscillation.** Repeated corrections against a fixed synthetic bias
   settle monotonically and do not overshoot. Assert against a gain of 1.0 as a mutation —
   it should oscillate and the test should catch it.
6. **Every failure path contributes nothing.** Detector unreachable, zero candidates,
   multiple candidates, posture unavailable, correction over the sanity bound: assert the
   offset is unchanged in each case, and that tracking state is untouched.
7. **On-rig acceptance.** Whether YOLO detects real aircraft at real ranges against real
   sky and terrain cannot be established off-rig. The detector runs in **read-only logging
   mode** first: it records what it would have corrected without driving anything, and that
   log is compared against the operator's manual trims from the same passes before the loop
   is given authority.

## Rejected alternatives

**A configured field of view.** Fragile the moment the operator zooms, and there is no way
for the system to notice it has gone stale. Measuring costs one commanded step and yields
video latency in the same procedure.

**Running vision at frame rate.** The error being corrected is a function of pointing
direction, not of time, so a fast loop buys nothing and spends GPU that the VLM wants. It
would also make a bad detection more consequential per unit time.

**Replacing ADS-B tracking with vision.** Vision cannot see through the banking dropouts
observed in the field (aircraft shadow their own belly-mounted antennas in a turn, at the
same point on every departure), cannot acquire a target that is not yet in frame, and fails
at night and in cloud. ADS-B remains the primary; vision corrects it.

**Letting vision write to calibration in this phase.** Deferred deliberately — see Out of
scope.
