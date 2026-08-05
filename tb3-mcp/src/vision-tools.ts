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
import { PixelOffset } from "./vision/geometry.js";
import { CorrectorOutcome } from "./vision/corrector.js";
import { solveStepResponse, StepObservation, ScaleResult } from "./vision/scale-calibration.js";

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
// it). Only cameraSource="v4l2" has a configured, load-bearing size: its
// ffmpeg args pass -video_size cfg.cameraV4l2Size verbatim (see
// dashboard/camera/v4l2.ts), so a frame really does arrive at that
// resolution. mtplvcap (Nikon USB Live View) has no size config at all, and
// mediamtx's MJPEG relay resolution is a separate, untracked constant from
// cameraMediamtxSize (which feeds its WebRTC encode, not the JPEG fallback)
// -- see config.ts's comment on cameraMediamtxSize. Rather than guess a
// number for either, this returns the sentinel {0,0}: fovDegFromFocalPx(0,
// focalPx) is 0, so VisionCorrector's sanity bound collapses to zero and
// every correction is refused, and SizeGuardedDetector above can never
// match a real (positive) detector response against it either. Vision is
// therefore inert -- fails closed, not silently wrong -- on any camera
// source other than v4l2 until a future task adds a real size source for
// the other two paths. Flagged in task-8-report.md as a gap in the brief's
// closed config-key list, not something this task's scope covers alone.
export function resolveVisionFrameSizePx(cfg: Config): { widthPx: number; heightPx: number } {
  if (cfg.cameraSource === "v4l2") {
    const parsed = parseSizeSpec(cfg.cameraV4l2Size);
    if (parsed) return parsed;
  }
  return { widthPx: 0, heightPx: 0 };
}

// The inverse of vision/geometry.ts's pixelToAngularError: given an angular
// error (degrees) and the tilt the forward mapping used, recover the pixel
// offset that would have produced it. Kept local rather than added to
// geometry.ts, which is outside this task's file list and whose Task 2
// scale-invariance pin would need a matching inverse-side pin of its own.
function angularErrorToPixel(
  panErrDeg: number, tiltErrDeg: number, focalPx: number, tiltDeg: number,
): PixelOffset {
  const c = Math.cos(tiltDeg * RAD);
  return {
    dxPx: focalPx * Math.tan(panErrDeg * c * RAD),
    dyPx: focalPx * Math.tan(tiltErrDeg * RAD),
  };
}

// predictPixel: "the tracking session's CURRENT target prediction converted
// through pixelToAngularError's inverse" (brief, Step 3). Deliberately reads
// session.status() as of NOW rather than re-deriving a time-corrected target
// aim at exposureMs -- TrackingSession has no public API for the latter
// (targetAimAt is private-state-driven, only called from tick()), and adding
// one is outside this task's file list (session.ts is not in it). The
// posture side stays exact (postures.postureAt(exposureMs), never "now"),
// which is what requirement 1 is actually about; the target side carries a
// small approximation bounded by one visionTickHz period, consistent with
// the brief's wording.
export function buildPredictPixel(
  session: TrackingSession, postures: PostureHistory, focalPx: () => number | null,
): (exposureMs: number) => PixelOffset | null {
  return (exposureMs: number) => {
    const status = session.status();
    if (status.targetPanDeg === null || status.targetTiltDeg === null) return null;
    const posture = postures.postureAt(exposureMs);
    if (posture === null) return null;
    const f = focalPx();
    if (f === null || !(f > 0)) return null;
    const panErrDeg = wrapDeg180(status.targetPanDeg - posture.panDeg);
    const tiltErrDeg = status.targetTiltDeg - posture.tiltDeg;
    const off = angularErrorToPixel(panErrDeg, tiltErrDeg, f, posture.tiltDeg);
    if (!Number.isFinite(off.dxPx) || !Number.isFinite(off.dyPx)) return null;
    return off;
  };
}

// ---------------------------------------------------------------------------
// Runtime state (requirement 3: OFF and read-only by default, mutable at
// runtime without a restart -- mirrors SunSupervisor.setConfig/
// CaptureController.setAuto).
//
// The measured scale (focalPx/latencyMs) is kept here, in memory, for the
// life of the daemon process -- NOT written to disk. The brief's Step 3 says
// calibrate_vision_scale "persists the result" but Task 8's file list has no
// dedicated store file (unlike CalibrationStore/SectorStore/LimitsStore, each
// its own file); adding one was judged out of this task's scope, so
// "persists" is satisfied at process-lifetime granularity: the result
// survives across MCP client reconnects and across get_vision_status/
// tracking-loop calls, same as every other daemon singleton, but a daemon
// restart forgets it and calibrate_vision_scale must be re-run -- exactly as
// it would if it had never been run at all. Flagged in task-8-report.md.
// ---------------------------------------------------------------------------
export interface VisionStatusSnapshot {
  enabled: boolean;
  readOnly: boolean;
  lastOutcome: CorrectorOutcome | null;
  lastCorrectionPanDeg: number | null;
  lastCorrectionTiltDeg: number | null;
  scale: ScaleResult | null;
  // Inferred from the last tick's outcome, not a fresh probe: a probe would
  // need a real frame to send and would race the correction loop's own
  // detector call. null means "no tick has run yet", not "unreachable".
  detectorReachable: boolean | null;
}

export class VisionRuntime {
  private enabled: boolean;
  private readOnly: boolean;
  private scale: ScaleResult | null = null;
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

  getScale(): ScaleResult | null { return this.scale; }
  setScale(s: ScaleResult): void { this.scale = s; }
  focalPx(): number | null { return this.scale?.focalPx ?? null; }

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
  supervisor: SunSupervisor,
  frames: FrameSource,
  detector: DetectFn,
  runtime: VisionRuntime,
  limitsProvider: () => TaughtEdges,
): void {
  server.registerTool(
    "get_vision_status",
    {
      description:
        "Vision-lock correction loop status: enabled, read-only, the last tick's outcome and " +
        "correction, the measured focalPx/latencyMs scale (see calibrate_vision_scale), and " +
        "whether the detector sidecar is reachable (inferred from the last tick, not a fresh " +
        "probe -- null means no tick has run yet).",
      inputSchema: {},
    },
    async () => {
      const s = runtime.status();
      return text(JSON.stringify({
        enabled: s.enabled,
        read_only: s.readOnly,
        last_outcome: s.lastOutcome,
        last_correction_pan_deg: round(s.lastCorrectionPanDeg, 3),
        last_correction_tilt_deg: round(s.lastCorrectionTiltDeg, 3),
        focal_px: s.scale ? Number(s.scale.focalPx.toFixed(2)) : null,
        latency_ms: s.scale ? Number(s.scale.latencyMs.toFixed(0)) : null,
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
        "daemon startup -- this is how an operator deliberately opts in.",
      inputSchema: {
        enabled: z.boolean(),
        readOnly: z.boolean().optional(),
      },
    },
    async ({ enabled, readOnly }) => {
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
      const stepDeg = step_pan_deg ?? 5;
      const windowMs = sample_window_ms ?? 4000;

      const cur = device.getState();
      const startPanDeg = applySign(stepsToDeg(cur.panSteps), cfg.panSign);
      const startTiltDeg = applySign(stepsToDeg(cur.tiltSteps), cfg.tiltSign);
      const targetPanDeg = startPanDeg + stepDeg;
      const limits = effectiveLimits(
        { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax },
        limitsProvider(),
      );
      const rangeCheck = checkPanTilt(targetPanDeg, startTiltDeg, limits);
      if (!rangeCheck.ok) return errText(rangeCheck.error!);

      // Stamped BEFORE the move is commanded -- solveStepResponse measures
      // observation latency relative to this instant, and a report claiming
      // movement before the command would be treated as a clock problem
      // and refused (see scale-calibration.ts: "latencyMs < 0").
      const stepAppliedAtMs = Date.now();
      try {
        await moveToUserAngle(device, cfg, targetPanDeg, startTiltDeg, undefined, limits);
      } catch (e) {
        return errText(`step command failed: ${(e as Error).message}`);
      }

      const obs: StepObservation[] = [];
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        const frame = frames.latest();
        if (frame) {
          const res = await detector.detect(frame.jpegBase64, cfg.visionMinConf);
          if (res && res.detections.length > 0) {
            const best = res.detections.reduce((a, b) => (b.conf > a.conf ? b : a));
            obs.push({ tMs: frame.exposureMs, dxPx: best.dxPx, dyPx: best.dyPx });
          }
        }
        await sleep(200);
      }

      const result = solveStepResponse(obs, stepAppliedAtMs, stepDeg, startTiltDeg);
      if (!result) {
        return errText(
          "step response did not resolve — no clear settled displacement in the detector's " +
          "samples (check the camera and detector are live and the target is in frame); retry " +
          "with a larger step_pan_deg or a longer sample_window_ms",
        );
      }
      runtime.setScale(result);
      return text(JSON.stringify({
        focal_px: Number(result.focalPx.toFixed(2)),
        latency_ms: Number(result.latencyMs.toFixed(0)),
        samples: obs.length,
      }));
    },
  );
}
