import { describe, it, expect } from "vitest";
import { readServices, type Systemctl } from "../src/dashboard/services.js";

describe("readServices", () => {
  it("maps the four units", async () => {
    const sc: Systemctl = {
      isActive: async (u) => (u === "tb3-agent" ? "active" : u === "llama-server" ? "inactive" : "active"),
      start: async () => {}, stop: async () => {},
    };
    const s = await readServices(sc);
    expect(s.tb3agent).toBe("active");
    expect(s.llama).toBe("inactive");
    expect(s.readsb).toBe("active");
    expect(s.tb3mcp).toBe("active");
  });
  it("a failing probe → that unit unknown, others intact", async () => {
    const sc: Systemctl = {
      isActive: async (u) => { if (u === "readsb") throw new Error("nope"); return "active"; },
      start: async () => {}, stop: async () => {},
    };
    const s = await readServices(sc);
    expect(s.readsb).toBe("unknown");
    expect(s.tb3mcp).toBe("active");
  });
});
