import { describe, it, expect } from "vitest";
import { tokenFromCookie } from "../src/dashboard/auth.js";

describe("tokenFromCookie", () => {
  it("extracts tb3_token from a multi-cookie header", () => {
    expect(tokenFromCookie("a=1; tb3_token=xyz; b=2", "tb3_token")).toBe("xyz");
  });

  it("returns null when the named cookie is absent", () => {
    expect(tokenFromCookie("a=1; b=2", "tb3_token")).toBeNull();
  });

  it("returns null when the cookie header is undefined", () => {
    expect(tokenFromCookie(undefined, "tb3_token")).toBeNull();
  });

  it("URL-decodes the cookie value", () => {
    expect(tokenFromCookie("tb3_token=a%2Fb%20c", "tb3_token")).toBe("a/b c");
  });

  it("handles a single bare cookie with no surrounding entries", () => {
    expect(tokenFromCookie("tb3_token=solo", "tb3_token")).toBe("solo");
  });
});
