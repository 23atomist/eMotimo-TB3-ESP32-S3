import { AimOffset } from "../track/offset.js";
import { FrameSource } from "./frame-source.js";
import { DetectorClient } from "./detector-client.js";
import { PostureHistory } from "./posture-history.js";
import { gateDetections, GateReject } from "./gate.js";
import { PixelOffset, pixelToAngularError, fovDegFromFocalPx } from "./geometry.js";

export type CorrectorOutcome =
  | "applied" | "read_only" | "no_frame" | "no_posture"
  | "detector_unavailable" | GateReject | "over_sanity_bound" | "no_scale";

export interface CorrectorDeps {
  frames: FrameSource;
  detector: DetectorClient;
  postures: PostureHistory;
  predictPixel: (exposureMs: number) => PixelOffset | null;
  getOffset: () => AimOffset;
  applyOffset: (dPanDeg: number, dTiltDeg: number) => void;
  focalPx: () => number | null;
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
    if (focalPx === null) return done("no_scale");

    // THE INVARIANT: posture at EXPOSURE, never the present.
    const posture = this.d.postures.postureAt(frame.exposureMs);
    if (posture === null) return done("no_posture", { exposureMs: frame.exposureMs });

    const predicted = this.d.predictPixel(frame.exposureMs);
    if (predicted === null) return done("no_posture", { exposureMs: frame.exposureMs });

    const res = await this.d.detector.detect(frame.jpegBase64, this.d.minConf());
    if (res === null) return done("detector_unavailable");

    const gated = gateDetections(res.detections, predicted, this.d.gateRadiusPx(), this.d.minConf());
    if ("rejected" in gated) return done(gated.rejected);

    const err = pixelToAngularError(
      { dxPx: gated.accepted.dxPx, dyPx: gated.accepted.dyPx }, focalPx, posture.tiltDeg,
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
    if (Math.hypot(panDeg, tiltDeg) > bound) {
      return done("over_sanity_bound", { panDeg, tiltDeg, bound });
    }

    if (this.d.readOnly()) return done("read_only", { panDeg, tiltDeg });

    this.d.applyOffset(panDeg, tiltDeg);
    return done("applied", { panDeg, tiltDeg });
  }
}
