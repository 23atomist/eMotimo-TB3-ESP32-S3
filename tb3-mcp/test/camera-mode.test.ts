import { describe, it, expect } from "vitest";
import { pickCameraMode } from "../dashboard/public/camera-mode.js";

describe("pickCameraMode", () => {
  it("picks webrtc when the source is mediamtx", () => {
    expect(pickCameraMode({ source: "mediamtx" })).toBe("webrtc");
  });

  it("picks mjpeg for the v4l2 source", () => {
    expect(pickCameraMode({ source: "v4l2" })).toBe("mjpeg");
  });

  // The escape hatch: a degraded/not-yet-polled payload (source missing or
  // the whole camera object absent) must fall back to the historically-
  // working MJPEG path, never default to a WebRTC panel that can't connect.
  it("defaults to mjpeg when source is absent", () => {
    expect(pickCameraMode({})).toBe("mjpeg");
  });
  it("defaults to mjpeg when the camera state itself is null/undefined", () => {
    expect(pickCameraMode(null)).toBe("mjpeg");
    expect(pickCameraMode(undefined)).toBe("mjpeg");
  });
});
