import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpDashboardClient } from "../src/dashboard/client.js";
import { text } from "../src/tool-helpers.js";

// McpDashboardClient.connect() hardcodes a StreamableHTTPClientTransport (real
// HTTP), but its private `client` is a plain MCP SDK Client -- for this test
// we bypass connect() entirely and hand that Client the OTHER end of an
// InMemoryTransport pair, same fake-daemon pattern every tools/geo-tools/
// server test in this repo already uses (McpServer + InMemoryTransport.
// createLinkedPair()), just pointed at the dashboard's own client class
// instead of the raw SDK Client directly. No new dependencies, no network.
async function connectFakeDaemon(dash: McpDashboardClient, calibrationResponse: unknown): Promise<void> {
  const server = new McpServer({ name: "fake-daemon", version: "test" });
  server.registerTool(
    "get_calibration",
    { description: "fake", inputSchema: {} },
    async () => text(JSON.stringify(calibrationResponse)),
  );
  const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), sdkClient.connect(c)]);
}

// Regression pin for the 2026-07-28 dashboard-redesign blocker: this
// snake_case (wire) <-> camelCase (DashboardState) boundary is the sharp
// edge -- the wire says imu_mounting.rms_deg, the UI reads
// imuMounting.rmsDeg, and CalibrationRawZ silently drops anything it doesn't
// recognize (see the module comment atop client.ts) rather than failing
// loudly, so a renamed/misspelled key here would NOT throw; it would just
// make hasImu permanently false again downstream, reproducing the original
// bug with no compile error and no obviously-failing test -- until this one.
describe("McpDashboardClient.getCalibration — imu_mounting -> imuMounting mapping", () => {
  it("maps imu_mounting.rms_deg -> imuMounting.rmsDeg", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      imu_mounting: { rms_deg: 1.4 },
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toEqual({ rmsDeg: 1.4 });
  });

  it("maps an explicit null imu_mounting -> null (before characterize_imu has run)", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      imu_mounting: null,
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toBeNull();
  });

  it("tolerates an older daemon that omits imu_mounting entirely -> null", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      // imu_mounting key entirely absent -- pre-this-feature daemon shape.
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toBeNull();
  });
});
