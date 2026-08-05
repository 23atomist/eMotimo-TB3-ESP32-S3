// NP-1 (round 4, follow-up): the composition-root test in
// vision-composition-root.test.ts reliably catches mutations to
// VisionCorrector's own axisSigns/tiltCalibrated Deps (both verified by
// mutation), but could NOT reliably catch deleting buildPredictPixel's
// tiltCalibrated ARGUMENT in server.ts specifically -- that mechanism needs
// a real posture-vs-target tilt lag inside a narrow (~1.9-3.7deg) band
// (derived and measured in the other file's own module doc), and landing a
// live geo-tracking transient reliably inside that band proved flaky even
// at HEAD. Confirmed directly: with the argument deleted, ALL 1375 other
// tests still passed.
//
// This closes that specific gap a different way: spy on the REAL
// buildPredictPixel (vi.mock with importOriginal, calling straight through
// to the genuine implementation -- behaviour is unchanged, only observed)
// and assert main() calls it with a tiltCalibrated argument that is (a)
// actually a function, not omitted, and (b) wired to the SAME
// VisionRuntime the rest of main()'s vision wiring uses, not a hardcoded
// constant. No physics, no timing, no live tracking required -- main()
// constructs the corrector (and this call) unconditionally at boot,
// independent of whether vision is enabled.
import { describe, it, expect, vi, afterEach } from "vitest";

const buildPredictPixelSpy = vi.fn();

vi.mock("../src/vision-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vision-tools.js")>();
  return {
    ...actual,
    buildPredictPixel: (...args: Parameters<typeof actual.buildPredictPixel>) => {
      buildPredictPixelSpy(...args);
      return actual.buildPredictPixel(...args);
    },
  };
});

import { main, type MainHandle } from "../src/server.js";
import { MockTb3 } from "./mock-tb3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV_PORT = 8854, MCP_PORT = 8855;
const ENV_KEYS = [
  "TB3_CONFIG", "TB3_DEVICE_HOST", "TB3_MCP_PORT", "TB3_ADSB_ENABLED",
  "TB3_CALIBRATION_FILE", "TB3_SECTOR_FILE", "TB3_LIMITS_FILE", "TB3_VISION_SCALE_FILE",
];
const savedEnv: Record<string, string | undefined> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mock: MockTb3 | null = null;
let handle: MainHandle | null = null;

afterEach(async () => {
  handle?.close(); handle = null;
  if (mock) { await mock.stop(); mock = null; }
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  buildPredictPixelSpy.mockClear();
});

it("main() wires buildPredictPixel's tiltCalibrated argument to the real VisionRuntime, not a hardcoded constant", async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  mock = new MockTb3(); await mock.start(DEV_PORT);

  // Isolate every store this main() boots against a real device from the
  // developer's own ~/.tb3-mcp files (dashboard-camera-error.test.ts /
  // vision-composition-root.test.ts precedent).
  const dir = mkdtempSync(join(tmpdir(), "tb3-predictpixel-wiring-"));
  process.env.TB3_CONFIG = "";
  process.env.TB3_DEVICE_HOST = `127.0.0.1:${DEV_PORT}`;
  process.env.TB3_MCP_PORT = String(MCP_PORT);
  process.env.TB3_ADSB_ENABLED = "false";
  process.env.TB3_CALIBRATION_FILE = join(dir, "calibration.json");
  process.env.TB3_SECTOR_FILE = join(dir, "sector.json");
  process.env.TB3_LIMITS_FILE = join(dir, "limits.json");
  process.env.TB3_VISION_SCALE_FILE = join(dir, "vision-scale.json");

  // main() constructs the corrector -- and this buildPredictPixel call --
  // unconditionally at boot, regardless of visionEnabled (default false)
  // and regardless of whether the device has finished connecting.
  handle = await main();
  await sleep(50);

  expect(buildPredictPixelSpy).toHaveBeenCalledTimes(1);
  const args = buildPredictPixelSpy.mock.calls[0];
  // 7 positional params: session, targetHistory, postures, focalPx,
  // maxTargetAgeMs, axisSigns, tiltCalibrated. This length check alone
  // catches an OMITTED argument (exactly the NP-1 mutation: deleting the
  // trailing tiltCalibrated line drops the call to 6 args). It would NOT
  // catch a mutation that kept the arg count but swapped in a hardcoded
  // () => true/false -- that class is caught by the live-toggle assertion
  // below instead.
  expect(args.length).toBeGreaterThanOrEqual(7);
  const tiltCalibratedArg = args[6];
  expect(typeof tiltCalibratedArg).toBe("function");

  // THE POINT: it must track visionRuntime.tiltCalibrated() LIVE, not a
  // hardcoded true/false -- toggle the runtime's own state (via the same
  // public setScale() surface calibrate_vision_scale itself uses) and
  // confirm the SAME closure reflects the change, proving it reads from
  // the real object rather than having captured a fixed snapshot or
  // default at construction time.
  expect(handle.visionRuntime.tiltCalibrated()).toBe(false); // nothing calibrated yet
  expect(tiltCalibratedArg()).toBe(false);

  handle.visionRuntime.setScale({ focalPx: 1000, latencyMs: 0, axisSigns: { pan: 1, tilt: -1 } });
  expect(handle.visionRuntime.tiltCalibrated()).toBe(true);
  expect(tiltCalibratedArg()).toBe(true);
});
