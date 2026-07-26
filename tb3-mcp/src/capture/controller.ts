import type { TrackState } from "../track/session.js";

export interface CaptureDeps {
  setRecord(on: boolean): Promise<void>;
  snapshot(icao: string): Promise<string>;
  isArmed(): Promise<boolean>;
  now(): number;
  nowIso(): string;
}

export interface CaptureStatus {
  autoEnabled: boolean;
  recording: boolean;
  passIcao: string | null;
  lastSnapshot: string | null;
  lastError: string | null;
  lastSkipReason: string | null;
}

export interface CaptureControllerOpts {
  debounceMs: number;
  autoEnabled: boolean;
}

// Turns TrackState transitions into capture actions.
//
// SAFETY RULE: onTrack() is called from the tracking tick, which is real-time
// control of a physical rig. It NEVER awaits. Every capture call is
// fire-and-forget; failures are recorded and surfaced, never propagated.
export class CaptureController {
  private auto: boolean;
  private recording = false;
  private passIcao: string | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private lastSnapshot: string | null = null;
  private lastError: string | null = null;
  private lastSkipReason: string | null = null;
  // ICAO we've already warned about being disarmed for THIS pass, so the
  // retry-every-tick behavior below doesn't also log-spam every tick.
  private lastWarnedDisarmedIcao: string | null = null;

  constructor(
    private readonly deps: CaptureDeps,
    private readonly opts: CaptureControllerOpts,
  ) {
    this.auto = opts.autoEnabled;
  }

  status(): CaptureStatus {
    return {
      autoEnabled: this.auto,
      recording: this.recording,
      passIcao: this.passIcao,
      lastSnapshot: this.lastSnapshot,
      lastError: this.lastError,
      lastSkipReason: this.lastSkipReason,
    };
  }

  setAuto(on: boolean): void {
    this.auto = on;
    if (!on) this.closeNow();
  }

  onTrack(state: TrackState, icao: string | null): void {
    if (!this.auto) return;

    if (state === "tracking" && icao) {
      // Same aircraft, still the current pass: cancel a pending close so a
      // flap through "waiting" cannot fragment the clip or re-snapshot.
      if (this.passIcao === icao) { this.cancelClose(); return; }
      this.beginPass(icao);
      return;
    }

    // Left "tracking". Start the grace timer; only a timer that actually
    // expires closes the valve and clears the pass.
    //
    // This also covers a disarmed pass, where passIcao is null on every
    // tick (the disarmed branch in beginPass() clears it immediately so
    // the NEXT tick retries). Gating solely on `passIcao !== null` would
    // make this branch unreachable for a disarmed pass, so the debounce
    // that resets the warn-throttle tracker (lastWarnedDisarmedIcao) would
    // never fire and a genuine repeat visit would stay silently
    // unwarned forever. Gate on either bookkeeping field being live.
    if ((this.passIcao !== null || this.lastWarnedDisarmedIcao !== null) && this.closeTimer === null) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        this.closeNow();
      }, this.opts.debounceMs);
    }
  }

  async manualSnapshot(icao?: string): Promise<string> {
    const p = await this.deps.snapshot(icao ?? "manual");
    this.lastSnapshot = p;
    return p;
  }

  // A manual setRecording(false) deliberately suppresses automatic
  // re-engagement for the REST OF THE CURRENT PASS: this does not clear
  // passIcao. If it did, the very next "tracking" tick for the same
  // aircraft would immediately re-open the valve via auto-capture, making
  // the operator's Stop control inert -- they press it and recording
  // resumes a fraction of a second later. The suppression is not
  // permanent: closeNow() clears passIcao when the pass actually ends, so
  // re-acquiring the same aircraft afterward starts a fresh pass normally.
  async setRecording(on: boolean): Promise<void> {
    await this.deps.setRecord(on);
    this.recording = on;
  }

  dispose(): void { this.cancelClose(); }

  private beginPass(icao: string): void {
    this.cancelClose();
    this.passIcao = icao;
    // Fire-and-forget: the tracking tick must not wait on the camera.
    void this.deps.isArmed().then((armed) => {
      if (!armed) {
        // Stop is a hard release. Never auto-arm; report and move on.
        this.lastSkipReason = `camera disarmed at lock on ${icao}; capture skipped`;
        // Retry every tick so capture can start the moment the operator
        // arms mid-pass, but only WARN once per pass -- onTrack runs at
        // tracking-tick frequency and logging on every tick would spam.
        if (this.lastWarnedDisarmedIcao !== icao) {
          console.warn(`[tb3-capture] ${this.lastSkipReason}`);
          this.lastWarnedDisarmedIcao = icao;
        }
        this.passIcao = null;
        return;
      }
      this.lastSkipReason = null;
      this.lastWarnedDisarmedIcao = null;  // pass began; a later disarmed pass warns again
      void this.deps.snapshot(icao)
        .then((p) => { this.lastSnapshot = p; })
        .catch((e: unknown) => this.recordError("snapshot", e));
      void this.deps.setRecord(true)
        .then(() => { this.recording = true; })
        .catch((e: unknown) => this.recordError("record on", e));
    }).catch((e: unknown) => {
      // Symmetric with the disarmed path above: a transient isArmed()
      // rejection must not permanently disable capture for the rest of
      // this pass. Clear passIcao so the very next tick retries via
      // beginPass() instead of hitting the same-ICAO dedup branch forever.
      this.passIcao = null;
      this.recordError("isArmed", e);
    });
  }

  private closeNow(): void {
    this.cancelClose();
    this.passIcao = null;   // cleared, so a genuine return is a NEW pass
    this.lastWarnedDisarmedIcao = null;  // a later disarmed pass warns again
    if (!this.recording) return;
    void this.deps.setRecord(false)
      .then(() => { this.recording = false; })
      .catch((e: unknown) => this.recordError("record off", e));
  }

  private cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  private recordError(what: string, e: unknown): void {
    this.lastError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    // Never silently not-happen.
    console.error(`[tb3-capture] ${this.lastError}`);
  }
}
