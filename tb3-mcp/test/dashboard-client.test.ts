import { describe, it, expect } from "vitest";
import { z } from "zod";
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

// Same fake-daemon technique as connectFakeDaemon above, generalized to an
// arbitrary tool name -- get_taught_limits here, rather than get_calibration.
async function connectFakeDaemonTool(dash: McpDashboardClient, toolName: string, response: unknown): Promise<void> {
  const server = new McpServer({ name: "fake-daemon", version: "test" });
  server.registerTool(toolName, { description: "fake", inputSchema: {} }, async () => text(JSON.stringify(response)));
  const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), sdkClient.connect(c)]);
}

// Review fix, UI-9 fix round, finding I-2: getTaughtLimits() reads the
// SAME get_taught_limits response getLimits() already parses, but its OWN
// `taught` object (per-edge, null until actually captured) rather than
// `effective` -- see state.ts's TaughtLimits for why this is a second
// client method instead of reshaping getLimits()'s existing, working
// return type.
describe("McpDashboardClient.getTaughtLimits -- get_taught_limits's `taught` object -> TaughtLimits", () => {
  it("maps a real captured edge through, leaving the rest null", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_taught_limits", {
      taught: { pan_min: null, pan_max: 12.5, tilt_min: null, tilt_max: null },
      config_ceiling: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
      effective: { pan_min: -170, pan_max: 12.5, tilt_min: -10, tilt_max: 80 },
    });
    const t = await dash.getTaughtLimits();
    expect(t).toEqual({ panMinDeg: null, panMaxDeg: 12.5, tiltMinDeg: null, tiltMaxDeg: null });
  });

  it("maps every-edge-untaught (all null) through, distinct from a real 0-valued capture", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_taught_limits", {
      taught: { pan_min: null, pan_max: null, tilt_min: null, tilt_max: null },
      config_ceiling: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
      effective: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
    });
    const t = await dash.getTaughtLimits();
    expect(t).toEqual({ panMinDeg: null, panMaxDeg: null, tiltMinDeg: null, tiltMaxDeg: null });
  });
});

// Review fix, finding I-3: set_capture_mode had a tool but no dashboard
// client method at all -- pins that McpDashboardClient.setCaptureMode
// actually reaches the real MCP tool with the `enabled` argument, not just
// that ControlDeps/runAction (test/dashboard-controls.test.ts) route to a
// fake.
describe("McpDashboardClient.setCaptureMode", () => {
  it("reaches set_capture_mode with the enabled argument", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    const server = new McpServer({ name: "fake-daemon", version: "test" });
    const seen: unknown[] = [];
    server.registerTool(
      "set_capture_mode",
      { description: "fake", inputSchema: { enabled: z.boolean() } },
      async ({ enabled }: { enabled: boolean }) => {
        seen.push(enabled);
        return text(`auto capture ${enabled ? "enabled" : "disabled"}`);
      },
    );
    const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), sdkClient.connect(c)]);

    const msg = await dash.setCaptureMode(true);
    expect(seen).toEqual([true]);
    expect(msg).toMatch(/enabled/i);
  });
});

// Task 6 / I-C: the dashboard's primary surface said nothing about a pending
// re-zero -- get_rezero_status (src/rezero-tools.ts) existed, but had no
// dashboard client method at all, same class of gap set_capture_mode's own
// test above closed for that tool. getRezeroStatus() is deliberately a thin,
// non-strict parse of only the fields the dashboard's banner needs
// (needs_rezero, landmark_label, remedy) -- same "extra wire fields are
// dropped, not rejected" convention as every other get*() in this file (see
// the module comment atop client.ts); last_rezero/taught_axes/sun_guard/
// fit_residual_deg are deliberately NOT parsed here since nothing on the
// dashboard reads them yet.
describe("McpDashboardClient.getRezeroStatus", () => {
  it("maps needs_rezero/landmark_label/remedy through", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_rezero_status", {
      needs_rezero: true,
      boot_id: 4,
      landmark_label: "tower",
      taught_axes: { pan: false, tilt: true },
      remedy: "centre the stored landmark and call rezero_from_landmark",
      last_rezero: null,
      fit_residual_deg: null,
      sun_guard: { degraded: true, note: "sun protection is degraded" },
    });
    const r = await dash.getRezeroStatus();
    expect(r).toEqual({ needs_rezero: true, landmark_label: "tower", remedy: "centre the stored landmark and call rezero_from_landmark" });
  });

  it("maps the no-re-zero-pending state through, remedy null", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_rezero_status", {
      needs_rezero: false, boot_id: null, landmark_label: null,
      taught_axes: { pan: false, tilt: false }, remedy: null, last_rezero: null,
      fit_residual_deg: null, sun_guard: { degraded: false, note: "sun protection normal" },
    });
    const r = await dash.getRezeroStatus();
    expect(r).toEqual({ needs_rezero: false, landmark_label: null, remedy: null });
  });
});
