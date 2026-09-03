import { describe, expect, it } from "vitest";
import { normalizeDimensionWeights } from "./personal-skill";
import { DimensionWeightsSchema } from "./types";

describe("profile dimension normalization", () => {
  it("returns eight valid dimensions only when the input has no usable weights", () => {
    expect(DimensionWeightsSchema.safeParse(normalizeDimensionWeights({})).success).toBe(true);
    expect(normalizeDimensionWeights({ invalid: 1 })).toHaveProperty("boundary");
  });
  it("does not resurrect an excluded emotion dimension", () => {
    const weights = normalizeDimensionWeights({ basic: 0.4, boundary: 0.1 });
    expect(Object.keys(weights)).toEqual(["basic", "boundary"]);
    expect(weights).not.toHaveProperty("emotion");
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });
});
