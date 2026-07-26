// The camera tile's dual-pipeline state machine.
//
// Exactly one of a WebRTC (WHEP) <video> or an MJPEG <img> is ever attached,
// picked at runtime by pickCameraMode() (camera-mode.js) from the SSE
// state's camera field. This IS the rig's escape hatch for a brand-new
// MediaMTX dependency on a roof-mounted rig: if WebRTC misbehaves, flipping
// cameraSource back to mtplvcap/v4l2 in config.json and restarting must
// produce a working picture, not a dead panel -- so the two pipelines must
// never both be live, and switching between them must fully tear down
// whichever one was previously active before the other attaches.
//
// DOM elements and the WHEP session are injected (constructor deps) rather
// than reached for via document/window, so this whole machine -- teardown-
// before-switch, both retry-timer guards, the no-op-on-unchanged-source
// path -- can be pinned by vitest without a browser (see
// test/camera-panel.test.ts), the same way minimap.js/rigmath.js are.
import { pickCameraMode } from "./camera-mode.js";

const WHEP_RETRY_MS = 3000;
const MJPEG_RETRY_MS = 4000;

export class CameraPanel {
  // deps:
  //   video           -- the WebRTC <video> surface (.hidden, .srcObject)
  //   img             -- the MJPEG <img> surface (.hidden, .src,
  //                       .removeAttribute, .addEventListener("error"/"load"))
  //   frame           -- the tile wrapper (.classList.add/remove); optional,
  //                       matching app.js's existing `el.cameraFrame?.` usage
  //   makeWhepSession -- () => an object shaped like whep.js's WhepSession
  //                       (state()/connect(videoEl)/close()); only invoked
  //                       lazily, on first entering webrtc mode, so a fake
  //                       can stand in under test with no real WebRTC
  constructor({ video, img, frame, makeWhepSession }) {
    this.video = video;
    this.img = img;
    this.frame = frame ?? null;
    this.makeWhepSession = makeWhepSession;

    // "webrtc" | "mjpeg" | null before the first sync().
    this.mode = null;

    // WHEP (WebRTC) session state -- only touched while mode is "webrtc".
    this.whep = null;
    this.whepRetryTimer = null;

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
