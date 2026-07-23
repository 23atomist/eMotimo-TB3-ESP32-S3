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
    panSign: sign.default(1),
    // Pan handedness INTO the geo mount kinematics (separate from panSign, which
    // is the device↔user boundary sign used by jog/tracking motion). The rig's
    // pan axis is inverted relative to panTiltToMount (az = 101 − pan); the host
    // sets TB3_GEO_PAN_SIGN=-1 (validated). Default +1 keeps legacy geo behavior.
    geoPanSign: sign.default(1),
    tiltSign: sign.default(1),
    auxSign: sign.default(1),
    calibrationFile: z.string().optional(),
    trackTickHz: z.number().positive().max(50).default(10),
    trackKp: z.number().nonnegative().default(1.0),
    trackLeadMs: z.number().nonnegative().max(5000).default(150),
    trackMaxTargetAgeMs: z.number().positive().default(5000),
    trackStaleTelemetryMs: z.number().positive().default(1000),
    trackDeadmanMs: z.number().positive().default(120000),
    trackReacquireDeg: z.number().positive().max(180).default(10),
    jogVectorTtlMs: z.number().positive().default(500),
    sunGuardEnabled: z.boolean().default(true),
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
  set("panSign", num(env.TB3_PAN_SIGN));
  set("geoPanSign", num(env.TB3_GEO_PAN_SIGN));
  set("tiltSign", num(env.TB3_TILT_SIGN));
  set("auxSign", num(env.TB3_AUX_SIGN));
  set("calibrationFile", env.TB3_CALIBRATION_FILE);
  set("trackTickHz", num(env.TB3_TRACK_TICK_HZ));
  set("trackKp", num(env.TB3_TRACK_KP));
  set("trackLeadMs", num(env.TB3_TRACK_LEAD_MS));
  set("trackMaxTargetAgeMs", num(env.TB3_TRACK_MAX_TARGET_AGE_MS));
  set("trackStaleTelemetryMs", num(env.TB3_TRACK_STALE_TELEMETRY_MS));
  set("trackDeadmanMs", num(env.TB3_TRACK_DEADMAN_MS));
  set("trackReacquireDeg", num(env.TB3_TRACK_REACQUIRE_DEG));
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

  return ConfigSchema.parse(overrides);
}
