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

export class WhepSession {
  constructor(query) {
    this.query = query || "";
    this.pc = null;
    this.resource = null;
    this._state = "idle";
  }

  state() { return this._state; }

  async connect(videoEl) {
    this.close();
    this._state = "connecting";

    const pc = new RTCPeerConnection({ iceServers: [] }); // LAN only: host candidates suffice
    this.pc = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => { videoEl.srcObject = ev.streams[0]; };
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
  }
}
