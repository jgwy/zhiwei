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
  it("keeps explicitly supplied zero dimensions in the complete MCP profile schema",()=>{
    const input={basic:1,goal:0,interest:0,expression:0,emotion:0,experience:0,challenge:0,boundary:0};
    expect(DimensionWeightsSchema.safeParse(normalizeDimensionWeights(input)).success).toBe(true);
    expect(normalizeDimensionWeights(input).boundary).toBe(0);
  });
  it("does not restore excluded dimensions when the supplied subset is all zero",()=>{
    expect(normalizeDimensionWeights({basic:0,boundary:0})).toEqual({basic:0.5,boundary:0.5});
  });
});
