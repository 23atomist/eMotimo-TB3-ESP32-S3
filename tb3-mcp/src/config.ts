import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

const sign = z.union([z.literal(1), z.literal(-1)]);

const ConfigSchema = z
  .object({
    deviceHost: z.string().min(1).default("tb3.local"),
    deviceIpFallback: z.string().optional(),
    mcpPort: z.number().int().positive().max(65535).default(8770),
    mcpToken: z.string().min(1).optional(),
    panMin: z.number().default(-180),
    panMax: z.number().default(180),
    tiltMin: z.number().default(-90),
    tiltMax: z.number().default(90),
    maxSpeedDps: z.number().positive().default(22),
    // Measured on real hardware (jog-probe.mjs, 2026-07-16): the steady-state
    // plateau at full deflection is 19.0 deg/s on both pan and tilt (both are
    // 10000 steps/s, and jog runs through the 20kHz DDS accumulator -- NOT
    // goto's 22.5 deg/s direct pulse rate; the two ceilings genuinely differ).
    // This scales the layer-3 servo's feedforward directly: if it is wrong,
    // the servo is wrong everywhere.
    maxJogDps: z.number().positive().default(19),
    // Feel-tuning knobs for the dashboard's press-and-hold jog ramp (see
    // dashboard/public/jog-ramp.js), not hardware limits -- they exist
    // because fine framing at full zoom needs a slow floor, and because the
    // ramp replaces the old discrete speed presets ("micro micro-ish and
    // race car") with one continuous curve from jogMinDps up to maxJogDps.
    // Both are iterated against real hardware and a camera lens, so they're
    // config (edit + restart) rather than baked into the curve (a code edit
    // per iteration would be the wrong loop) -- the dashboard picks up the
    // current values over the SSE state stream (see state.ts's `jog` field).
    //
    // jogMinDps was raised 1 -> 3 (round 2 of operator feedback): 1 deg/s
    // read as imperceptible at a long focal length for the whole first
    // second of a press. jogRampSeconds stays at 4 -- the operator wants a
    // slow top-end ramp, not a shorter one; see jog-ramp.js's module doc for
    // the paired curve-shape change that makes the raised floor effective.
    jogRampSeconds: z.number().positive().default(4),
    jogMinDps: z.number().positive().default(3),
    panSign: sign.default(1),
    // Pan handedness INTO the geo mount kinematics (separate from panSign, which
    // is the device↔user boundary sign used by jog/tracking motion). The rig's
    // pan axis is inverted relative to panTiltToMount (az = 101 − pan); the host
    // sets TB3_GEO_PAN_SIGN=-1 (validated). Default +1 keeps legacy geo behavior.
    geoPanSign: sign.default(1),
    tiltSign: sign.default(1),
    auxSign: sign.default(1),
    calibrationFile: z.string().optional(),
    sectorFile: z.string().optional(),
    limitsFile: z.string().optional(),
    // Persists calibrate_vision_scale's result (see vision-scale-store.ts).
    // Added in vision-lock fix round 2, following the identical
    // optional-path-with-a-homedir-fallback pattern the three files above
    // already use.
    visionScaleFile: z.string().optional(),
    trackTickHz: z.number().positive().max(50).default(10),
    trackKp: z.number().nonnegative().default(1.0),
    trackLeadMs: z.number().nonnegative().max(5000).default(150),
    trackMaxTargetAgeMs: z.number().positive().default(5000),
    trackStaleTelemetryMs: z.number().positive().default(1000),
    trackDeadmanMs: z.number().positive().default(120000),
    trackReacquireDeg: z.number().positive().max(180).default(10),
    // Ceiling on the standing drift-calibration aim-offset (see
    // src/track/offset.ts). Config rather than a bare constant because a
    // rough set_north_zero seed can leave a pointing error bigger than this,
    // and when it does the CLAMP -- not the operator's aim -- is what stops a
    // plane reaching centre. Keep it comfortably under trackReacquireDeg or a
    // converged offset starts reading as "lost track".
    maxAimOffsetDeg: z.number().positive().max(45).default(5),
    jogVectorTtlMs: z.number().positive().default(500),
    sunGuardEnabled: z.boolean().default(false),
    sunConeDeg: z.number().positive().max(90).default(25),
    parkTiltDeg: z.number().default(-20),
    sunGuardTickHz: z.number().positive().max(50).default(10),
    // --- Layer 4: ADS-B target source ---
    adsbEnabled: z.boolean().default(false),
    adsbUrl: z.string().min(1).default("http://127.0.0.1/data/aircraft.json"),
    adsbPollHz: z.number().positive().max(10).default(1),
    adsbMaxRangeKm: z.number().positive().default(100),
    adsbLostSec: z.number().positive().default(15),
    adsbAltSource: z.enum(["auto", "geom", "baro"]).default("auto"),
    // --- Aircraft-based calibration sighting (sight_aircraft) ---
    // Latency dominates the error budget for an aircraft sighting far more
    // than ADS-B's own ~15m GPS position error (~0.09deg at 10km, negligible):
    // the operator centres the crosshair on a video frame that is already
    // this many ms old, so the pan/tilt they set corresponds to where the
    // aircraft WAS, not where it is now. At 250 m/s, 300ms is 75m -- ~0.43deg
    // at 10km slant range. See src/adsb/extrapolate.ts for the full
    // correction (this offset plus the ADS-B report's own seenPosSec age).
    calibVideoLatencyMs: z.number().positive().default(300),
    // Refuse a sighting built from a stale ADS-B position report rather than
    // extrapolate it a long way and hope: a silently bad sighting corrupts
    // the whole calibration solve and everything the rig points at
    // afterward, which is worse than a refusal the operator can retry a
    // couple of seconds later once a fresher report lands.
    calibMaxPosAgeSec: z.number().positive().default(5),
    // --- Layer 4: host agent + local LLM ---
    llmUrl: z.string().min(1).default("http://127.0.0.1:8000/v1/chat/completions"),
    llmModel: z.string().min(1).default("qwen2.5-14b-instruct"),
    agentTickSec: z.number().positive().max(600).default(5),
    agentMinDwellSec: z.number().nonnegative().max(3600).default(25),
    agentMcpUrl: z.string().min(1).default("http://127.0.0.1:8770/mcp"),
    // --- Ops dashboard ---
    dashboardPort: z.number().int().positive().max(65535).default(8788),
    dashboardBind: z.string().min(1).default("0.0.0.0"),
    dashboardAuth: z.boolean().default(false),
    cameraFallbackMs: z.number().positive().default(1500),
    // Whether the camera preview is running at dashboard startup. Off by
    // default so nothing spawns mtplvcap until the operator clicks Start.
    cameraStartEnabled: z.boolean().default(false),
    // mtplvcap (Nikon USB Live View) is the camera source. The dashboard spawns
    // this binary on Start and reads its MJPEG stream on this local port.
    cameraMtplvcapBin: z.string().min(1).default("mtplvcap"),
    cameraMtplvcapPort: z.number().int().positive().max(65535).default(42839),
    // Which capture backend produces frames, chosen at daemon startup (there is
    // no runtime switch -- the source changes only on a hardware swap):
    // "mtplvcap" = Nikon USB Live View; "v4l2" = a UVC camera via ffmpeg
    // producing MJPEG for the in-process relay; "mediamtx" = a UVC camera via
    // ffmpeg encoding H.264 and publishing to a local MediaMTX for WebRTC.
    cameraSource: z.enum(["mtplvcap", "v4l2", "mediamtx"]).default("mtplvcap"),
    // --- V4L2/UVC source (read only when cameraSource === "v4l2") ---
    cameraV4l2Device: z.string().min(1).default("/dev/video4"),
    // Size/framerate are advisory, not exact requirements: if the device
    // doesn't advertise this exact size/framerate under MJPG, the V4L2 driver
    // substitutes its nearest supported mode and ffmpeg keeps streaming at
    // that mode (the substitution is only logged at info level, hidden by
    // -loglevel error) -- only a device with no MJPG mode at all makes ffmpeg
    // exit immediately. Check advertised modes with
    // `v4l2-ctl -d <device> --list-formats-ext`.
    cameraV4l2Size: z.string().min(1).default("1280x720"),
    cameraV4l2Framerate: z.number().int().positive().default(30),
    cameraFfmpegBin: z.string().min(1).default("ffmpeg"),
    // --- MediaMTX/WebRTC source (read only when cameraSource === "mediamtx") ---
    // The camera has no native H.264 mode, so this path always transcodes.
    // "nvenc" is the default: jellyfin-ffmpeg8 on the host provides
    // h264_nvenc, and NVENC is far better exercised in WebRTC pipelines than
    // Vulkan encode. "vulkan" is a verified fallback on this hardware. All
    // values are validated against `ffmpeg -encoders` at startup.
    cameraEncoder: z.enum(["nvenc", "vulkan", "x264", "copy"]).default("nvenc"),
    cameraVideoBitrate: z.string().min(1).default("6M"),
    // Separate from cameraV4l2Size ON PURPOSE: the MJPEG fallback must stay at
    // 720p because its fan-out has no backpressure. 4K is valid here but the
    // camera shares a 480 Mbps USB controller with the ADS-B receiver and
    // draws 91 Mbps at 4K30 -- move one device off that bus first.
    cameraMediamtxSize: z.string().min(1).default("1920x1080"),
    cameraMediamtxRtspUrl: z.string().regex(/^rtsp:\/\/.+/, "must be an rtsp:// URL").default("rtsp://127.0.0.1:8554/tb3"),
    cameraMediamtxHttpUrl: z.string().min(1).default("http://127.0.0.1:8889"),
    cameraMediamtxControlUrl: z.string().min(1).default("http://127.0.0.1:9997"),
    cameraMediamtxPath: z.string().min(1).default("tb3"),
    // --- MCP-driven capture (daemon side) ---
    captureAutoEnabled: z.boolean().default(true),
    captureSnapshotDir: z.string().min(1).default("/var/lib/tb3/snapshots"),
    // Grace before the recorder closes: TrackState flaps to "waiting" when a
    // target is briefly blocked, and without this one pass becomes fragments.
    captureDebounceMs: z.number().int().positive().default(5000),
    // Hard bound on EVERY capture call. The tracking tick is real-time control
    // of a physical rig and must never wait on capture.
    captureTimeoutMs: z.number().int().positive().default(4000),
    captureFfmpegBin: z.string().min(1).default("ffmpeg"),
    // --- Layer 4/5: vision lock (camera-assisted aim correction) ---
    // Off by default and read-only on its first opt-in: the loop must be
    // switched on deliberately, and its first mode observes rather than
    // acts. See src/vision/corrector.ts and src/vision-tools.ts.
    visionEnabled: z.boolean().default(false),
    visionReadOnly: z.boolean().default(true),
    visionDetectorUrl: z.string().min(1).default("http://127.0.0.1:8001/detect"),
    visionDetectorTimeoutMs: z.number().int().positive().default(2000),
    visionTickHz: z.number().positive().max(10).default(1),
    // Capped at 1: a gain above 1 overshoots the measured error every tick
    // and does not converge (see track/control.ts's P-only rationale, same
    // shape here one layer up).
    visionGain: z.number().positive().max(1).default(0.3),
    visionGateRadiusPx: z.number().positive().default(120),
    visionMinConf: z.number().positive().max(1).default(0.25),
  })
  .refine((c) => c.panMin < c.panMax, { message: "panMin must be < panMax" })
  .refine((c) => c.tiltMin < c.tiltMax, { message: "tiltMin must be < tiltMax" });

export type Config = z.infer<typeof ConfigSchema>;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${v}`);
  return n;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return !(v === "0" || v.toLowerCase() === "false");
}

export function loadConfig(
  filePath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const fromFile: Record<string, unknown> =
    filePath && existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8"))
      : {};

  const overrides: Record<string, unknown> = { ...fromFile };
  const set = (key: string, value: unknown) => {
    if (value !== undefined) overrides[key] = value;
  };

  set("deviceHost", env.TB3_DEVICE_HOST);
  set("deviceIpFallback", env.TB3_DEVICE_IP_FALLBACK);
  set("mcpPort", num(env.TB3_MCP_PORT));
  set("mcpToken", env.TB3_MCP_TOKEN);
  set("panMin", num(env.TB3_PAN_MIN));
  set("panMax", num(env.TB3_PAN_MAX));
  set("tiltMin", num(env.TB3_TILT_MIN));
  set("tiltMax", num(env.TB3_TILT_MAX));
  set("maxSpeedDps", num(env.TB3_MAX_SPEED_DPS));
  set("maxJogDps", num(env.TB3_MAX_JOG_DPS));
  set("jogRampSeconds", num(env.TB3_JOG_RAMP_SECONDS));
  set("jogMinDps", num(env.TB3_JOG_MIN_DPS));
  set("panSign", num(env.TB3_PAN_SIGN));
  set("geoPanSign", num(env.TB3_GEO_PAN_SIGN));
  set("tiltSign", num(env.TB3_TILT_SIGN));
  set("auxSign", num(env.TB3_AUX_SIGN));
  set("calibrationFile", env.TB3_CALIBRATION_FILE);
  set("sectorFile", env.TB3_SECTOR_FILE);
  set("limitsFile", env.TB3_LIMITS_FILE);
  set("visionScaleFile", env.TB3_VISION_SCALE_FILE);
  set("trackTickHz", num(env.TB3_TRACK_TICK_HZ));
  set("trackKp", num(env.TB3_TRACK_KP));
  set("trackLeadMs", num(env.TB3_TRACK_LEAD_MS));
  set("trackMaxTargetAgeMs", num(env.TB3_TRACK_MAX_TARGET_AGE_MS));
  set("trackStaleTelemetryMs", num(env.TB3_TRACK_STALE_TELEMETRY_MS));
  set("trackDeadmanMs", num(env.TB3_TRACK_DEADMAN_MS));
  set("trackReacquireDeg", num(env.TB3_TRACK_REACQUIRE_DEG));
  set("maxAimOffsetDeg", num(env.TB3_MAX_AIM_OFFSET_DEG));
  set("jogVectorTtlMs", num(env.TB3_JOG_VECTOR_TTL_MS));
  set("sunGuardEnabled", bool(env.TB3_SUN_GUARD_ENABLED));
  set("sunConeDeg", num(env.TB3_SUN_CONE_DEG));
  set("parkTiltDeg", num(env.TB3_PARK_TILT_DEG));
  set("sunGuardTickHz", num(env.TB3_SUN_GUARD_TICK_HZ));
  set("adsbEnabled", bool(env.TB3_ADSB_ENABLED));
  set("adsbUrl", env.TB3_ADSB_URL);
  set("adsbPollHz", num(env.TB3_ADSB_POLL_HZ));
  set("adsbMaxRangeKm", num(env.TB3_ADSB_MAX_RANGE_KM));
  set("adsbLostSec", num(env.TB3_ADSB_LOST_SEC));
  set("adsbAltSource", env.TB3_ADSB_ALT_SOURCE);
  set("calibVideoLatencyMs", num(env.TB3_CALIB_VIDEO_LATENCY_MS));
  set("calibMaxPosAgeSec", num(env.TB3_CALIB_MAX_POS_AGE_SEC));
  set("llmUrl", env.TB3_LLM_URL);
  set("llmModel", env.TB3_LLM_MODEL);
  set("agentTickSec", num(env.TB3_AGENT_TICK_SEC));
  set("agentMinDwellSec", num(env.TB3_AGENT_MIN_DWELL_SEC));
  set("agentMcpUrl", env.TB3_AGENT_MCP_URL);
  set("dashboardPort", num(env.TB3_DASHBOARD_PORT));
  set("dashboardBind", env.TB3_DASHBOARD_BIND);
  set("dashboardAuth", bool(env.TB3_DASHBOARD_AUTH));
  set("cameraFallbackMs", num(env.TB3_CAMERA_FALLBACK_MS));
  set("cameraStartEnabled", bool(env.TB3_CAMERA_START_ENABLED));
  set("cameraMtplvcapBin", env.TB3_CAMERA_MTPLVCAP_BIN);
  set("cameraMtplvcapPort", num(env.TB3_CAMERA_MTPLVCAP_PORT));
  set("cameraSource", env.TB3_CAMERA_SOURCE);
  set("cameraV4l2Device", env.TB3_CAMERA_V4L2_DEVICE);
  set("cameraV4l2Size", env.TB3_CAMERA_V4L2_SIZE);
  set("cameraV4l2Framerate", num(env.TB3_CAMERA_V4L2_FRAMERATE));
  set("cameraFfmpegBin", env.TB3_CAMERA_FFMPEG_BIN);
  set("cameraEncoder", env.TB3_CAMERA_ENCODER);
  set("cameraVideoBitrate", env.TB3_CAMERA_VIDEO_BITRATE);
  set("cameraMediamtxSize", env.TB3_CAMERA_MEDIAMTX_SIZE);
  set("cameraMediamtxRtspUrl", env.TB3_CAMERA_MEDIAMTX_RTSP_URL);
  set("cameraMediamtxHttpUrl", env.TB3_CAMERA_MEDIAMTX_HTTP_URL);
  set("cameraMediamtxControlUrl", env.TB3_CAMERA_MEDIAMTX_CONTROL_URL);
  set("cameraMediamtxPath", env.TB3_CAMERA_MEDIAMTX_PATH);
  set("captureAutoEnabled", bool(env.TB3_CAPTURE_AUTO_ENABLED));
  set("captureSnapshotDir", env.TB3_CAPTURE_SNAPSHOT_DIR);
  set("captureDebounceMs", num(env.TB3_CAPTURE_DEBOUNCE_MS));
  set("captureTimeoutMs", num(env.TB3_CAPTURE_TIMEOUT_MS));
  set("captureFfmpegBin", env.TB3_CAPTURE_FFMPEG_BIN);
  set("visionEnabled", bool(env.TB3_VISION_ENABLED));
  set("visionReadOnly", bool(env.TB3_VISION_READ_ONLY));
  set("visionDetectorUrl", env.TB3_VISION_DETECTOR_URL);
  set("visionDetectorTimeoutMs", num(env.TB3_VISION_DETECTOR_TIMEOUT_MS));
  set("visionTickHz", num(env.TB3_VISION_TICK_HZ));
  set("visionGain", num(env.TB3_VISION_GAIN));
  set("visionGateRadiusPx", num(env.TB3_VISION_GATE_RADIUS_PX));
  set("visionMinConf", num(env.TB3_VISION_MIN_CONF));

  return ConfigSchema.parse(overrides);
}
