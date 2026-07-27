import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no file and no env", () => {
    const c = loadConfig(undefined, {});
    expect(c.deviceHost).toBe("tb3.local");
    expect(c.mcpPort).toBe(8770);
    expect(c.panMin).toBe(-180);
    expect(c.panMax).toBe(180);
    expect(c.tiltMin).toBe(-90);
    expect(c.tiltMax).toBe(90);
    expect(c.maxSpeedDps).toBe(22);
    expect(c.maxJogDps).toBe(19);   // measured rig plateau, not a preference
    expect(c.jogRampSeconds).toBe(4);
    expect(c.jogMinDps).toBe(1);
    expect(c.panSign).toBe(1);
    expect(c.mcpToken).toBeUndefined();
    expect(c.sectorFile).toBeUndefined();
  });

  it("applies TB3_SECTOR_FILE env override (mirrors calibrationFile's env parity)", () => {
    const c = loadConfig(undefined, { TB3_SECTOR_FILE: "/tmp/sector.json" });
    expect(c.sectorFile).toBe("/tmp/sector.json");
  });

  it("applies env overrides over defaults", () => {
    const c = loadConfig(undefined, {
      TB3_DEVICE_HOST: "10.31.31.1",
      TB3_MCP_PORT: "9999",
      TB3_MCP_TOKEN: "secret",
      TB3_MAX_SPEED_DPS: "12",
    });
    expect(c.deviceHost).toBe("10.31.31.1");
    expect(c.mcpPort).toBe(9999);
    expect(c.mcpToken).toBe("secret");
    expect(c.maxSpeedDps).toBe(12);
  });

  it("rejects an invalid sign", () => {
    expect(() => loadConfig(undefined, { TB3_PAN_SIGN: "2" })).toThrow();
  });

  it("rejects pan_min >= pan_max", () => {
    expect(() => loadConfig(undefined, { TB3_PAN_MIN: "50", TB3_PAN_MAX: "10" })).toThrow();
  });

  it("falls back to the default port when TB3_MCP_PORT is an empty string", () => {
    const c = loadConfig(undefined, { TB3_MCP_PORT: "" });
    expect(c.mcpPort).toBe(8770);
  });

  it("rejects a port above 65535", () => {
    expect(() => loadConfig(undefined, { TB3_MCP_PORT: "70000" })).toThrow();
  });

  it("geoPanSign defaults to +1 and TB3_GEO_PAN_SIGN overrides it", () => {
    expect(loadConfig(undefined, {}).geoPanSign).toBe(1);
    expect(loadConfig(undefined, { TB3_GEO_PAN_SIGN: "-1" }).geoPanSign).toBe(-1);
  });
});

describe("jog ramp feel config", () => {
  it("applies TB3_JOG_RAMP_SECONDS and TB3_JOG_MIN_DPS env overrides", () => {
    const c = loadConfig(undefined, { TB3_JOG_RAMP_SECONDS: "6", TB3_JOG_MIN_DPS: "2.5" });
    expect(c.jogRampSeconds).toBe(6);
    expect(c.jogMinDps).toBe(2.5);
  });

  it("rejects a non-positive jogRampSeconds", () => {
    expect(() => loadConfig(undefined, { TB3_JOG_RAMP_SECONDS: "0" })).toThrow();
    expect(() => loadConfig(undefined, { TB3_JOG_RAMP_SECONDS: "-1" })).toThrow();
  });

  it("rejects a non-positive jogMinDps", () => {
    expect(() => loadConfig(undefined, { TB3_JOG_MIN_DPS: "0" })).toThrow();
    expect(() => loadConfig(undefined, { TB3_JOG_MIN_DPS: "-1" })).toThrow();
  });
});

describe("tracking config", () => {
  it("defaults every tracking key", () => {
    const c = loadConfig(undefined, {});
    expect(c.trackTickHz).toBe(10);
    expect(c.trackKp).toBe(1.0);
    expect(c.trackLeadMs).toBe(150);
    expect(c.trackMaxTargetAgeMs).toBe(5000);
    expect(c.trackStaleTelemetryMs).toBe(1000);
    expect(c.trackDeadmanMs).toBe(120000);
    expect(c.trackReacquireDeg).toBe(10);
    expect(c.jogVectorTtlMs).toBe(500);
  });

  it("overrides tracking keys from env", () => {
    const c = loadConfig(undefined, { TB3_TRACK_KP: "2.5", TB3_JOG_VECTOR_TTL_MS: "250" });
    expect(c.trackKp).toBe(2.5);
    expect(c.jogVectorTtlMs).toBe(250);
  });

  it("rejects a non-positive tick rate", () => {
    expect(() => loadConfig(undefined, { TB3_TRACK_TICK_HZ: "0" })).toThrow();
  });
});

describe("sun-guard config", () => {
  it("has sun-guard defaults and env overrides", () => {
    const d = loadConfig(undefined, {});
    expect(d.sunGuardEnabled).toBe(true);
    expect(d.sunConeDeg).toBe(25);
    expect(d.parkTiltDeg).toBe(-20);
    expect(d.sunGuardTickHz).toBe(10);
    const o = loadConfig(undefined, { TB3_SUN_CONE_DEG: "18", TB3_PARK_TILT_DEG: "-30", TB3_SUN_GUARD_ENABLED: "0", TB3_SUN_GUARD_TICK_HZ: "5" });
    expect(o.sunConeDeg).toBe(18);
    expect(o.parkTiltDeg).toBe(-30);
    expect(o.sunGuardEnabled).toBe(false);
    expect(o.sunGuardTickHz).toBe(5);
  });
});

describe("L4 config", () => {
  it("defaults ADS-B off with sane values", () => {
    const c = loadConfig(undefined, {});
    expect(c.adsbEnabled).toBe(false);
    expect(c.adsbPollHz).toBe(1);
    expect(c.adsbMaxRangeKm).toBe(100);
    expect(c.adsbLostSec).toBe(15);
    expect(c.adsbAltSource).toBe("auto");
    expect(c.agentTickSec).toBe(5);
    expect(c.agentMinDwellSec).toBe(25);
  });

  it("reads L4 env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_ADSB_ENABLED: "1",
      TB3_ADSB_URL: "http://10.0.0.9/data/aircraft.json",
      TB3_ADSB_POLL_HZ: "2",
      TB3_ADSB_ALT_SOURCE: "geom",
      TB3_LLM_URL: "http://127.0.0.1:8000/v1/chat/completions",
      TB3_AGENT_MIN_DWELL_SEC: "40",
    });
    expect(c.adsbEnabled).toBe(true);
    expect(c.adsbUrl).toBe("http://10.0.0.9/data/aircraft.json");
    expect(c.adsbPollHz).toBe(2);
    expect(c.adsbAltSource).toBe("geom");
    expect(c.llmUrl).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(c.agentMinDwellSec).toBe(40);
  });

  it("rejects an invalid alt source", () => {
    expect(() => loadConfig(undefined, { TB3_ADSB_ALT_SOURCE: "gps" })).toThrow();
  });
});

describe("dashboard config", () => {
  it("defaults", () => {
    const c = loadConfig(undefined, {});
    expect(c.dashboardPort).toBe(8788);
    expect(c.dashboardBind).toBe("0.0.0.0");
    expect(c.dashboardAuth).toBe(false);
    expect(c.cameraFallbackMs).toBe(1500);
  });
  it("env overrides", () => {
    const c = loadConfig(undefined, { TB3_DASHBOARD_PORT: "9000", TB3_DASHBOARD_AUTH: "1" });
    expect(c.dashboardPort).toBe(9000);
    expect(c.dashboardAuth).toBe(true);
  });

  it("camera defaults: mtplvcap source, off at start", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraStartEnabled).toBe(false);
    expect(c.cameraMtplvcapBin).toBe("mtplvcap");
    expect(c.cameraMtplvcapPort).toBe(42839);
  });

  it("camera env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_START_ENABLED: "1",
      TB3_CAMERA_MTPLVCAP_BIN: "/home/atomist/bin/mtplvcap",
      TB3_CAMERA_MTPLVCAP_PORT: "42900",
    });
    expect(c.cameraStartEnabled).toBe(true);
    expect(c.cameraMtplvcapBin).toBe("/home/atomist/bin/mtplvcap");
    expect(c.cameraMtplvcapPort).toBe(42900);
  });

  it("camera source defaults to mtplvcap with v4l2 fields ready", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraSource).toBe("mtplvcap");
    expect(c.cameraV4l2Device).toBe("/dev/video4");
    expect(c.cameraV4l2Size).toBe("1280x720");
    expect(c.cameraV4l2Framerate).toBe(30);
    expect(c.cameraFfmpegBin).toBe("ffmpeg");
  });

  it("camera v4l2 env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "v4l2",
      TB3_CAMERA_V4L2_DEVICE: "/dev/video0",
      TB3_CAMERA_V4L2_SIZE: "1920x1080",
      TB3_CAMERA_V4L2_FRAMERATE: "15",
      TB3_CAMERA_FFMPEG_BIN: "/usr/bin/ffmpeg",
    });
    expect(c.cameraSource).toBe("v4l2");
    expect(c.cameraV4l2Device).toBe("/dev/video0");
    expect(c.cameraV4l2Size).toBe("1920x1080");
    expect(c.cameraV4l2Framerate).toBe(15);
    expect(c.cameraFfmpegBin).toBe("/usr/bin/ffmpeg");
  });

  it("rejects an unknown camera source", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_SOURCE: "gphoto2" })).toThrow();
  });
});

describe("MediaMTX camera config", () => {
  it("defaults the MediaMTX fields", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraSource).toBe("mtplvcap");        // still inert by default
    expect(c.cameraEncoder).toBe("nvenc");
    expect(c.cameraVideoBitrate).toBe("6M");
    expect(c.cameraMediamtxSize).toBe("1920x1080");
    expect(c.cameraMediamtxRtspUrl).toBe("rtsp://127.0.0.1:8554/tb3");
    expect(c.cameraMediamtxHttpUrl).toBe("http://127.0.0.1:8889");
    expect(c.cameraMediamtxControlUrl).toBe("http://127.0.0.1:9997");
    expect(c.cameraMediamtxPath).toBe("tb3");
  });

  it("keeps cameraV4l2Size at 720p so the MJPEG fallback stays conservative", () => {
    // 1080p MJPEG is ~3x the byte rate and CameraStreamer.writeChunk has no
    // backpressure -- raising this would worsen a known OOM on the fallback path.
    const c = loadConfig(undefined, {});
    expect(c.cameraV4l2Size).toBe("1280x720");
  });

  it("accepts mediamtx as a source", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(c.cameraSource).toBe("mediamtx");
  });

  it("applies MediaMTX env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_ENCODER: "vulkan",
      TB3_CAMERA_VIDEO_BITRATE: "12M",
      TB3_CAMERA_MEDIAMTX_SIZE: "3840x2160",
      TB3_CAMERA_MEDIAMTX_PATH: "cam2",
    });
    expect(c.cameraEncoder).toBe("vulkan");
    expect(c.cameraVideoBitrate).toBe("12M");
    expect(c.cameraMediamtxSize).toBe("3840x2160");
    expect(c.cameraMediamtxPath).toBe("cam2");
  });

  it("rejects an unknown encoder", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_ENCODER: "h265" })).toThrow();
  });

  it("accepts the default rtsp:// URL", () => {
    const c = loadConfig(undefined, {});
    expect(c.cameraMediamtxRtspUrl).toBe("rtsp://127.0.0.1:8554/tb3");
  });

  it("accepts a valid custom rtsp:// URL", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_MEDIAMTX_RTSP_URL: "rtsp://10.0.0.5:554/cam1" });
    expect(c.cameraMediamtxRtspUrl).toBe("rtsp://10.0.0.5:554/cam1");
  });

  it("rejects a /dev/video path to prevent two-consumer camera contention", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_MEDIAMTX_RTSP_URL: "/dev/video4" })).toThrow();
  });

  it("rejects a non-rtsp URL scheme", () => {
    expect(() => loadConfig(undefined, { TB3_CAMERA_MEDIAMTX_RTSP_URL: "http://127.0.0.1:8554/tb3" })).toThrow();
  });
});

describe("capture config", () => {
  it("defaults capture fields", () => {
    const c = loadConfig(undefined, {});
    expect(c.captureAutoEnabled).toBe(true);
    expect(c.captureSnapshotDir).toBe("/var/lib/tb3/snapshots");
    expect(c.captureDebounceMs).toBe(5000);
    expect(c.captureTimeoutMs).toBe(4000);
    expect(c.captureFfmpegBin).toBe("ffmpeg");
  });

  it("applies capture env overrides", () => {
    const c = loadConfig(undefined, {
      TB3_CAPTURE_AUTO_ENABLED: "0",
      TB3_CAPTURE_SNAPSHOT_DIR: "/tmp/snapshots",
      TB3_CAPTURE_DEBOUNCE_MS: "3000",
      TB3_CAPTURE_TIMEOUT_MS: "2000",
      TB3_CAPTURE_FFMPEG_BIN: "/usr/bin/ffmpeg",
    });
    expect(c.captureAutoEnabled).toBe(false);
    expect(c.captureSnapshotDir).toBe("/tmp/snapshots");
    expect(c.captureDebounceMs).toBe(3000);
    expect(c.captureTimeoutMs).toBe(2000);
    expect(c.captureFfmpegBin).toBe("/usr/bin/ffmpeg");
  });

  it("rejects non-positive capture timeouts", () => {
    expect(() => loadConfig(undefined, { TB3_CAPTURE_DEBOUNCE_MS: "0" })).toThrow();
    expect(() => loadConfig(undefined, { TB3_CAPTURE_TIMEOUT_MS: "-1" })).toThrow();
  });
});
