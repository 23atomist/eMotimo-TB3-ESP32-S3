// WHEP (WebRTC-HTTP Egress Protocol) client over the native RTCPeerConnection.
// Deliberately dependency-free: the dashboard is vanilla JS with no build step.
//
// The pure helpers are exported separately so vitest can cover them without a
// browser; WhepSession itself needs real WebRTC and is verified on-host.

export function whepUrl(query) {
  return "/camera/whep" + (query || "");
}

export function sdpLooksValid(body) {
  return typeof body === "string" && body.startsWith("v=0");
}

// Attaches a remote WHEP track to <video> and starts playback. Exported so
// this -- the one place both known "negotiated fine, picture still black"
// failure modes live -- can be pinned by vitest without a real
// RTCPeerConnection:
//
//   1. MediaMTX's answer may not associate a MediaStream with the track
//      event at all (depends on the answerer's SDP), leaving
//      `ev.streams[0]` undefined. Fall back to wrapping the bare track.
//   2. Safari routinely refuses to autoplay a MediaStream assigned to a
//      <video> that was `hidden` (display:none) at the moment `srcObject`
//      was set -- the `autoplay` attribute alone isn't enough -- so this
//      also drives playback explicitly via `.play()`.
//
// Never throws, and the returned promise never rejects: a play() rejection
// is an autoplay-policy block, not a bug, but it must not vanish silently
// either -- a connected-but-black <video> with no error is exactly the
// regression this component exists to prevent. Callers get an explicit
// `{ ok: true } | { ok: false, error }` result instead of a thrown/rejected
// promise, so they can decide how to surface it (see connect() below).
export async function attachTrack(videoEl, ev) {
  const stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
  videoEl.srcObject = stream;
  try {
    await videoEl.play();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Pulls the inbound-rtp/video sample out of a raw
// RTCPeerConnection.getStats() report (a Map-like RTCStatsReport, keyed by
// report id). Exported separately from WhepSession.stats() -- which just
// awaits pc.getStats() and hands the result here -- so this parsing step is
// testable with a plain Map stand-in, no real RTCPeerConnection required
// (same reasoning as attachTrack() above). Returns null if there's no pc
// (nothing to report yet) or no matching report (e.g. immediately after
// connect(), before the first RTP packet has landed). Missing numeric
// fields default to 0 rather than undefined, so a caller can feed the result
// straight into computeVideoStats() (video-stats.js) without a null check.
export function extractVideoSample(report) {
  if (!report) return null;
  for (const entry of report.values()) {
    if (entry && entry.type === "inbound-rtp" && entry.kind === "video") {
      return {
        timestamp: entry.timestamp,
        bytesReceived: entry.bytesReceived ?? 0,
        framesDecoded: entry.framesDecoded ?? 0,
        frameWidth: entry.frameWidth ?? 0,
        frameHeight: entry.frameHeight ?? 0,
      };
    }
  }
  return null;
}

export class WhepSession {
  constructor(query) {
    this.query = query || "";
    this.pc = null;
    this.resource = null;
    this._state = "idle";
    this._playError = null;
  }

  state() { return this._state; }

  // The Error from a rejected play() (see attachTrack above), if that's what
  // most recently drove state() to "failed" -- null otherwise. Not required
  // by camera-panel.js's retry loop (which only reads state()), but without
  // this the operator-facing reason for a black picture ("connected fine,
  // browser just wouldn't play it") would be discoverable nowhere, not even
  // in a debugger.
  playError() { return this._playError; }

  // The one source that can tell "receiving RTP but not decoding it" (data
  // arrives, the <video> stays black, no error anywhere) apart from either
  // "healthy" or "transport is down" -- see video-stats.js. Returns null
  // when there's no live peer connection to ask (idle/closed) or no
  // inbound-rtp/video report has appeared yet.
  async stats() {
    if (!this.pc) return null;
    return extractVideoSample(await this.pc.getStats());
  }

  async connect(videoEl) {
    this.close();
    this._state = "connecting";

    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only: host candidates suffice
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => {
      attachTrack(videoEl, ev).then((result) => {
        if (result.ok) return;
        // A rejected play() is an autoplay-policy block, not a negotiation
        // failure -- ICE is up, MediaMTX reports a reader attached, everything
        // "worked". Without this, that's indistinguishable from a healthy
        // stream: same "connected" state, same silent black rectangle this
        // whole state machine exists to avoid. Route it through "failed" so
        // camera-panel.js's existing retry/`.camera-error` path picks it up.
        this._playError = result.error;
        this._state = "failed";
      });
    };
    pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      if (pc.connectionState === "connected") this._state = "connected";
      // A failed peer connection is an indefinitely BLACK video element with
      // no error -- unlike a broken <img>, which at least looked broken. This
      // must surface, so record it and let app.js render + retry.
      else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this._state = "failed";
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(whepUrl(this.query), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    const answer = await res.text();
    if (!res.ok || !sdpLooksValid(answer)) {
      // Release the peer connection but do NOT go through close(), which
      // unconditionally resets _state to "idle" -- that would immediately
      // clobber the "failed" set below, and state() could then never report
      // a negotiation failure (only an ICE-level one via
      // onconnectionstatechange). The whole point of this state machine is
      // making failure visible, so this branch must survive.
      this._teardownPeer();
      this._state = "failed";
      throw new Error("WHEP negotiation failed: HTTP " + res.status);
    }
    this.resource = res.headers.get("Location");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  // Releases the RTCPeerConnection/resource handle only -- does NOT touch
  // _state, so a caller that already knows the outcome (see the negotiation
  // failure above) can tear down without a generic reset overwriting it.
  _teardownPeer() {
    if (this.pc) { try { this.pc.close(); } catch { /* already closed */ } }
    this.pc = null;
    this.resource = null;
  }

  close() {
    this._teardownPeer();
    this._state = "idle";
    this._playError = null;
  }
}
