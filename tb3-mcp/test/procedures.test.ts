import { describe, it, expect, vi } from "vitest";
import {
  renderCalibration, stepHandler, sightingStripHtml, formatTrackedAircraft, formatTrimOffset,
  renderTravelLimits, teachStripHtml, formatEdgeLabel, formatCurrentPanTilt, renderSetHome,
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
    sightLandmark: vi.fn(),
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

  it("rig-location's done link reads [reset], not [redo], once the IMU sweep exists -- it is a full profile reset, not an in-place edit", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1.4 } };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="rig-location"'), html.indexOf('data-step="imu"'));
    expect(li).toContain('data-act="reset:rig-location"');
    expect(li).toContain(">reset<");
    expect(li).not.toContain("redo");
  });

  it("rig-location's done link stays [redo] when there is nothing else to lose yet (no IMU sweep)", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: null };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="rig-location"'), html.indexOf('data-step="imu"'));
    expect(li).toContain('data-act="redo:rig-location"');
    expect(li).not.toContain("reset");
  });

  it("no OTHER done step is relabeled [reset] -- only rig-location's full-profile-replace is destructive", () => {
    const cal = {
      calibrated: true, provisional: false, rig: { lat: 1, lon: 2, height: 3 },
      imuMounting: { rmsDeg: 1.4 }, sightings: [{}, {}],
    };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    for (const id of ["imu", "north-zero", "sight-1", "sight-2", "solve"]) {
      const li = html.slice(html.indexOf(`data-step="${id}"`), html.length);
      const nextIdx = li.indexOf('data-step="', 1);
      const row = nextIdx === -1 ? li : li.slice(0, nextIdx);
      expect(row).toContain(`data-act="redo:${id}"`);
    }
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

  // The design doc ("the landmark path remains available as an alternative
  // to steps 4-5") requires sight_landmark stay reachable alongside the
  // aircraft-tracking flow, not just over MCP.
  it("an available sighting step also offers [use a landmark instead]", () => {
    const cal = {
      ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1 }, provisional: true,
    };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="sight-1"'), html.indexOf('data-step="sight-2"'));
    expect(li).toContain('data-act="landmark:sight-1"');
    expect(li).toContain("use a landmark instead");
  });

  it("a BLOCKED sighting step does not offer the landmark link -- nothing to click yet", () => {
    // sight-1 is blocked here (no provisional orientation).
    const html = renderCalibration(base, noopActions());
    const li = html.slice(html.indexOf('data-step="sight-1"'), html.indexOf('data-step="sight-2"'));
    expect(li).not.toContain("landmark:sight-1");
    expect(li).not.toContain("use a landmark instead");
  });

  it("a DONE sighting step does not offer the landmark link -- that slot is already filled", () => {
    const cal = {
      ...base.calibration, rig: { lat: 1, lon: 2, height: 3 }, imuMounting: { rmsDeg: 1 }, provisional: true,
      sightings: [{ label: "UAL123", panDeg: 10, tiltDeg: 35 }],
    };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="sight-1"'), html.indexOf('data-step="sight-2"'));
    expect(li).toContain('data-act="redo:sight-1"'); // confirms it's the done row, not blocked/next
    expect(li).not.toContain("landmark:sight-1");
  });

  it("non-sighting steps never offer the landmark link", () => {
    const cal = { ...base.calibration, rig: { lat: 1, lon: 2, height: 3 } };
    const html = renderCalibration({ ...base, calibration: cal }, noopActions());
    const li = html.slice(html.indexOf('data-step="imu"'), html.indexOf('data-step="north-zero"'));
    expect(li).not.toContain("landmark:");
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

describe("renderTravelLimits", () => {
  it("renders all four edges with a [Teach] control each", () => {
    const html = renderTravelLimits({ limits: null }, {});
    for (const edge of ["pan_min", "pan_max", "tilt_min", "tilt_max"]) {
      expect(html).toContain(`data-edge="${edge}"`);
      expect(html).toContain(`data-act="teach:${edge}"`);
    }
  });

  it("shows the current effective values from state.limits, not a cached copy", () => {
    const html = renderTravelLimits(
      { limits: { panMinDeg: -170, panMaxDeg: 170, tiltMinDeg: -10, tiltMaxDeg: 90 } }, {},
    );
    expect(html).toContain("-170.0°");
    expect(html).toContain("170.0°");
    expect(html).toContain("-10.0°");
    expect(html).toContain("90.0°");
  });

  it("shows a dash per edge when limits haven't been polled yet, rather than throwing", () => {
    expect(() => renderTravelLimits({ limits: null }, {})).not.toThrow();
    const html = renderTravelLimits({ limits: null }, {});
    expect(html).toContain("—");
  });

  it("tolerates a missing state entirely", () => {
    expect(() => renderTravelLimits({}, {})).not.toThrow();
    expect(() => renderTravelLimits(undefined, {})).not.toThrow();
  });

  it("offers [clear taught limits], marked destructive", () => {
    const html = renderTravelLimits({ limits: null }, {});
    expect(html).toContain('data-act="clear-limits"');
    expect(html).toContain("destructive");
  });
});

describe("formatEdgeLabel", () => {
  it("turns the wire edge name into a human label", () => {
    expect(formatEdgeLabel("pan_min")).toBe("pan min");
    expect(formatEdgeLabel("pan_max")).toBe("pan max");
    expect(formatEdgeLabel("tilt_min")).toBe("tilt min");
    expect(formatEdgeLabel("tilt_max")).toBe("tilt max");
  });
});

describe("teachStripHtml / formatCurrentPanTilt", () => {
  it("names the edge in the heading, the instruction, and the capture button", () => {
    const html = teachStripHtml("pan_max", {});
    expect(html).toContain("Teach pan max");
    expect(html).toContain("jog to the pan max edge, then capture");
    expect(html).toContain(">Set pan max here<");
  });

  it("carries the strip's [Set edge here]/[cancel] ids and the live pan/tilt region", () => {
    const html = teachStripHtml("tilt_min", {});
    expect(html).toContain('id="strip-capture"');
    expect(html).toContain('id="strip-cancel"');
    expect(html).toContain('data-region="pantilt"');
  });

  it("formatCurrentPanTilt reads the live telemetry, or a dash per axis if unavailable", () => {
    expect(formatCurrentPanTilt({ rig: { panDeg: 12.34, tiltDeg: -5.6 } })).toBe("pan 12.3° / tilt -5.6°");
    expect(formatCurrentPanTilt({ rig: { panDeg: null, tiltDeg: null } })).toBe("pan — / tilt —");
    expect(formatCurrentPanTilt({})).toBe("pan — / tilt —");
  });
});

describe("renderSetHome", () => {
  it("names both consequences as visible text, not a title tooltip", () => {
    const html = renderSetHome({}, {});
    expect(html).toMatch(/calibrat/i);
    expect(html).toMatch(/limit/i);
    expect(html).not.toContain("title=");
  });

  it("the [Set home] control is visually marked destructive, not indistinguishable from any other button", () => {
    const html = renderSetHome({}, {});
    expect(html).toContain('data-act="home:set"');
    expect(html).toContain("destructive");
  });
});
