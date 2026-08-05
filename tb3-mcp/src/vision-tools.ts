import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Config } from "./config.js";
import { Device } from "./device.js";
import { TrackingSession } from "./track/session.js";
import { SunSupervisor } from "./track/supervisor.js";
import { wrapDeg180 } from "./track/control.js";
import { stepsToDeg, applySign, checkPanTilt } from "./angles.js";
import { effectiveLimits, TaughtEdges } from "./limits-store.js";
import { moveToUserAngle } from "./move.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";
import { FrameSource } from "./vision/frame-source.js";
import { PostureHistory } from "./vision/posture-history.js";
import { DetectorClient, DetectResponse } from "./vision/detector-client.js";
import { PixelOffset, AxisSigns, NOMINAL_AXIS_SIGNS } from "./vision/geometry.js";
import { CorrectorOutcome } from "./vision/corrector.js";
import { solveStepResponse, StepObservation, ScaleResult, StepAxis } from "./vision/scale-calibration.js";
import { VisionScaleStore, PersistedVisionScale } from "./vision-scale-store.js";

const RAD = Math.PI / 180;

function round(v: number | null, dp: number): number | null {
  return v === null ? null : Number(v.toFixed(dp));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Inference-space mismatch guard (requirement 2 of Task 8).
//
// YOLO sidecars commonly run inference on a downscaled copy of the frame.
// If the sidecar reports ITS OWN inference-space widthPx/heightPx while
// focalPx was measured against the frame source's full-resolution pixels,
// every angle downstream (pixelToAngularError) is scaled by that ratio --
// AND VisionCorrector's own sanity bound (fovDegFromFocalPx(frameSizePx(),
// focalPx)) scales by the same ratio, so it cannot catch the error either.
// This is the wrong-2x-focal-length defect from Task 2's geometry work,
// reappearing one layer up at the wiring boundary.
//
// VisionCorrector itself (Task 7, frozen -- not in this task's file list)
// never compares res.widthPx/heightPx against anything; it only reads
// focalPx() and frameSizePx() for the sanity-bound FOV calc. So the guard
// has to live in the wiring layer, ahead of the corrector: this wraps the
// real DetectorClient and refuses (returns null, same as an unreachable
// detector) whenever the response's declared size disagrees with what the
// frame source is known to deliver. A composed wrapper rather than a
// DetectorClient subclass -- CorrectorDeps.detector only needs a matching
// `detect()` method, and the existing test harness (vision-corrector.test.ts)
// already satisfies that field with a plain object cast `as never`, so this
// project's own precedent is duck typing here, not subclassing a class with
// private constructor params.
// ---------------------------------------------------------------------------
export interface SizeGuardedDetectorDeps {
  expectedSizePx: () => { widthPx: number; heightPx: number };
  // Fired once per mismatched detection, not throttled further -- a
  // misconfiguration that persists should keep being visible, not go quiet
  // after the first sighting. Optional so callers that don't care about the
  // log line (e.g. a test) can omit it.
  onMismatch?: (detail: Record<string, unknown>) => void;
}

export class SizeGuardedDetector {
  constructor(
    private readonly inner: DetectorClient,
    private readonly deps: SizeGuardedDetectorDeps,
  ) {}

  async detect(jpegBase64: string, minConf: number): Promise<DetectResponse | null> {
    const res = await this.inner.detect(jpegBase64, minConf);
    if (res === null) return null;
    const expected = this.deps.expectedSizePx();
    // Exact match, not "close enough": a real resize changes both dimensions
    // by whatever ratio the sidecar chose, and there is no principled
    // tolerance to pick that would not also let through a genuine 2x.
    if (res.widthPx !== expected.widthPx || res.heightPx !== expected.heightPx) {
      this.deps.onMismatch?.({
        detectorWidthPx: res.widthPx, detectorHeightPx: res.heightPx,
        expectedWidthPx: expected.widthPx, expectedHeightPx: expected.heightPx,
      });
      return null;
    }
    return res;
  }
}

export function parseSizeSpec(spec: string): { widthPx: number; heightPx: number } | null {
  const m = /^\s*(\d+)x(\d+)\s*$/.exec(spec);
  if (!m) return null;
  const widthPx = Number(m[1]), heightPx = Number(m[2]);
  if (!(widthPx > 0) || !(heightPx > 0)) return null;
  return { widthPx, heightPx };
}

// The ground truth for "what the frame source actually delivers" -- NOT the
// detector's own report (that is exactly the value being checked against
// it).
//
// v4l2: ffmpeg args pass -video_size cfg.cameraV4l2Size verbatim (see
// dashboard/camera/v4l2.ts), so a frame really does arrive at that
// resolution.
//
// mediamtx (fix round 6 / operator correction -- the rig's actual deployed
// cameraSource, not v4l2): deliberately cfg.cameraMediamtxSize, NOT
// cameraV4l2Size -- config.ts's own comment on cameraMediamtxSize says they
// are separate on purpose. The vision frame source (buildVisionFrameSource
// in server.ts) pulls RTSP directly from MediaMTX and re-encodes to MJPEG
// itself; the ingest side (dashboard/camera/rtsp.ts:54) passes
// `-video_size cfg.cameraMediamtxSize` to the SAME publish pipeline that
// feeds that RTSP stream, so a frame pulled back off it really does arrive
// at that resolution (decode+re-encode to MJPEG does not itself resize).
// Using cameraV4l2Size here would silently mis-scale every angle whenever
// the two configured sizes differ.
//
// mtplvcap (Nikon USB Live View) has no size config at all. Rather than
// guess a number, this returns the sentinel {0,0}: fovDegFromFocalPx(0,
// focalPx) is 0, so VisionCorrector's sanity bound collapses to zero and
// every correction is refused, and SizeGuardedDetector above can never
// match a real (positive) detector response against it either. Vision is
// therefore inert -- fails closed, not silently wrong -- on this one
// remaining camera source, until a future task adds a real size source for
// it too. Flagged in task-8-report.md as a gap in the brief's closed
// config-key list, not something this task's scope covers alone.
export function resolveVisionFrameSizePx(cfg: Config): { widthPx: number; heightPx: number } {
  if (cfg.cameraSource === "v4l2") {
    const parsed = parseSizeSpec(cfg.cameraV4l2Size);
    if (parsed) return parsed;
  }
  if (cfg.cameraSource === "mediamtx") {
    const parsed = parseSizeSpec(cfg.cameraMediamtxSize);
    if (parsed) return parsed;
  }
  return { widthPx: 0, heightPx: 0 };
}

// The inverse of vision/geometry.ts's pixelToAngularError: given an angular
// error (degrees) and the tilt the forward mapping used, recover the pixel
// offset that would have produced it. Kept local rather than added to
// geometry.ts, which is outside this task's file list and whose Task 2
// scale-invariance pin would need a matching inverse-side pin of its own.
//
// FIX ROUND 4 / C2: must share pixelToAngularError's `signs` convention.
// This is the PREDICTION limb (where ADS-B says the aircraft should be, in
// pixels) and pixelToAngularError is the CORRECTION limb (what the
// detector's actual pixel error implies about the angular correction to
// apply). If the two disagree on axis handedness, the prediction sits on the
// wrong side of centre from where the real detection will land, and
// gateDetections rejects the true detection as "none_near_prediction" every
// cycle -- exactly C2's mechanism. `signs` defaults to NOMINAL_AXIS_SIGNS so
// every pre-existing caller/test that doesn't know about measured signs yet
// keeps its exact prior behaviour.
function angularErrorToPixel(
  panErrDeg: number, tiltErrDeg: number, focalPx: number, tiltDeg: number,
  signs: AxisSigns = NOMINAL_AXIS_SIGNS,
): PixelOffset {
  const c = Math.cos(tiltDeg * RAD);
  return {
    dxPx: focalPx * Math.tan(signs.pan * panErrDeg * c * RAD),
    dyPx: focalPx * Math.tan(signs.tilt * tiltErrDeg * RAD),
  };
}

// predictPixel: the inverse of pixelToAngularError, fed by the target's
// position AT EXPOSURE and the rig's posture AT EXPOSURE -- both looked up
// in PostureHistory-shaped rings, never read "as of now".
//
// FIX ROUND 1 / CRITICAL: the original version of this function read
// session.status().targetPanDeg/TiltDeg directly, which is the target's
// aim as of the LAST tracking tick (itself projected trackLeadMs into ITS
// OWN future) -- an epoch that has nothing to do with exposureMs. That
// mixed target@now against posture@exposure, reproducing exactly the
// two-epoch mismatch this whole feature exists to prevent, one layer up:
// measured by the reviewer at a rig-still/3°/s-target/1.5s-old-frame
// scenario, the resulting pointing error was 4.50° = 132px against a 120px
// default gate radius -- enough to make gateDetections refuse the TRUE
// detection as "none_near_prediction" every cycle. Worse, the error was NOT
// bounded by one visionTickHz period as originally reasoned: it is
// (now - exposureMs) + trackLeadMs, and exposureMs = arrivedMs - latencyMs,
// so it grows with the calibrated camera latency -- the very quantity this
// design exists to compensate for. No fixture using a constant target could
// ever catch it (there is no "now" for a constant value to be wrong about).
//
// Fix: `targetHistory` is a second PostureHistory-shaped ring, recorded by
// recordTargetSample in server.ts from the same Device.onTelemetry event
// that feeds `postures` (see server.ts's wiring), keyed by that event's own
// wall-clock time. Interpolating it at exposureMs removes the dominant
// (multi-second, latency-scaling) term. A residual bias equal to
// trackLeadMs (the tracker's own feedforward lookahead baked into
// targetPanDeg, default 150ms) remains -- ~0.45° at 3°/s, 13px, versus
// 132px before -- accepted for now (see task-8-report.md).
//
// IMPORTANT 5 (round 1) / HIGH 1 (round 3): gated on
// session.status().state === "tracking", NOT session.isActive() (which is
// also true in "waiting"/"acquiring" -- track/session.ts:128). Every early
// return in TrackingSession.tick() (not_calibrated, program_engaged,
// telemetry_stale, target_stale) sets state to "waiting" and returns BEFORE
// recordAim() runs, freezing lastStatus at its pre-dropout value --
// isActive() alone would let a dead target's frozen aim keep gating in a
// detection and mutating session.offset with nothing actually tracked (the
// reviewer measured 8.4°/245px of error in the reacquire window this way).
// Also bounded by targetAgeMs (cheaply available from status(), already
// used elsewhere for exactly this staleness question -- trackMaxTargetAgeMs)
// because that field derives from the ADS-B estimator independently of
// session state and so does not by itself catch "state===waiting".
export function buildPredictPixel(
  session: TrackingSession, targetHistory: PostureHistory, postures: PostureHistory,
  focalPx: () => number | null, maxTargetAgeMs: number,
  // Measured camera handedness (see angularErrorToPixel's doc / A5). A
  // function, like focalPx, so a fresh calibrate_vision_scale result takes
  // effect on the very next prediction without rebuilding the closure.
  axisSigns: () => AxisSigns = () => NOMINAL_AXIS_SIGNS,
  // MEDIUM-2 (round 3 of independent review): axisSigns().tilt is ALWAYS a
  // concrete number (defaulted to nominal when unmeasured), because the
  // pixel-projection formula below needs one -- but trusting that default
  // here is exactly as wrong as trusting it in the correction limb (Fix 3
  // zeroes the CORRECTION; this predicate is what makes this function zero
  // the PREDICTED dyPx the same way). Left unguarded, a guessed nominal
  // tilt sign puts the prediction on the wrong side of centre by
  // 2*focalPx*tan(boresight-tilt-lag) -- past roughly 1.9deg of lag at the
  // default 120px gate radius, gateDetections rejects the TRUE detection
  // as none_near_prediction, and the pan correction Fix 3 deliberately
  // kept alive is lost right along with it. Defaults to true so every
  // existing caller/test that doesn't know about this distinction keeps
  // its exact prior behaviour.
  tiltCalibrated: () => boolean = () => true,
): (exposureMs: number) => PixelOffset | null {
  return (exposureMs: number) => {
    const status = session.status();
    if (status.state !== "tracking") return null;
    if (status.targetAgeMs === null || status.targetAgeMs > maxTargetAgeMs) return null;
    const target = targetHistory.postureAt(exposureMs);
    if (target === null) return null;
    const posture = postures.postureAt(exposureMs);
    if (posture === null) return null;
    const f = focalPx();
    if (f === null || !(f > 0)) return null;
    const panErrDeg = wrapDeg180(target.panDeg - posture.panDeg);
    const tiltErrDeg = target.tiltDeg - posture.tiltDeg;
    const off = angularErrorToPixel(panErrDeg, tiltErrDeg, f, posture.tiltDeg, axisSigns());
    if (!Number.isFinite(off.dxPx) || !Number.isFinite(off.dyPx)) return null;
    // MEDIUM-2: don't guess -- an uncalibrated tilt axis predicts NO
    // vertical offset at all (rather than one built from a possibly-wrong
    // sign), the same "unmeasured means contribute nothing" treatment
    // Fix 3 already applies to the correction limb.
    return tiltCalibrated() ? off : { dxPx: off.dxPx, dyPx: 0 };
  };
}

// ---------------------------------------------------------------------------
// Runtime state (requirement 3: OFF and read-only by default, mutable at
// runtime without a restart -- mirrors SunSupervisor.setConfig/
// CaptureController.setAuto).
//
// The measured scale (focalPx/latencyMs) lives here in memory for fast,
// synchronous reads from the correction loop's focalPx()/frameSizePx() hot
// path, but it is NOT the system of record: as of fix round 2, `server.ts`
// seeds it from VisionScaleStore at boot and calibrate_vision_scale writes
// through to that store on every success (see registerVisionTools's
// `scaleStore` param below), so it now genuinely survives a daemon restart
// -- closing the gap the round-1 reviewer flagged ("persists the result",
// the brief's own words, was previously satisfied only at process-lifetime
// granularity).
// ---------------------------------------------------------------------------
// The runtime/in-memory shape of a measured scale, distinct from
// scale-calibration.ts's ScaleResult (which is the output of ONE
// solveStepResponse call, for ONE axis) -- this is the COMBINED result
// calibrate_vision_scale reports after stepping both axes: one focalPx/
// latencyMs pair (from the pan step, which every existing consumer already
// expects) plus the signs measured on each axis. `axisSigns` is optional,
// mirroring PersistedVisionScale's own optional panSign/tiltSign (A4) --
// absent means "not measured", and every reader defaults it to
// NOMINAL_AXIS_SIGNS rather than bake a default in here, for the same
// reason: a real negative sign must never be indistinguishable from
// "unmeasured".
// pan is required (calibrate_vision_scale refuses outright if the pan
// solve doesn't resolve); tilt is independently optional (fix round 5 /
// Fix 3) -- a failed or skipped tilt measurement must be represented as
// UNMEASURED, never defaulted to a concrete sign, or a wrong guess on that
// axis reinstates C2 silently. Protecting this requires BOTH readers of it:
// VisionCorrector's tiltCalibrated Dep zeroes the tilt CORRECTION term, and
// buildPredictPixel's own tiltCalibrated parameter (MEDIUM-2, round 6)
// zeroes the PREDICTED tilt pixel offset the same way -- a guessed
// prediction alone still gate-rejects the true detection at a large enough
// tilt lag (see vision-sign-audit.test.ts's AUDIT 5), silently discarding
// the pan correction the correction-limb fix was trying to keep alive.
// Neither half "degrades gracefully" without the other.
export interface MeasuredAxisSigns {
  pan: 1 | -1;
  tilt?: 1 | -1;
}

export interface VisionScale {
  focalPx: number;
  latencyMs: number;
  axisSigns?: MeasuredAxisSigns;
}

export function toVisionScale(p: PersistedVisionScale): VisionScale {
  return {
    focalPx: p.focalPx, latencyMs: p.latencyMs,
    // pan defaults to nominal for a pre-A4 file that predates the field
    // entirely; tilt is left exactly as loaded -- absent stays absent (see
    // MeasuredAxisSigns's own doc).
    axisSigns: { pan: p.panSign ?? 1, tilt: p.tiltSign },
  };
}

export function toPersistedVisionScale(v: VisionScale): PersistedVisionScale {
  return {
    focalPx: v.focalPx, latencyMs: v.latencyMs,
    panSign: v.axisSigns?.pan, tiltSign: v.axisSigns?.tilt,
  };
}

export interface VisionStatusSnapshot {
  enabled: boolean;
  readOnly: boolean;
  lastOutcome: CorrectorOutcome | null;
  lastCorrectionPanDeg: number | null;
  lastCorrectionTiltDeg: number | null;
  scale: VisionScale | null;
  // Fix round 5 / Fix 3: previously visible only in calibrate_vision_scale's
  // OWN one-time response, so after a daemon restart (which reloads the
  // persisted scale, not a fresh calibration) an operator had no way to
  // tell whether tilt correction was actually active. Surfaced here too.
  tiltCalibrated: boolean;
  // Inferred from the last tick's outcome, not a fresh probe: a probe would
  // need a real frame to send and would race the correction loop's own
  // detector call. null means "no tick has run yet", not "unreachable".
  detectorReachable: boolean | null;
}

export class VisionRuntime {
  private enabled: boolean;
  private readOnly: boolean;
  private scale: VisionScale | null = null;
  private lastOutcome: CorrectorOutcome | null = null;
  private lastCorrection: { panDeg: number; tiltDeg: number } | null = null;

  constructor(cfg: Config) {
    this.enabled = cfg.visionEnabled;
    this.readOnly = cfg.visionReadOnly;
  }

  isEnabled(): boolean { return this.enabled; }
  isReadOnly(): boolean { return this.readOnly; }

  setConfig(p: { enabled?: boolean; readOnly?: boolean }): void {
    if (p.enabled !== undefined) this.enabled = p.enabled;
    if (p.readOnly !== undefined) this.readOnly = p.readOnly;
  }

  getScale(): VisionScale | null { return this.scale; }
  setScale(s: VisionScale): void { this.scale = s; }
  focalPx(): number | null { return this.scale?.focalPx ?? null; }
  // Fix A5: the loop-facing getter every corrector Dep and buildPredictPixel
  // caller should read -- defaults to NOMINAL when nothing has been
  // measured yet, exactly like focalPx() defaulting to null. The tilt
  // component defaults to nominal here too, but ONLY the prediction limb
  // should ever see that default; the correction limb must consult
  // tiltCalibrated() below and zero its tilt term instead of trusting it.
  axisSigns(): AxisSigns {
    return { pan: this.scale?.axisSigns?.pan ?? 1, tilt: this.scale?.axisSigns?.tilt ?? 1 };
  }
  // Fix round 5 / Fix 3: whether the tilt axis has ever actually been
  // measured (as opposed to defaulted). false both before any calibration
  // and after a calibration whose tilt step didn't resolve.
  tiltCalibrated(): boolean { return this.scale?.axisSigns?.tilt !== undefined; }

  recordOutcome(outcome: CorrectorOutcome, detail: Record<string, unknown>): void {
    this.lastOutcome = outcome;
    if (outcome === "applied" || outcome === "read_only") {
      const p = detail.panDeg, t = detail.tiltDeg;
      if (typeof p === "number" && typeof t === "number") this.lastCorrection = { panDeg: p, tiltDeg: t };
    }
  }

  status(): VisionStatusSnapshot {
    return {
      enabled: this.enabled,
      readOnly: this.readOnly,
      lastOutcome: this.lastOutcome,
      lastCorrectionPanDeg: this.lastCorrection?.panDeg ?? null,
      lastCorrectionTiltDeg: this.lastCorrection?.tiltDeg ?? null,
      scale: this.scale,
      tiltCalibrated: this.tiltCalibrated(),
      detectorReachable: this.lastOutcome === null ? null : this.lastOutcome !== "detector_unavailable",
    };
  }
}

export interface DetectFn {
  detect(jpegBase64: string, minConf: number): Promise<DetectResponse | null>;
}

export function registerVisionTools(
  server: McpServer,
  cfg: Config,
  device: Device,
  session: TrackingSession,
  supervisor: SunSupervisor,
  frames: FrameSource,
  detector: DetectFn,
  runtime: VisionRuntime,
  scaleStore: VisionScaleStore,
  limitsProvider: () => TaughtEdges,
): void {
  server.registerTool(
    "get_vision_status",
    {
      description:
        "Vision-lock correction loop status: enabled, read-only, the last tick's outcome and " +
        "correction, the measured focalPx/latencyMs scale (see calibrate_vision_scale), the " +
        "frame size vision believes the camera delivers (frame_size_px -- {0,0} means vision is " +
        "structurally inert for the current cameraSource, see resolveVisionFrameSizePx's doc), " +
        "and whether the detector sidecar is reachable (inferred from the last tick, not a fresh " +
        "probe -- null means no tick has run yet).",
      inputSchema: {},
    },
    async () => {
      const s = runtime.status();
      const size = resolveVisionFrameSizePx(cfg);
      return text(JSON.stringify({
        enabled: s.enabled,
        read_only: s.readOnly,
        last_outcome: s.lastOutcome,
        last_correction_pan_deg: round(s.lastCorrectionPanDeg, 3),
        last_correction_tilt_deg: round(s.lastCorrectionTiltDeg, 3),
        focal_px: s.scale ? Number(s.scale.focalPx.toFixed(2)) : null,
        latency_ms: s.scale ? Number(s.scale.latencyMs.toFixed(0)) : null,
        pan_sign: s.scale ? (s.scale.axisSigns?.pan ?? 1) : null,
        tilt_sign: s.scale ? (s.scale.axisSigns?.tilt ?? null) : null,
        // Fix round 5 / Fix 3: visible independent of the calibrate
        // response, so a restart (which reloads the persisted scale, not a
        // fresh calibration) doesn't hide whether tilt correction is live.
        tilt_calibrated: s.tiltCalibrated,
        // FIX ROUND 2 / IMPORTANT 3: without this, the {0,0} fail-closed
        // sentinel (correct and load-bearing -- see resolveVisionFrameSizePx's
        // doc, do not weaken it) was invisible from the outside. On this
        // rig's actual default (cameraSource="mtplvcap"), that meant
        // detector_reachable read false for a detector that was actually up
        // and answering -- indistinguishable, from this tool alone, from a
        // genuinely dead sidecar. An operator could spend an evening
        // restarting a healthy YOLO process chasing that. frame_size_px
        // makes the real cause ({0,0} = "no configured frame size for this
        // cameraSource", not "detector down") visible directly.
        frame_size_px: size,
        detector_reachable: s.detectorReachable,
      }, null, 2));
    },
  );

  server.registerTool(
    "set_vision_enabled",
    {
      description:
        "Turn the vision-lock correction loop on or off, and independently switch it between " +
        "read-only (observes and logs would-be corrections, applies nothing) and active " +
        "(applies corrections through the same nudge path as nudge_aim_offset, so " +
        "maxAimOffsetDeg still bounds it). Both default to the safe state (off, read-only) at " +
        "daemon startup -- this is how an operator deliberately opts in. Refuses to enable when " +
        "the current cameraSource has no configured frame size (see get_vision_status's " +
        "frame_size_px) -- the loop would otherwise silently stay inert.",
      inputSchema: {
        enabled: z.boolean(),
        readOnly: z.boolean().optional(),
      },
    },
    async ({ enabled, readOnly }) => {
      // FIX ROUND 2 / IMPORTANT 3: name the real cause AT THE MOMENT the
      // operator tries to turn vision on, rather than let them discover it
      // later via a permanently-false detector_reachable. Does not weaken
      // resolveVisionFrameSizePx's own fail-closed {0,0} guard -- this is a
      // diagnostic refusal at the tool boundary, not a change to what the
      // corrector trusts.
      if (enabled) {
        const size = resolveVisionFrameSizePx(cfg);
        if (!(size.widthPx > 0) || !(size.heightPx > 0)) {
          return errText(
            `cannot enable vision — no configured frame size for cameraSource="${cfg.cameraSource}" ` +
            "(see resolveVisionFrameSizePx's doc); switch to cameraSource=\"v4l2\" or \"mediamtx\" " +
            "before enabling",
          );
        }
      }
      runtime.setConfig({ enabled, readOnly });
      // Nothing pulls frames (no HTTP connection, no detector traffic) while
      // disabled -- start()/stop() here is what makes "off by default"
      // actually mean idle, not just "the correction is skipped but the
      // pipe keeps running".
      if (enabled) frames.start(); else frames.stop();
      return text(JSON.stringify({ enabled: runtime.isEnabled(), read_only: runtime.isReadOnly() }));
    },
  );

  server.registerTool(
    "calibrate_vision_scale",
    {
      description:
        "Command a small pan step and recover the vision loop's focalPx/latencyMs scale from " +
        "the detector's tracked displacement (see vision/scale-calibration.ts's step-response " +
        "solve). Moves the rig briefly; requires a live camera feed and a reachable detector. " +
        "The result is kept for the life of the daemon (get_vision_status, and the correction " +
        "loop's focalPx) -- re-run after a zoom change, and again after any daemon restart.",
      inputSchema: {
        step_pan_deg: z.number().finite().positive().max(20).optional()
          .describe("pan step to command, degrees (default 5)"),
        sample_window_ms: z.number().int().positive().max(15000).optional()
          .describe("how long to sample the detector after the step, ms (default 4000)"),
      },
    },
    async ({ step_pan_deg, sample_window_ms }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      // IMPORTANT 2: a live tracking tick and this tool's own moveToUserAngle
      // would fight for the same axes -- and a step response solved against a
      // displacement the tracker is actively undoing yields a wrong focalPx
      // that then silently scales every future correction. Refuse rather
      // than race it.
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }

      // IMPORTANT 1: check every precondition BEFORE commanding any motion.
      // Proven with MockTb3: without these checks (in three reachable
      // states, including the shipping default of visionEnabled=false, where
      // `frames` is never started and latest() is always null) the rig
      // still stepped 5°, the detector was never contacted, the rig was left
      // sitting at the stepped position, and the error message blamed the
      // camera/detector for what was actually "no frame source was ever
      // running". Name the actual cause instead of a generic downstream
      // symptom, and refuse before anything moves.
      const expectedSize = resolveVisionFrameSizePx(cfg);
      if (!(expectedSize.widthPx > 0) || !(expectedSize.heightPx > 0)) {
        return errText(
          `vision has no configured frame size for cameraSource="${cfg.cameraSource}" — ` +
          "calibration requires cameraSource=\"v4l2\" or \"mediamtx\" (the sources with a known " +
          "resolution; see resolveVisionFrameSizePx's doc) until a future task adds one for mtplvcap",
        );
      }
      if (frames.latest() === null) {
        return errText(
          "no camera frame available — the vision frame source has not delivered a frame yet " +
          "(check set_vision_enabled has been called, and that the dashboard's camera is armed " +
          "and streaming)",
        );
      }

      const stepDeg = step_pan_deg ?? 5;
      const windowMs = sample_window_ms ?? 4000;

      const cur = device.getState();
      const startPanDeg = applySign(stepsToDeg(cur.panSteps), cfg.panSign);
      const startTiltDeg = applySign(stepsToDeg(cur.tiltSteps), cfg.tiltSign);
      const limits = effectiveLimits(
        { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax },
        limitsProvider(),
      );

      // FIX A3: both target positions must be reachable BEFORE anything
      // moves -- stepping both axes (below) means both range checks have to
      // pass up front, exactly like the single pan-only check this replaces.
      const panRangeCheck = checkPanTilt(startPanDeg + stepDeg, startTiltDeg, limits);
      if (!panRangeCheck.ok) return errText(panRangeCheck.error!);
      const tiltRangeCheck = checkPanTilt(startPanDeg, startTiltDeg + stepDeg, limits);
      if (!tiltRangeCheck.ok) return errText(tiltRangeCheck.error!);

      // A FEW frames sampled before any motion is commanded, so
      // solveStepResponse can measure displacement FROM this baseline rather
      // than the absolute frame-centre offset (A1/I1) -- an aircraft sitting
      // off-centre before the step must not be mistaken for the step itself.
      const BASELINE_WINDOW_MS = 600;

      async function collectObservations(sampleMs: number): Promise<StepObservation[]> {
        const collected: StepObservation[] = [];
        const deadline = Date.now() + sampleMs;
        while (Date.now() < deadline) {
          const frame = frames.latest();
          if (frame) {
            const res = await detector.detect(frame.jpegBase64, cfg.visionMinConf);
            if (res && res.detections.length > 0) {
              const best = res.detections.reduce((a, b) => (b.conf > a.conf ? b : a));
              // FIX C4: the ARRIVAL epoch, never exposureMs. exposureMs is
              // itself derived from the daemon's own latencyMs estimate
              // (frame-source.ts: exposureMs = arrivedMs - latencyMs()), so
              // using it here would make a second calibration re-derive
              // latency against a clock that already has the FIRST
              // calibration's estimate baked in -- latency_new =
              // latency_true - latency_old, oscillating 400ms -> 0 -> 400ms
              // across runs. arrivedMs is ground truth, independent of any
              // latency estimate.
              collected.push({ tMs: frame.arrivedMs, dxPx: best.dxPx, dyPx: best.dyPx });
            }
          }
          await sleep(200);
        }
        return collected;
      }

      // Returns whether the restore itself succeeded -- best-effort (a
      // restore failure must not mask the original diagnostic being
      // returned by the caller), but callers on a throw path (MEDIUM-1)
      // need to know so they can say so in the error text rather than
      // silently claim "returned to its starting position" when it wasn't.
      async function restoreStart(): Promise<boolean> {
        try { await moveToUserAngle(device, cfg, startPanDeg, startTiltDeg, undefined, limits); return true; }
        catch { return false; }
      }

      // --- pan axis -----------------------------------------------------
      const panBaselineObs = await collectObservations(BASELINE_WINDOW_MS);
      // FIX 5 (I1 reappearing via a different door): solveStepResponse
      // silently defaults an empty baseline to frame-centre (0) -- exactly
      // the absolute-offset behaviour I1 removed. Refuse outright rather
      // than let a target sitting off-centre before the step (with the
      // baseline window simply missing it) be misread as the step itself,
      // with no diagnostic that anything was wrong.
      if (panBaselineObs.length === 0) {
        return errText(
          `no pre-step baseline samples on the pan axis (0 detections in ${BASELINE_WINDOW_MS}ms ` +
          "before the step) — refusing rather than silently defaulting to a frame-centre baseline; " +
          "check the camera/detector are live and the target is in frame before calibrating, then " +
          "retry.",
        );
      }
      // Stamped BEFORE the move is commanded -- solveStepResponse measures
      // observation latency relative to this instant, and a report claiming
      // movement before the command would be treated as a clock problem
      // and refused (see scale-calibration.ts: "latencyMs < 0").
      const panStepAppliedAtMs = Date.now();
      try {
        await moveToUserAngle(device, cfg, startPanDeg + stepDeg, startTiltDeg, undefined, limits);
      } catch (e) {
        // MEDIUM-1: moveToUserAngle can throw AFTER device.gotoAngle() was
        // ACCEPTED -- device.waitForArrival() timing out on a stalled axis
        // is a live path (move.ts), not hypothetical -- so the rig may
        // genuinely have moved even though this step "failed". Attempt a
        // restore (mirrors the tilt step's own finally-based restore, Fix
        // 4) and say so either way, rather than return a message that
        // implies nothing moved.
        const restored = await restoreStart();
        return errText(
          `step command failed: ${(e as Error).message} — ${restored
            ? "the rig has been returned to its starting position."
            : "the rig may NOT have been returned to its starting position (the restore attempt " +
              "also failed); check its position before retrying."}`,
        );
      }
      const panStepObs = await collectObservations(windowMs);
      await restoreStart();
      const panResult = solveStepResponse(
        [...panBaselineObs, ...panStepObs], panStepAppliedAtMs, stepDeg, startTiltDeg, "pan",
      );

      if (!panResult) {
        return errText(
          "step response did not resolve on the pan axis — no clear settled displacement in the " +
          "detector's samples (check the camera and detector are live and the target is in frame); " +
          "retry with a larger step_pan_deg or a longer sample_window_ms. " +
          `baseline_samples=${panBaselineObs.length}, step_samples=${panStepObs.length}. The rig has ` +
          "been returned to its starting position.",
        );
      }

      // --- tilt axis (A3: step BOTH axes, so both signs get measured;
      // best-effort -- see MeasuredAxisSigns's own doc on why an
      // unresolved tilt degrades rather than fails the whole calibration) -
      const tiltBaselineObs = await collectObservations(BASELINE_WINDOW_MS);
      const tiltStepAppliedAtMs = Date.now();
      let tiltResult: ScaleResult | null = null;
      let tiltStepObs: StepObservation[] = [];
      // FIX 5: same empty-baseline guard as pan, but tilt is best-effort --
      // skip straight to "unmeasured" (tiltResult stays null) rather than
      // hard-refuse a calibration that already has a good pan result.
      if (tiltBaselineObs.length > 0) {
        try {
          await moveToUserAngle(device, cfg, startPanDeg, startTiltDeg + stepDeg, undefined, limits);
          tiltStepObs = await collectObservations(windowMs);
          tiltResult = solveStepResponse(
            [...tiltBaselineObs, ...tiltStepObs], tiltStepAppliedAtMs, stepDeg, startTiltDeg, "tilt",
          );
        } catch {
          // A failed tilt COMMAND (not a failed tilt SOLVE) still leaves a
          // perfectly good pan calibration on the table -- degrade to
          // "tilt sign unmeasured" (persisted ABSENT, never a guessed
          // sign -- see MeasuredAxisSigns's doc) rather than throw away the
          // pan result the operator already paid for with real rig motion.
        } finally {
          // FIX 4: restoreStart() previously sat inside the `try`. If
          // moveToUserAngle threw AFTER the goto was accepted (the rig
          // genuinely started moving), the catch swallowed everything
          // including this restore, and the tool would return a
          // degraded-but-non-error success with the rig left sitting off
          // in tilt. Must run on every path through this block.
          await restoreStart();
        }
      }

      const result: VisionScale = {
        focalPx: panResult.focalPx,
        latencyMs: panResult.latencyMs,
        axisSigns: {
          // FIX 1: axisSign (scale-calibration.ts's ScaleResult) is
          // d(pixel)/d(command) -- how the image moves when the boresight
          // moves. AxisSigns as consumed by pixelToAngularError /
          // angularErrorToPixel is d(command)/d(pixel offset) -- the
          // correction to apply, where a pixel offset is
          // target-minus-boresight. Increasing the command DECREASES that
          // offset, so the two derivatives are opposite in sign: wiring
          // axisSign straight into AxisSigns without negating it drives
          // both axes backwards (verified: an offset of (2.0°,1.5°) grows
          // to (7.0°,6.5°) and runs to nudgeOffset's clamp instead of
          // closing). See geometry.ts's AxisSigns doc.
          pan: (-panResult.axisSign) as 1 | -1,
          // FIX 3: an unresolved tilt solve stays ABSENT here, never
          // defaulted to a guessed sign. VisionRuntime.tiltCalibrated()
          // reads this absence and VisionCorrector zeroes the tilt
          // correction term rather than apply a possibly-backwards one.
          tilt: tiltResult ? ((-tiltResult.axisSign) as 1 | -1) : undefined,
        },
      };
      runtime.setScale(result);
      // FIX ROUND 2 / spec miss: write through to disk so a daemon restart
      // does not silently forget a real, rig-moving calibration and revert
      // the corrector to no_scale until it is re-run. Unlike load()
      // (which must never throw -- a corrupt file collapses to "not yet
      // calibrated"), save() propagates a write failure (disk full,
      // permissions) same as every other Store in this codebase (matches
      // LimitsStore.setEdge/SectorStore's own save() -- neither wraps
      // writeFileSync/renameSync either): a failed persist here is a real
      // filesystem problem the operator needs to see, not one to hide
      // behind a false "calibrated" response.
      scaleStore.set(toPersistedVisionScale(result));
      return text(JSON.stringify({
        focal_px: Number(result.focalPx.toFixed(2)),
        latency_ms: Number(result.latencyMs.toFixed(0)),
        pan_sign: result.axisSigns!.pan,
        tilt_sign: result.axisSigns!.tilt ?? null,
        tilt_calibrated: tiltResult !== null,
        // FIX 5: reported on success too, not only in a refusal's error
        // text, so a "resolved but suspiciously few samples" calibration is
        // visible without having to fail outright to say so.
        baseline_samples_pan: panBaselineObs.length,
        baseline_samples_tilt: tiltBaselineObs.length,
        samples: panBaselineObs.length + panStepObs.length + tiltBaselineObs.length + tiltStepObs.length,
      }));
    },
  );
}
