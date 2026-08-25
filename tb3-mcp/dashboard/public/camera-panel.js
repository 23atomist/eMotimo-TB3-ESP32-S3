// The camera tile's dual-pipeline state machine.
//
// Exactly one of a WebRTC (WHEP) <video> or an MJPEG <img> is ever attached,
// picked at runtime by pickCameraMode() (camera-mode.js) from the SSE
// state's camera field. This IS the rig's escape hatch for the MediaMTX
// dependency on a roof-mounted rig: if WebRTC misbehaves, flipping
// cameraSource to v4l2 in config.json and restarting must produce a working
// picture, not a dead panel -- so the two pipelines must never both be
// live, and switching between them must fully tear down whichever one was
// previously active before the other attaches.
//
// DOM elements and the WHEP session are injected (constructor deps) rather
// than reached for via document/window, so this whole machine -- teardown-
// before-switch, both retry-timer guards, the no-op-on-unchanged-source
// path -- can be pinned by vitest without a browser (see
// test/camera-panel.test.ts), the same way minimap.js/rigmath.js are.
import { pickCameraMode } from "./camera-mode.js";
import { computeVideoStats, formatVideoStats } from "./video-stats.js";

const WHEP_RETRY_MS = 3000;
const MJPEG_RETRY_MS = 4000;
const STATS_POLL_MS = 1000;

export class CameraPanel {
  // deps:
  //   video           -- the WebRTC <video> surface (.hidden, .srcObject)
  //   img             -- the MJPEG <img> surface (.hidden, .src,
  //                       .removeAttribute, .addEventListener("error"/"load"))
  //   frame           -- the tile wrapper (.classList.add/remove); optional,
  //                       matching app.js's existing `el.cameraFrame?.` usage
  //   statsEl         -- the video-health readout element (.hidden,
  //                       .textContent, .className); optional -- when
  //                       omitted, no stats are polled (this is a debugging
  //                       instrument, not a required surface). Only ever
  //                       shown on the WebRTC path: the MJPEG fallback has no
  //                       equivalent getStats() source, and showing zeros
  //                       there would look like a fault that isn't real.
  //   makeWhepSession -- () => an object shaped like whep.js's WhepSession
  //                       (state()/connect(videoEl)/close()/stats()); only
  //                       invoked lazily, on first entering webrtc mode, so a
  //                       fake can stand in under test with no real WebRTC
  constructor({ video, img, frame, statsEl, makeWhepSession }) {
    this.video = video;
    this.img = img;
    this.frame = frame ?? null;
    this.statsEl = statsEl ?? null;
    this.makeWhepSession = makeWhepSession;

    // "webrtc" | "mjpeg" | null before the first sync().
    this.mode = null;

    // WHEP (WebRTC) session state -- only touched while mode is "webrtc".
    this.whep = null;
    this.whepRetryTimer = null;

    // Video-health poll state (also webrtc-only). statsPollTimer follows the
    // exact same lifecycle discipline as whepRetryTimer/mjpegRetryTimer
    // below: started when the WHEP path is live, cleared on teardown/mode-
    // switch/disable, never stacked. prevStatsSample is the previous
    // getStats() sample fed to computeVideoStats() (video-stats.js) to turn
    // cumulative counters into a rate; reset to null whenever polling
    // (re)starts so a stale sample from a torn-down connection is never
    // diffed against a fresh one.
    this.statsPollTimer = null;
    this.prevStatsSample = null;
    this._statsPending = false;

    // MJPEG retry state -- only touched while mode is "mjpeg".
    this.mjpegAttached = false;
    this.mjpegRetryTimer = null;

    // The <img> shows the browser's broken-image icon with no recovery when
    // the multipart stream drops. Instead: on load failure, flag it and
    // periodically retry (cache-busted) until the stream comes back. Guarded
    // on mode === "mjpeg" in both handlers below so a stray event from an
    // already-torn-down <img> (e.g. right after a switch to "webrtc") can't
    // resurrect this retry loop for a hidden, inactive element -- exactly
    // the cross-pipeline interference that must never happen.
    this.img.addEventListener("error", () => this._markMjpegDown());
    this.img.addEventListener("load", () => this._markMjpegUp());
  }

  // Called once per SSE tick with the state's `camera` field.
  sync(cameraState) {
    const mode = pickCameraMode(cameraState);
    const enabled = !!(cameraState && cameraState.enabled);
    if (mode !== this.mode) {
      this._teardown(this.mode);
      this.mode = mode;
    }
    this.video.hidden = mode !== "webrtc";
    this.img.hidden = mode !== "mjpeg";
    if (mode === "webrtc") this._syncWhep(enabled);
    else this._syncMjpeg(enabled);
    // Only ever shown on the WebRTC path, and only while the camera is
    // actually armed -- otherwise it would show "0 fps · 0 kbps" over the
    // existing "Camera off — press Start" placeholder, which reads as a
    // fault when nothing is actually wrong.
    if (this.statsEl) this.statsEl.hidden = mode !== "webrtc" || !enabled;
  }

  // Fully releases whichever surface was previously live -- two consumers
  // racing one tile is exactly the bug a silent black/broken rectangle
  // would hide. Called BEFORE this.mode flips to the new value.
  _teardown(mode) {
    if (mode === "webrtc") {
      if (this.whep) { this.whep.close(); this.whep = null; }
      this.video.srcObject = null;
      if (this.whepRetryTimer) { clearTimeout(this.whepRetryTimer); this.whepRetryTimer = null; }
      this.frame?.classList.remove("camera-error");
      this._stopStatsPoll();
    } else if (mode === "mjpeg") {
      this.mjpegAttached = false;
      // removeAttribute, not src="" -- an empty string src reloads the page
      // in old browsers; removing the attribute cleanly drops the connection.
      this.img.removeAttribute("src");
      if (this.mjpegRetryTimer) { clearTimeout(this.mjpegRetryTimer); this.mjpegRetryTimer = null; }
      this.frame?.classList.remove("camera-down");
    }
  }

  // On the MediaMTX path the <video> is attached on demand rather than held
  // open like the old <img>: a peer connection to a disarmed camera would
  // just sit black. Retry is bounded and visible -- a silent black rectangle
  // is the one regression WebRTC could introduce over the MJPEG <img>.
  // Re-invoked on every SSE tick (sync() runs once per state push, ~1/s), so
  // once whepRetryTimer clears, the next tick retries automatically.
  _syncWhep(enabled) {
    // Independent of the negotiation/retry branches below: the video-health
    // readout should track "is the camera armed", not "is the current
    // connection attempt settled" -- while a retry is pending, whep.stats()
    // correctly reports "not receiving" rather than the poll simply stopping.
    if (enabled) this._startStatsPoll(); else this._stopStatsPoll();

    if (enabled && (!this.whep || this.whep.state() === "failed" || this.whep.state() === "idle")) {
      if (this.whepRetryTimer) return;
      this.whep = this.whep || this.makeWhepSession();
      this.whep.connect(this.video).catch(() => {
        if (this.mode !== "webrtc") return; // superseded by a mode switch
        this.frame?.classList.add("camera-error");
        this.whepRetryTimer = setTimeout(() => { this.whepRetryTimer = null; }, WHEP_RETRY_MS);
      });
      this.frame?.classList.remove("camera-error");
    } else if (!enabled && this.whep) {
      this.whep.close();
      this.video.srcObject = null;
    }
  }

  // Starts the ~1/s getStats() poll. Idempotent (a timer already running is
  // left alone) so repeated sync() ticks while connected never stack a
  // second interval -- the same discipline whepRetryTimer/mjpegRetryTimer
  // use above. No-ops entirely when there's nowhere to render the result.
  _startStatsPoll() {
    if (this.statsPollTimer || !this.statsEl) return;
    this.prevStatsSample = null;
    this.statsPollTimer = setInterval(() => this._pollStats(), STATS_POLL_MS);
  }

  // Clears the poll timer and any stale sample/text -- called on teardown
  // (mode switch away from webrtc) and whenever the camera is disabled, so
  // no interval ever outlives the connection it was measuring.
  _stopStatsPoll() {
    if (this.statsPollTimer) { clearInterval(this.statsPollTimer); this.statsPollTimer = null; }
    this.prevStatsSample = null;
    if (this.statsEl) this.statsEl.textContent = "";
  }

  // getStats() is async, so a slow call could in principle still be in
  // flight when the next 1s tick fires -- _statsPending guards against
  // overlapping polls stacking up. The mode re-check after the await guards
  // against a mode switch landing while this was in flight (the same
  // stale-callback hazard the WHEP connect().catch() above already guards
  // against): without it, a late resolution could write video-health text
  // into a statsEl that's now hidden behind the MJPEG surface.
  async _pollStats() {
    if (!this.whep || this.mode !== "webrtc" || this._statsPending) return;
    this._statsPending = true;
    try {
      const sample = await this.whep.stats();
      if (this.mode !== "webrtc") return;
      const computed = computeVideoStats(this.prevStatsSample, sample);
      this.prevStatsSample = sample;
      if (this.statsEl) {
        const { text, cls } = formatVideoStats(computed);
        this.statsEl.textContent = text;
        this.statsEl.className = "video-stats " + cls;
      }
    } finally {
      this._statsPending = false;
    }
  }

  // The MJPEG backend (CameraStreamer) keeps its multipart stream open even
  // when the camera is logically "disabled" -- it pushes a placeholder JPEG
  // instead of touching the USB device, so (unlike WHEP) there's no
  // enable-driven attach/detach here; the .camera-off class (set by app.js's
  // renderCamera) already communicates the armed state. This only needs to
  // attach the <img> once per mode activation; _markMjpegDown/_markMjpegUp
  // own the retry loop from there via the <img>'s own error/load events.
  _syncMjpeg(_enabled) {
    if (!this.mjpegAttached) {
      this.mjpegAttached = true;
      this.img.src = "/camera/stream";
    }
  }

  _markMjpegDown() {
    if (this.mode !== "mjpeg") return;
    this.frame?.classList.add("camera-down");
    this._scheduleMjpegRetry();
  }

  _markMjpegUp() {
    if (this.mode !== "mjpeg") return;
    this.frame?.classList.remove("camera-down");
    if (this.mjpegRetryTimer !== null) {
      clearTimeout(this.mjpegRetryTimer);
      this.mjpegRetryTimer = null;
    }
  }

  _scheduleMjpegRetry() {
    if (this.mjpegRetryTimer !== null) return; // a retry is already pending
    this.mjpegRetryTimer = setTimeout(() => {
      this.mjpegRetryTimer = null;
      if (this.mode !== "mjpeg") return; // superseded by a mode switch
      this.img.src = "/camera/stream?retry=" + Date.now();
    }, MJPEG_RETRY_MS);
  }
}
