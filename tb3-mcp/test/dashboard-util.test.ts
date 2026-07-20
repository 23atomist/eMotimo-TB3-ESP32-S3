import { describe, it, expect } from "vitest";
import { withTimeout } from "../src/dashboard/util.js";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("value"), 50, "fast")).resolves.toBe("value");
  });

  it("rejects with the label after ms when the promise never resolves", async () => {
    const never = new Promise<never>(() => { /* deliberately never settles */ });
    await expect(withTimeout(never, 20, "slow-leg")).rejects.toThrow(/slow-leg.*timed out after 20ms/);
  });

  it("propagates the original rejection when the promise rejects before the deadline", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50, "fast")).rejects.toThrow("boom");
  });
});
