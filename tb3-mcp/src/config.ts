import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

const sign = z.union([z.literal(1), z.literal(-1)]);

const ConfigSchema = z
  .object({
    deviceHost: z.string().min(1).default("tb3.local"),
    deviceIpFallback: z.string().optional(),
    mcpPort: z.number().int().positive().default(8770),
    mcpToken: z.string().min(1).optional(),
    panMin: z.number().default(-180),
    panMax: z.number().default(180),
    tiltMin: z.number().default(-90),
    tiltMax: z.number().default(90),
    maxSpeedDps: z.number().positive().default(30),
    maxJogDps: z.number().positive().default(20),
    panSign: sign.default(1),
    tiltSign: sign.default(1),
    auxSign: sign.default(1),
  })
  .refine((c) => c.panMin < c.panMax, { message: "panMin must be < panMax" })
  .refine((c) => c.tiltMin < c.tiltMax, { message: "tiltMin must be < tiltMax" });

export type Config = z.infer<typeof ConfigSchema>;

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${v}`);
  return n;
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
  set("tiltSign", num(env.TB3_TILT_SIGN));
  set("auxSign", num(env.TB3_AUX_SIGN));

  return ConfigSchema.parse(overrides);
}
