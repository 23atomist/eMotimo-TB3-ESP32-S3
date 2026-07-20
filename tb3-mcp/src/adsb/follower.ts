import { Aircraft } from "./types.js";
import { AltSource, aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";

export interface TargetSink {
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null): string | null;
  updateTarget(g: Geodetic, statedVel: Vec3 | null): string | null;
  isActive(): boolean;
}

export interface FollowerStatus { hex: string | null; lostMs: number | null; lastError: string | null; }

export class AdsbFollower {
  private hex: string | null = null;
  private firstFix = true;
  private lastSeenMs = 0;              // time of the last USABLE fix (or of bind)
  private lastError: string | null = null;

  constructor(
    private readonly sink: TargetSink,
    private readonly altSource: AltSource,
    private readonly lostMsThreshold: number,
    private readonly now: () => number = Date.now,
  ) {}

  bind(hex: string): void {
    this.hex = hex.toLowerCase();
    this.firstFix = true;
    this.lastSeenMs = this.now();       // start the lost-clock from bind
    this.lastError = null;
  }
  unbind(): void { this.hex = null; this.firstFix = true; this.lastSeenMs = 0; this.lastError = null; }

  status(): FollowerStatus {
    return {
      hex: this.hex,
      lostMs: this.hex === null ? null : this.now() - this.lastSeenMs,
      lastError: this.lastError,
    };
  }

  onSnapshot(snap: { aircraft: Aircraft[] }): void {
    if (this.hex === null) return;
    // Self-heal: after acquisition, if tracking was stopped elsewhere, release.
    if (!this.firstFix && !this.sink.isActive()) { this.unbind(); return; }

    let usable = false;
    const ac = snap.aircraft.find((a) => a.hex.toLowerCase() === this.hex);
    if (ac) {
      const g = aircraftGeodetic(ac, this.altSource);
      if (g) {
        const vel = aircraftVelocity(ac);
        const err = this.firstFix
          ? this.sink.start(g, vel, ac.callsign ?? ac.hex)
          : this.sink.updateTarget(g, vel);
        if (err === null) {
          this.firstFix = false;
          this.lastSeenMs = this.now();
          this.lastError = null;
          usable = true;
        } else {
          // Sink refused (e.g. not calibrated). Do NOT advance firstFix — retry
          // next frame — and surface the error instead of swallowing it.
          this.lastError = err;
        }
      }
    }
    // No usable fix this snapshot (absent, no usable altitude, or sink error):
    // release once we've had none for longer than the lost threshold, so a
    // target we cannot actually point at is never held indefinitely.
    if (!usable && this.now() - this.lastSeenMs > this.lostMsThreshold) this.unbind();
  }
}
