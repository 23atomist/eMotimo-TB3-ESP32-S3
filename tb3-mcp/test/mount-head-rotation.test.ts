import { describe, it, expect } from "vitest";
import { mountHeadRotation, panTiltToMount } from "../src/geo/boresight.js";
import { matVec } from "../src/geo/vec3.js";

describe("mountHeadRotation", () => {
  it("its +Y column equals panTiltToMount (convention matches boresight.ts / validate.py)", () => {
    for (const [p, t] of [[-26, -31], [12, 40], [-125.2, -27.3]] as const) {
      const col = matVec(mountHeadRotation(p, t), [0, 1, 0]);
      const pt = panTiltToMount(p, t);
      expect(col[0]).toBeCloseTo(pt[0], 12);
      expect(col[1]).toBeCloseTo(pt[1], 12);
      expect(col[2]).toBeCloseTo(pt[2], 12);
    }
  });
});
