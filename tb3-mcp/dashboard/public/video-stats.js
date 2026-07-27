// Turns two RTCPeerConnection.getStats() inbound-rtp/video samples into a
// rate. This is the one piece of math this whole readout exists for: the
// on-roof bug it was built to catch ("MediaMTX reports RTP flowing, the
// browser acks it over RTCP, the <video> is still black") is invisible in a
// single cumulative sample -- framesDecoded and bytesReceived only ever grow,
// so one snapshot alone can't say whether either is moving *right now*. Get
// the diff-by-timestamp wrong (skip the dt guard, don't guard against a
// shrinking counter) and the number that comes out still LOOKS like a rate --
// it's just wrong, which is worse than showing nothing.
//
// A sample is { timestamp, bytesReceived, framesDecoded, frameWidth,
// frameHeight } -- see whep.js's extractVideoSample()/WhepSession.stats().
// `prev` is null for the first sample of a session and should be reset to
// null by the caller whenever the underlying RTCPeerConnection is replaced
// (a WHEP reconnect starts a new connection with its own counters at zero);
// guarded here too, defensively, since diffing across that boundary would
// otherwise produce a negative "rate" if a caller ever fails to reset it.
export function computeVideoStats(prev, curr) {
  if (!curr) return { fps: 0, bitrate: 0, width: 0, height: 0 };

  const width = curr.frameWidth || 0;
  const height = curr.frameHeight || 0;

  if (!prev) return { fps: 0, bitrate: 0, width, height };

  const dtMs = curr.timestamp - prev.timestamp;
  // Covers both a zero delta (two samples landing in the same tick) and a
  // negative one (clock quirks, or a getStats() timestamp that isn't
  // monotonic) -- either way there is no valid time base to divide by.
  if (!(dtMs > 0)) return { fps: 0, bitrate: 0, width, height };

  const frameDelta = curr.framesDecoded - prev.framesDecoded;
  const byteDelta = curr.bytesReceived - prev.bytesReceived;

  // A negative delta means the counters themselves went backwards -- the
  // signature of a reconnect (new RTCPeerConnection, cumulative totals
  // restarted at/near zero) diffed against the old connection's last known
  // totals. There is no valid rate to report for that tick; 0 is the honest
  // answer until two consecutive samples from the *same* connection exist.
  const fps = frameDelta > 0 ? (frameDelta * 1000) / dtMs : 0;
  const bitrate = byteDelta > 0 ? (byteDelta * 8 * 1000) / dtMs : 0;

  return { fps, bitrate, width, height };
}

// Human-scaled bandwidth string: kbps below 1 Mbps, Mbps (one decimal) at or
// above it, so a healthy multi-Mbps WebRTC stream doesn't read as a
// five-digit kbps number.
export function formatBandwidth(bitrateBps) {
  if (!(bitrateBps > 0)) return "0 kbps";
  const mbps = bitrateBps / 1_000_000;
  if (mbps >= 1) return mbps.toFixed(1) + " Mbps";
  return Math.round(bitrateBps / 1000) + " kbps";
}

// Formats a computeVideoStats() result for direct DOM assignment -- same
// { text, cls } shape as capture-label.js's renderCaptureLabel, so
// camera-panel.js can apply it the same way app.js already applies that one.
//
// `cls` is the entire point of this component. It must distinguish three
// states that otherwise look identical (a black <video>, no error anywhere):
//   - receiving && decoding    -> "video-stats-ok"     (healthy)
//   - receiving && !decoding   -> "video-stats-stall"  (THE bug: bytes
//                                  arriving, zero frames ever turn into a
//                                  picture -- must never collapse into
//                                  either neighbouring state)
//   - !receiving               -> "video-stats-down"   (transport itself is
//                                  down; decoding is moot)
export function formatVideoStats(stats) {
  const s = stats || { fps: 0, bitrate: 0, width: 0, height: 0 };
  const receiving = s.bitrate > 0;
  const decoding = s.fps > 0;

  let cls;
  if (receiving && decoding) cls = "video-stats-ok";
  else if (receiving && !decoding) cls = "video-stats-stall";
  else cls = "video-stats-down";

  const parts = [Math.round(s.fps) + " fps", formatBandwidth(s.bitrate)];
  if (s.width && s.height) parts.push(s.width + "x" + s.height);

  return { text: parts.join(" · "), cls };
}
