import { describe, it, expect, afterEach } from "vitest";
import { main, checkCameraConfig } from "../src/dashboard/server.js";
import { loadConfig } from "../src/config.js";

// --- Fix round: item 1, 2026-07-26 final review ---
//
// Before this fix, `assertFfmpegUsable`/`assertEncoderAvailable` threw out of
// main(), the isEntry block's main().catch(e => { console.error(e);
// process.exit(1); }) killed the process, and deploy/tb3-dashboard.service's
// Restart=on-failure turned a single typo'd cameraFfmpegBin into a crash
// loop. The dashboard is the ONLY UI for /api/control/estop -- so that crash
// loop meant a roof-mounted rig could keep tracking/slewing with no operator
// stop button, no jog, no telemetry. checkCameraConfig() converts the throw
// into a returned message; main() must log it and keep serving.

describe("checkCameraConfig", () => {
  it("resolves null for a usable config (ffmpeg on PATH)", async () => {
    const cfg = loadConfig(undefined, { TB3_CAMERA_SOURCE: "v4l2" });
    await expect(checkCameraConfig(cfg)).resolves.toBeNull();
  });

  it("returns (does not throw) assertFfmpegUsable's message for an unusable cameraFfmpegBin", async () => {
    const cfg = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "v4l2", TB3_CAMERA_FFMPEG_BIN: "/nope/does/not/exist/ffmpeg",
    });
    await expect(checkCameraConfig(cfg)).resolves.toMatch(/cameraFfmpegBin/);
  });
});

describe("dashboard startup survives an unusable cameraFfmpegBin", () => {
  let handle: { close(): void } | null = null;
  const touchedEnvKeys = [
    "TB3_CONFIG", "TB3_DASHBOARD_PORT", "TB3_MCP_PORT", "TB3_DEVICE_HOST",
    "TB3_CAMERA_SOURCE", "TB3_CAMERA_FFMPEG_BIN",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    handle?.close();
    handle = null;
    for (const k of touchedEnvKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  it("main() resolves (does not throw/exit) and the error is surfaced in DashboardState.errors", async () => {
    for (const k of touchedEnvKeys) savedEnv[k] = process.env[k];
    // Empty string, not undefined: main() falls back to "config.json" only
    // when TB3_CONFIG is literally unset -- pin this test to pure env
    // overrides regardless of whatever config.json a dev machine might have.
    process.env.TB3_CONFIG = "";
    process.env.TB3_DASHBOARD_PORT = "8940";
    process.env.TB3_MCP_PORT = "8941";              // nothing listens here -- tolerated (see main())
    process.env.TB3_DEVICE_HOST = "127.0.0.1:8942";  // nothing listens here either
    process.env.TB3_CAMERA_SOURCE = "v4l2";
    process.env.TB3_CAMERA_FFMPEG_BIN = "/nope/does/not/exist/ffmpeg";

    // The regression under test: this must not throw/reject.
    handle = await main();

    const res = await fetch("http://127.0.0.1:8940/api/state");
    expect(res.status).toBe(200);
    const state = (await res.json()) as { errors: string[] };
    expect(state.errors.some((e) => e.includes("cameraFfmpegBin"))).toBe(true);

    // The control surface this whole item exists to protect is still live.
    const estopRes = await fetch("http://127.0.0.1:8940/api/control/estop", { method: "POST" });
    expect(estopRes.status).toBe(200);
  });
});
