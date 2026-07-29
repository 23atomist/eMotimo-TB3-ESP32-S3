import { describe, it, expect, vi } from "vitest";
import {
  renderCalibration, stepHandler, sightingStripHtml, formatTrackedAircraft, formatTrimOffset,
} from "../dashboard/public/procedures.js";

const base = {
  calibration: { calibrated: false, provisional: false, rig: null, sightings: [], imuMounting: null },
  adsb: { aircraft: [] },
  tracking: { hex: null, callsign: null, offsetPanDeg: 0, offsetTiltDeg: 0 },
};

function noopActions() {
  return {
    editRigLocation: vi.fn(),
    runImu: vi.fn(),
    setNorthZero: vi.fn(),
    solve: vi.fn(),
    startSighting: vi.fn(),
  };
}

// Order the six <li class="step ...> rows appear in the returned HTML --
// independent of the divider <li> spliced in between them.
function stepOrder(html: string): string[] {
  return [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);
}

describe("renderCalibration", () => {
  it("renders all six steps, in step-gate.js's order", () => {
    const html = renderCalibration(base, noopActions());
    expect(stepOrder(html)).toEqual(["rig-location", "imu", "north-zero", "sight-1", "sight-2", "solve"]);
  });

  it("numbers rows 1-6 regardless of the divider spliced in after step 3", () => {
    const html = renderCalibration(base, noopActions());
    const nums = [...html.matchAll(/<span class="num">(\d)<\/span>/g)].map((m) => m[1]);
    expect(nums).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("inserts the tracking-unlock divider right after north-zero (step 3), before sighting 1", () => {
    const html = renderCalibration(base, noopActions());
    const northZeroIdx = html.indexOf('data-step="north-zero"');
    const dividerIdx = html.indexOf("steps-divider");
    const sight1Idx = html.indexOf('data-step="sight-1"');
    expect(northZeroIdx).toBeGreaterThan(-1);
    expect(dividerIdx).toBeGreaterThan(northZeroIdx);
    expect(sight1Idx).toBeGreaterThan(dividerIdx);
  });

  it("a blocked step's reason is VISIBLE TEXT, not a title tooltip -- that is this task's whole point", () => {
    const html = renderCalibration(base, noopActions());
    // "imu" is blocked with no rig location yet.
    const li = html.slice(html.indexOf('data-step="imu"'), html.indexOf('data-step="north-zero"'));
    expect(li).toContain('class="blocked-reason"');
    expect(li).toMatch(/needs the rig location first/);
    expect(li).not.toContain("title=");
  });

  it("a done step shows [redo], not [run]", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="rig-location"'), html.indexOf('data-step="imu"'));
    expect(li).toContain('data-act="redo:rig-location"');
    expect(li).not.toContain("data-act=\"run:rig-location\"");
  });

  it("an available (non-sighting) step shows [run]", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="imu"'), html.indexOf('data-step="north-zero"'));
    expect(li).toContain('data-act="run:imu"');
    expect(li).toContain(">run<");
  });

  it("an available sighting step shows [start], not [run]", () => {
    const cal = {
      ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1 }, provisional: true,
    };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="sight-1"'), html.indexOf('data-step="sight-2"'));
    expect(li).toContain('data-act="run:sight-1"');
    expect(li).toContain(">start<");
  });

  it("shows the UNCALIBRATED badge when nothing has run yet", () => {
    const html = renderCalibration(base, noopActions());
    expect(html).toContain("badge-uncalibrated");
    expect(html).toContain("UNCALIBRATED");
  });

  it("shows the PROVISIONAL badge distinctly from CALIBRATED once north-zero has seeded an orientation", () => {
    const cal = { ...base.calibration, provisional: true };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    expect(html).toContain("badge-provisional");
    expect(html).toContain("PROVISIONAL");
    expect(html).not.toContain("badge-calibrated");
  });

  it("shows the CALIBRATED badge, distinct from PROVISIONAL, once solved", () => {
    const cal = { calibrated: true, provisional: false, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1 }, sightings: [{}, {}] };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    expect(html).toContain("badge-calibrated");
    expect(html).toContain("CALIBRATED");
    expect(html).not.toContain("badge-provisional");
  });

  it("escapes untrusted detail/reason/label text (e.g. an aircraft callsign) rather than injecting it raw", () => {
    const cal = {
      ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1 }, provisional: true,
      sightings: [{ label: '<img src=x onerror=alert(1)>' }],
    };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("tolerates a missing/degraded calibration payload without throwing", () => {
    expect(() => renderCalibration({}, noopActions())).not.toThrow();
    expect(() => renderCalibration({ calibration: null }, noopActions())).not.toThrow();
  });
});

describe("stepHandler", () => {
  const drawer = { collapseToStrip: vi.fn(), expand: vi.fn() };

  it("dispatches each step id to its one action", () => {
    const actions = noopActions();
    stepHandler("rig-location", drawer, base, actions);
    expect(actions.editRigLocation).toHaveBeenCalledTimes(1);

    stepHandler("imu", drawer, base, actions);
    expect(actions.runImu).toHaveBeenCalledTimes(1);

    stepHandler("north-zero", drawer, base, actions);
    expect(actions.setNorthZero).toHaveBeenCalledTimes(1);

    stepHandler("solve", drawer, base, actions);
    expect(actions.solve).toHaveBeenCalledTimes(1);
  });

  it("hands sight-1/sight-2 to startSighting with the step id and the drawer", () => {
    const actions = noopActions();
    stepHandler("sight-1", drawer, base, actions);
    expect(actions.startSighting).toHaveBeenCalledWith("sight-1", drawer);

    stepHandler("sight-2", drawer, base, actions);
    expect(actions.startSighting).toHaveBeenCalledWith("sight-2", drawer);
  });

  it("is a no-op for an unrecognized id", () => {
    const actions = noopActions();
    expect(stepHandler("not-a-step", drawer, base, actions)).toBeUndefined();
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("sightingStripHtml / formatTrackedAircraft / formatTrimOffset", () => {
  it("labels sighting 1 vs sighting 2", () => {
    expect(sightingStripHtml("sight-1", base)).toContain("Sighting 1");
    expect(sightingStripHtml("sight-2", base)).toContain("Sighting 2");
  });

  it("carries the strip's [Sight it]/[cancel] ids and the live-readout regions", () => {
    const html = sightingStripHtml("sight-1", base);
    expect(html).toContain('id="strip-sight"');
    expect(html).toContain('id="strip-cancel"');
    expect(html).toContain('data-region="aircraft"');
    expect(html).toContain('data-region="offset"');
  });

  it("formatTrackedAircraft shows the tracked callsign/hex, or says none is tracked", () => {
    expect(formatTrackedAircraft(base)).toMatch(/no aircraft tracked/i);
    const withTarget = { tracking: { hex: "a1b2c3", callsign: "UAL123" } };
    expect(formatTrackedAircraft(withTarget)).toContain("UAL123");
    expect(formatTrackedAircraft(withTarget)).toContain("a1b2c3");
  });

  it("formatTrimOffset always reads as a number, never a dash, matching cockpit.js's trkOffset convention", () => {
    expect(formatTrimOffset(base)).toBe("trim 0.00° / 0.00°");
    const withOffset = { tracking: { offsetPanDeg: 1.234, offsetTiltDeg: -0.5 } };
    expect(formatTrimOffset(withOffset)).toBe("trim 1.23° / -0.50°");
  });
});
