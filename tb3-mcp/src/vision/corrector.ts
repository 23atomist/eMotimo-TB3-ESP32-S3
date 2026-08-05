import { FrameSource } from "./frame-source.js";
import { DetectorClient } from "./detector-client.js";
import { PostureHistory } from "./posture-history.js";
import { gateDetections, GateReject } from "./gate.js";
import { PixelOffset, pixelToAngularError, fovDegFromFocalPx, AxisSigns } from "./geometry.js";

export type CorrectorOutcome =
  | "applied" | "read_only" | "no_frame" | "no_posture" | "no_prediction"
  | "detector_unavailable" | GateReject | "over_sanity_bound" | "no_scale";

export interface CorrectorDeps {
  frames: FrameSource;
  detector: DetectorClient;
  postures: PostureHistory;
  predictPixel: (exposureMs: number) => PixelOffset | null;
  applyOffset: (dPanDeg: number, dTiltDeg: number) => void;
  focalPx: () => number | null;
  // Measured camera handedness (calibrate_vision_scale's axisSigns; see
  // geometry.ts's own doc). Defaulted at the call site (server.ts) to
  // NOMINAL_AXIS_SIGNS when nothing has been measured yet, mirroring how
  // focalPx()'s null already means "not calibrated".
  axisSigns: () => AxisSigns;
  frameSizePx: () => { widthPx: number; heightPx: number };
  gain: () => number;
  readOnly: () => boolean;
  gateRadiusPx: () => number;
  minConf: () => number;
  log: (outcome: CorrectorOutcome, detail: Record<string, unknown>) => void;
}

export class VisionCorrector {
  constructor(private readonly d: CorrectorDeps) {}

  async tick(): Promise<CorrectorOutcome> {
    const done = (o: CorrectorOutcome, detail: Record<string, unknown> = {}) => {
      this.d.log(o, detail); return o;
    };

    const frame = this.d.frames.latest();
    if (frame === null) return done("no_frame");

    const focalPx = this.d.focalPx();
    // !(x > 0) rather than === null: a focalPx of 0 implies a 180deg field of
    // view and a 90deg bound, which would wave a 27deg correction through as
    // "applied"; a NaN would defeat every comparison downstream.
    if (focalPx === null || !(focalPx > 0)) return done("no_scale");

    // THE INVARIANT: posture at EXPOSURE, never the present.
    const posture = this.d.postures.postureAt(frame.exposureMs);
    if (posture === null) return done("no_posture", { exposureMs: frame.exposureMs });

    const predicted = this.d.predictPixel(frame.exposureMs);
    // Its OWN reason: "the ring buffer has no posture for that instant" and
    // "ADS-B has no prediction for this aircraft right now" are different
    // faults with different remedies.
    if (predicted === null) return done("no_prediction", { exposureMs: frame.exposureMs });

    const res = await this.d.detector.detect(frame.jpegBase64, this.d.minConf());
    if (res === null) return done("detector_unavailable");

    const gated = gateDetections(res.detections, predicted, this.d.gateRadiusPx(), this.d.minConf());
    if ("rejected" in gated) return done(gated.rejected);

    const err = pixelToAngularError(
      { dxPx: gated.accepted.dxPx, dyPx: gated.accepted.dyPx }, focalPx, posture.tiltDeg,
      this.d.axisSigns(),
    );
    const g = this.d.gain();
    const panDeg = g * err.panDeg, tiltDeg = g * err.tiltDeg;

    // Sanity bound in FOV terms so it survives a zoom: a correction implying
    // the aircraft is further off-axis than the frame can see is
    // self-contradictory. DISCARD -- clamping would apply a wrong answer at
    // reduced magnitude.
    const { widthPx, heightPx } = this.d.frameSizePx();
    const narrowerFovDeg = Math.min(
      fovDegFromFocalPx(widthPx, focalPx), fovDegFromFocalPx(heightPx, focalPx),
    );
    const bound = narrowerFovDeg / 2;
    // Negated <= rather than >: `NaN > bound` is false, so a NaN correction
    // would sail through the one guard meant to stop nonsense -- and
    // nudgeOffset's clamp PROPAGATES NaN, latching the aim offset permanently
    // with no subsequent nudge able to recover it. Fail closed.
    if (!(Math.hypot(panDeg, tiltDeg) <= bound)) {
      return done("over_sanity_bound", { panDeg, tiltDeg, bound });
    }

    if (this.d.readOnly()) return done("read_only", { panDeg, tiltDeg });

    this.d.applyOffset(panDeg, tiltDeg);
    return done("applied", { panDeg, tiltDeg });
  }
}
