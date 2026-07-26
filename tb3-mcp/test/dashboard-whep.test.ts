import { describe, it, expect } from "vitest";
import { whepTargetUrl } from "../src/dashboard/server.js";
import { loadConfig } from "../src/config.js";

describe("whepTargetUrl", () => {
  it("builds the MediaMTX WHEP endpoint from host url + path", () => {
    const c = loadConfig(undefined, { TB3_CAMERA_SOURCE: "mediamtx" });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:8889/tb3/whep");
  });

  it("honors a custom path and host", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx",
      TB3_CAMERA_MEDIAMTX_HTTP_URL: "http://127.0.0.1:9999",
      TB3_CAMERA_MEDIAMTX_PATH: "cam2",
    });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:9999/cam2/whep");
  });

  it("tolerates a trailing slash on the host url", () => {
    const c = loadConfig(undefined, {
      TB3_CAMERA_SOURCE: "mediamtx",
      TB3_CAMERA_MEDIAMTX_HTTP_URL: "http://127.0.0.1:8889/",
    });
    expect(whepTargetUrl(c)).toBe("http://127.0.0.1:8889/tb3/whep");
  });
});
