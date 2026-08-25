// Which camera pipeline the dashboard should render, given the SSE state's
// camera field. Pulled out as a pure function (rather than inlined in
// app.js's renderCamera) so vitest can pin the fallback behavior without a
// browser -- this decision IS the rig's WebRTC escape hatch: cameraSource
// keeps two values on purpose, so that if MediaMTX misbehaves on the roof
// the operator can flip cameraSource to "v4l2" in config.json, restart, and
// get a known-good MJPEG picture instead of a dead panel. A source that is
// missing/degraded (not polled yet, or an older server build) must default
// to the historically-working MJPEG path, not the WebRTC one.
export function pickCameraMode(cameraState) {
  return cameraState && cameraState.source === "mediamtx" ? "webrtc" : "mjpeg";
}
