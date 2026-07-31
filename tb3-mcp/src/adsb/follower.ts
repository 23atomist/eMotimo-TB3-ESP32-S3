import { Aircraft } from "./types.js";
import { AltSource, aircraftGeodetic, aircraftVelocity } from "./convert.js";
import { Geodetic } from "../geo/wgs84.js";
import { Vec3 } from "../geo/vec3.js";

export interface TargetSink {
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null, hex: string | null, fixAgeSec?: number): string | null;
  updateTarget(g: Geodetic, statedVel: Vec3 | null, fixAgeSec?: number): string | null;
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
    // (Deliberate release path: stop_tracking does not reach into the follower
    // to unbind it directly, to keep L3 track-tools from depending on L4.)
    if (!this.firstFix && !this.sink.isActive()) { this.unbind(); return; }

    // Default to no error for this frame; only the sink-rejection branch below
    // overwrites it, so an absent/altitude-less frame clears a stale error.
    this.lastError = null;

    let usable = false;
    const ac = snap.aircraft.find((a) => a.hex.toLowerCase() === this.hex);
    if (ac) {
      const g = aircraftGeodetic(ac, this.altSource);
      if (g) {
        const vel = aircraftVelocity(ac);
        // label keeps the callsign-preferred fallback (human-facing); hex is
        // passed separately and always, so the sink's dedup identity never
        // depends on whether a callsign has been broadcast yet.
        const err = this.firstFix
          // seen_pos: how old this POSITION already was when tar1090/readsb
          // handed it over. Passing it is what stops the rig pointing where
          // the aircraft was rather than where it is (field, 2026-07-30).
          ? this.sink.start(g, vel, ac.callsign ?? ac.hex, ac.hex, ac.seenPosSec ?? 0)
          : this.sink.updateTarget(g, vel, ac.seenPosSec ?? 0);
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
