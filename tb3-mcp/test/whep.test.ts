import { describe, it, expect } from "vitest";
import { whepUrl, sdpLooksValid } from "../dashboard/public/whep.js";

describe("whepUrl", () => {
  it("appends the whep path to a bare base", () => {
    expect(whepUrl("")).toBe("/camera/whep");
  });
  it("preserves an auth token query so the gate still applies", () => {
    expect(whepUrl("?token=abc")).toBe("/camera/whep?token=abc");
  });
});

describe("sdpLooksValid", () => {
  it("accepts an SDP answer", () => {
    expect(sdpLooksValid("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n")).toBe(true);
  });
  it("rejects empty or non-SDP bodies", () => {
    expect(sdpLooksValid("")).toBe(false);
    expect(sdpLooksValid("WHEP proxy failed")).toBe(false);
  });
});
