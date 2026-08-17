// Task 9 fix round 1, Finding 1: src/server.ts's SECOND, independent
// session.onStateChange listener (the one that drives PassRecorder,
// deliberately separate from the capture listener) was wired but pinned by
// NO test. Traced: test/pass-recorder-wiring.test.ts never imports
// server.ts (it constructs PassRecorder+PassJournal directly); server.test.ts
// and tools.test.ts pin only that `journal` reaches registerTools and that
// `list_passes` exists; vision-composition-root.test.ts drives real main()
// but asserts only vision behaviour. Confirmed directly: deleting the four
// lines that register the listener left the full 1450-test suite green (see
// the deletion experiment recorded in task-9-report.md's Finding 1 section).
//
// Modeled on vision-predictpixel-wiring.test.ts's "spy on the real thing,
// call straight through" approach -- but PassRecorder.onTrack and
// CaptureController.onTrack are both real class instance methods (not
// constructor-bound arrow fields or a factory function), so vi.spyOn on
// each class's OWN PROTOTYPE observes every call through whatever instance
// main() constructs, while still executing the real implementation. No
// vi.mock/importOriginal module replacement is needed for this shape.
//
// Both listeners are asserted, not just one -- the invariant this task
// exists to protect is "two INDEPENDENT listeners fire on the same
// transition", not "at least one listener fires". A regression that merged
// them, wrapped one in the other, or dropped either registration must fail
// this test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { main, type MainHandle } from "../src/server.js";
import { PassRecorder } from "../src/capture/pass-recorder.js";
import { CaptureController } from "../src/capture/controller.js";
import { MockTb3 } from "./mock-tb3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV_PORT = 8960, MCP_PORT = 8961;
const ENV_KEYS = [
  "TB3_CONFIG", "TB3_DEVICE_HOST", "TB3_MCP_PORT", "TB3_ADSB_ENABLED",
  "TB3_CALIBRATION_FILE", "TB3_SECTOR_FILE", "TB3_LIMITS_FILE", "TB3_VISION_SCALE_FILE",
  "TB3_PASS_JOURNAL_FILE",
];
const savedEnv: Record<string, string | undefined> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mock: MockTb3 | null = null;
let handle: MainHandle | null = null;

afterEach(async () => {
  handle?.close(); handle = null;
  if (mock) { await mock.stop(); mock = null; }
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
});

describe("composition root (main()) -- PassRecorder wiring (Task 9 fix round 1, Finding 1)", () => {
  it("wires a SECOND, independent onStateChange listener that drives PassRecorder, alongside the capture listener", async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    mock = new MockTb3(); await mock.start(DEV_PORT);

    // Isolate every store this main() boots against a real device from the
    // developer's own ~/.tb3-mcp files (vision-composition-root.test.ts /
    // vision-predictpixel-wiring.test.ts precedent).
    const dir = mkdtempSync(join(tmpdir(), "tb3-passrecorder-comproot-"));
    process.env.TB3_CONFIG = "";
    process.env.TB3_DEVICE_HOST = `127.0.0.1:${DEV_PORT}`;
    process.env.TB3_MCP_PORT = String(MCP_PORT);
    process.env.TB3_ADSB_ENABLED = "false";
    process.env.TB3_CALIBRATION_FILE = join(dir, "calibration.json");
    process.env.TB3_SECTOR_FILE = join(dir, "sector.json");
    process.env.TB3_LIMITS_FILE = join(dir, "limits.json");
    process.env.TB3_VISION_SCALE_FILE = join(dir, "vision-scale.json");
    process.env.TB3_PASS_JOURNAL_FILE = join(dir, "passes.jsonl");

    // Spy BEFORE main() constructs either instance. Both onTrack methods are
    // real prototype methods (see module doc above), so this observes calls
    // through main()'s own real instances while still calling straight
    // through to the real implementation -- behaviour is unchanged, only
    // observed, same discipline as vision-predictpixel-wiring.test.ts.
    const passOnTrack = vi.spyOn(PassRecorder.prototype, "onTrack");
    const captureOnTrack = vi.spyOn(CaptureController.prototype, "onTrack");

    // main() constructs PassRecorder/CaptureController and registers both
    // listeners unconditionally at boot, regardless of whether the device
    // has finished connecting or ADS-B is enabled (same convention
    // vision-predictpixel-wiring.test.ts relies on for the vision wiring).
    handle = await main();
    await sleep(50);

    expect(passOnTrack).not.toHaveBeenCalled();
    expect(captureOnTrack).not.toHaveBeenCalled();

    // Drive a real state transition through the session's own test seam.
    // Both listeners are registered against the SAME session.onStateChange
    // event, so this one transition must reach both independently.
    handle.session.forceStateForTest("tracking");

    expect(captureOnTrack).toHaveBeenCalledTimes(1);
    expect(captureOnTrack.mock.calls[0][0]).toBe("tracking");

    // THE POINT: PassRecorder's own onTrack must ALSO have fired from this
    // exact transition -- not merged into, wrapped by, or replacing the
    // capture listener above. Delete server.ts's second
    // session.onStateChange(...) registration (the block that calls
    // passRecorder.onTrack) and THIS assertion is what goes red while every
    // other assertion here, and the rest of the suite, stays green -- see
    // task-9-report.md for the recorded experiment.
    expect(passOnTrack).toHaveBeenCalledTimes(1);
    expect(passOnTrack.mock.calls[0][0]).toBe("tracking");

    // A second, distinct transition: both listeners keep firing
    // independently, confirming this isn't a one-shot wiring accident.
    handle.session.forceStateForTest("stopped");
    expect(captureOnTrack).toHaveBeenCalledTimes(2);
    expect(passOnTrack).toHaveBeenCalledTimes(2);
  }, 15000);
});
