import { Aircraft } from "./types.js";
import { AltSource, aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";

export interface TargetSink {
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null): string | null;
  updateTarget(g: Geodetic, statedVel: Vec3 | null): string | null;
  isActive(): boolean;
}

export interface FollowerStatus { hex: string | null; lostMs: number | null; }

export class AdsbFollower {
  private hex: string | null = null;
  private firstFix = true;
  private lastSeenMs = 0;

  constructor(
    private readonly sink: TargetSink,
    private readonly altSource: AltSource,
    private readonly lostMsThreshold: number,
    private readonly now: () => number = Date.now,
  ) {}

  bind(hex: string): void {
    this.hex = hex.toLowerCase();
    this.firstFix = true;
    this.lastSeenMs = this.now();   // start the lost clock from bind
  }
  unbind(): void { this.hex = null; this.firstFix = true; this.lastSeenMs = 0; }

  status(): FollowerStatus {
    return { hex: this.hex, lostMs: this.hex === null ? null : this.now() - this.lastSeenMs };
  }

  onSnapshot(snap: { aircraft: Aircraft[] }): void {
    if (this.hex === null) return;
    // Self-heal: after acquisition, if tracking was stopped elsewhere, release.
    if (!this.firstFix && !this.sink.isActive()) { this.unbind(); return; }

    const ac = snap.aircraft.find((a) => a.hex.toLowerCase() === this.hex);
    if (!ac) {
      if (this.now() - this.lastSeenMs > this.lostMsThreshold) this.unbind();
      return;
    }
    const g = aircraftGeodetic(ac, this.altSource);
    if (!g) return;   // no usable altitude this frame; stay bound
    const vel = aircraftVelocity(ac);
    if (this.firstFix) {
      this.sink.start(g, vel, ac.callsign ?? ac.hex);
      this.firstFix = false;
    } else {
      this.sink.updateTarget(g, vel);
    }
    this.lastSeenMs = this.now();
  }
}
