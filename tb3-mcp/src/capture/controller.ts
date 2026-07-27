import type { TrackState } from "../track/session.js";

export interface CaptureDeps {
  setRecord(on: boolean): Promise<void>;
  // `callsign` is resolved by the CALLER at the moment the pass begins (see
  // CaptureController.onTrack/beginPass) and carried through unchanged --
  // never re-derived here, and never re-derived after any await, because by
  // then the session this icao/callsign pair was true of may have moved on.
  snapshot(icao: string, callsign: string | null): Promise<string>;
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
  // The callsign that was true WHEN THIS PASS BEGAN, stored alongside
  // passIcao for the same reason: beginPass()'s own closure-captured
  // `callsign` parameter is what actually reaches deps.snapshot() (see
  // beginPass below), but this field keeps the pair visible as one unit on
  // the instance, matching passIcao's lifecycle exactly (set together,
  // cleared together).
  private passCallsign: string | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  // A pending retry of a FAILED setRecord(false) close (see attemptClose).
  // Separate from closeTimer, which debounces WHETHER to close at all;
  // this one only ever fires a retry of a close that's already underway.
  private closeRetryTimer: NodeJS.Timeout | null = null;
  // Bumped every time a NEW pass begins (beginPass). Lets a close-retry
  // scheduled by an EARLIER pass recognize it has been superseded -- e.g. a
  // transient setRecord(false) failure at the end of pass A schedules a
  // retry, but pass B begins (and successfully opens the valve) before that
  // retry fires: the stale retry must not then close B's valve out from
  // under it. See attemptClose.
  private closeGeneration = 0;
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

  // `callsign` defaults to null so existing 2-arg callers (tests) keep
  // compiling; production wiring (see server.ts's onStateChange listener)
  // always supplies it, resolved synchronously at the exact instant this
  // transition is observed -- see beginPass() for why that timing matters.
  onTrack(state: TrackState, icao: string | null, callsign: string | null = null): void {
    if (!this.auto) return;

    if (state === "tracking" && icao) {
      // Same aircraft, still the current pass: cancel a pending close so a
      // flap through "waiting" cannot fragment the clip or re-snapshot.
      if (this.passIcao === icao) { this.cancelClose(); return; }
      this.beginPass(icao, callsign);
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

  // Independent of tracking: no callsign concept applies here, and none is
  // borrowed from whatever the rig happens to be auto-tracking right now --
  // always null, deliberately.
  async manualSnapshot(icao?: string): Promise<string> {
    const p = await this.deps.snapshot(icao ?? "manual", null);
    this.lastSnapshot = p;
    this.clearError();
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
    this.clearError();
  }

  dispose(): void { this.cancelClose(); this.cancelCloseRetry(); }

  // Lets a startup-time preflight check (e.g. an unusable captureFfmpegBin --
  // see src/capture/ffmpeg-preflight.ts and src/server.ts's main()) surface
  // into status().lastError using the exact same field a runtime capture
  // failure already writes to. Without this, a bad daemon config is
  // invisible until the first real (silently failing) snapshot attempt;
  // with it, the SAME "Capture: ERROR" chip an operator already knows to
  // watch for is lit from t=0.
  reportError(what: string, e: unknown): void { this.recordError(what, e); }

  private beginPass(icao: string, callsign: string | null): void {
    this.cancelClose();
    this.passIcao = icao;
    this.passCallsign = callsign;
    // A new pass supersedes any close-retry still pending from the PREVIOUS
    // pass's failed setRecord(false) -- see attemptClose's gen check. That
    // old retry must never fire setRecord(false) against THIS pass's valve.
    this.closeGeneration++;
    // Fire-and-forget: the tracking tick must not wait on the camera.
    //
    // isArmed() is a real network round-trip (MediaMTX path-ready check),
    // and the tracking tick runs at ~10Hz -- many ticks can elapse before
    // this resolves. The session can be retargeted to a different aircraft
    // during that window (autonomous-agent retask, operator switching
    // targets), which would make `this.passIcao`/`this.passCallsign` stale
    // by the time this callback runs. Every use below therefore reads the
    // CLOSURE-captured `icao`/`callsign` parameters -- fixed at the instant
    // this pass began -- never `this.passIcao`/`this.passCallsign`, which
    // exist only as the externally-visible "current pass" bookkeeping.
    void this.deps.isArmed().then((armed) => {
      // The rig may have already retargeted to a DIFFERENT pass by the time
      // this resolves (see the comment above) -- if so, this pass is stale:
      // taking a snapshot/opening the valve now would capture/label whatever
      // the rig is CURRENTLY pointed at under this pass's icao/callsign,
      // silently mislabeling the evidence. Drop it instead; the pass that
      // superseded this one already ran (or is running) its own beginPass().
      if (this.passIcao !== icao) return;
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
        this.passCallsign = null;
        return;
      }
      this.lastSkipReason = null;
      this.lastWarnedDisarmedIcao = null;  // pass began; a later disarmed pass warns again
      void this.deps.snapshot(icao, callsign)
        .then((p) => { this.lastSnapshot = p; this.clearError(); })
        .catch((e: unknown) => this.recordError("snapshot", e));
      void this.deps.setRecord(true)
        .then(() => { this.recording = true; this.clearError(); })
        .catch((e: unknown) => this.recordError("record on", e));
    }).catch((e: unknown) => {
      // Symmetric with the disarmed path above: a transient isArmed()
      // rejection must not permanently disable capture for the rest of
      // this pass. Clear passIcao so the very next tick retries via
      // beginPass() instead of hitting the same-ICAO dedup branch forever.
      this.passIcao = null;
      this.passCallsign = null;
      this.recordError("isArmed", e);
    });
  }

  private closeNow(): void {
    this.cancelClose();
    this.passIcao = null;   // cleared, so a genuine return is a NEW pass
    this.passCallsign = null;
    this.lastWarnedDisarmedIcao = null;  // a later disarmed pass warns again
    if (!this.recording) return;
    this.attemptClose(this.closeGeneration);
  }

  // Closes the record valve, retrying a failed attempt so a transient
  // setRecord(false) failure doesn't leave MediaMTX recording indefinitely
  // -- the inverse failure from the one this whole branch exists to fix
  // (STARTING forever), just for the recorder instead of the video tile.
  // `gen` pins this attempt (and any retry of it) to the pass that was
  // ending when closeNow() called it; see beginPass's closeGeneration bump.
  private attemptClose(gen: number): void {
    if (gen !== this.closeGeneration) return; // superseded -- a newer pass now owns the valve
    this.cancelCloseRetry();
    void this.deps.setRecord(false)
      .then(() => {
        if (gen !== this.closeGeneration) return; // ditto -- don't clobber the newer pass's state
        this.recording = false;
        this.clearError();
      })
      .catch((e: unknown) => {
        this.recordError("record off", e);
        if (gen !== this.closeGeneration || !this.recording) return;
        this.closeRetryTimer = setTimeout(() => {
          this.closeRetryTimer = null;
          this.attemptClose(gen);
        }, this.opts.debounceMs);
      });
  }

  private cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  private cancelCloseRetry(): void {
    if (this.closeRetryTimer) { clearTimeout(this.closeRetryTimer); this.closeRetryTimer = null; }
  }

  private clearError(): void { this.lastError = null; }

  private recordError(what: string, e: unknown): void {
    this.lastError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    // Never silently not-happen.
    console.error(`[tb3-capture] ${this.lastError}`);
  }
}
