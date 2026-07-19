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
    expect(c.panSign).toBe(1);
    expect(c.mcpToken).toBeUndefined();
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
