import { describe, it, expect } from "vitest";
import { isSessionError } from "../src/agent/mcp-client.js";

describe("isSessionError (triggers MCP client reconnect on daemon restart)", () => {
  it("matches the real daemon-restart error the SDK throws", () => {
    // Verbatim shape from the field: a restarted daemon rejects the old session.
    const e = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"no valid session"},"id":null}',
    );
    expect(isSessionError(e)).toBe(true);
  });

  it("matches the -32000 code and session-not-found/expired phrasings", () => {
    expect(isSessionError(new Error("JSON-RPC error -32000"))).toBe(true);
    expect(isSessionError(new Error("Session not found"))).toBe(true);
    expect(isSessionError("session expired")).toBe(true);
  });

  it("does NOT match unrelated errors (so those aren't retried blindly)", () => {
    expect(isSessionError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isSessionError(new Error("device rejected goto: still moving"))).toBe(false);
    expect(isSessionError(new Error("sun guard active; blocked to protect the camera"))).toBe(false);
  });
});
