import { describe, it, expect } from "vitest";
import { aircraftOption, buildAircraftOptions } from "../dashboard/public/aircraft-select.js";

function row(over: Record<string, unknown> = {}) {
  return { hex: "abc123", callsign: "UAL123", azimuth_deg: 45, elevation_deg: 12, range_km: 30.4, ...over };
}

describe("aircraftOption", () => {
  it("formats callsign, bearing/elevation, and range", () => {
    const o = aircraftOption(row());
    expect(o.value).toBe("abc123");
    expect(o.label).toBe("UAL123 · az 45° el 12° · 30.4 km");
  });

  it("falls back to the hex when no callsign is broadcast", () => {
    const o = aircraftOption(row({ callsign: null }));
    expect(o.label.startsWith("abc123")).toBe(true);
  });
});

describe("buildAircraftOptions", () => {
  it("builds one option per row and selects the nearest (first, already range-sorted) with no prior selection", () => {
    const rows = [row({ hex: "near" }), row({ hex: "far" })];
    const { options, selectedHex } = buildAircraftOptions(rows, "");
    expect(options).toHaveLength(2);
    expect(selectedHex).toBe("near");
  });

  it("preserves the operator's previous selection when it is still in range", () => {
    const rows = [row({ hex: "near" }), row({ hex: "far" })];
    const { selectedHex } = buildAircraftOptions(rows, "far");
    expect(selectedHex).toBe("far");
  });

  it("falls back to nearest when the previous selection has left the list", () => {
    const rows = [row({ hex: "near" }), row({ hex: "far" })];
    const { selectedHex } = buildAircraftOptions(rows, "gone");
    expect(selectedHex).toBe("near");
  });

  it("returns no options and no selection for an empty list", () => {
    const { options, selectedHex } = buildAircraftOptions([], "anything");
    expect(options).toHaveLength(0);
    expect(selectedHex).toBe("");
  });

  it("tolerates a non-array input (pre-first-tick / malformed state)", () => {
    const { options, selectedHex } = buildAircraftOptions(null, "x");
    expect(options).toHaveLength(0);
    expect(selectedHex).toBe("");
  });
});
