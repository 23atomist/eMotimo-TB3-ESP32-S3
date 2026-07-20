import { describe, it, expect } from "vitest";
import { resultText } from "../src/agent/mcp-client.js";

describe("resultText", () => {
  it("returns the text of a success result", () => {
    const result = { content: [{ type: "text", text: '{"aircraft":[]}' }] };
    expect(resultText("scan_aircraft", result)).toBe('{"aircraft":[]}');
  });

  it("throws on an error result, including the tool name and daemon text", () => {
    const result = {
      content: [{ type: "text", text: "sun guard active near solar keep-out zone" }],
      isError: true,
    };
    expect(() => resultText("track_aircraft", result)).toThrow(
      /track_aircraft.*sun guard active near solar keep-out zone/,
    );
  });

  it("throws when there is no text content", () => {
    const result = { content: [{ type: "image", data: "..." }] };
    expect(() => resultText("get_tracking_status", result)).toThrow(
      /get_tracking_status.*no text content/,
    );
  });
});
