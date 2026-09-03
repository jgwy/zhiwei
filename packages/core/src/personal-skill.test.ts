import { describe, expect, it } from "vitest";
import { normalizeDimensionWeights } from "./personal-skill";
import { DimensionWeightsSchema } from "./types";

const CATEGORIES = [
  "basic",
  "goal",
  "interest",
  "expression",
  "emotion",
  "experience",
  "challenge",
  "boundary",
] as const;

function sortedKeys(weights: Record<string, number>): string[] {
  return Object.keys(weights).sort();
}

describe("normalizeDimensionWeights", () => {
  it("returns all eight categories for empty input", () => {
    const weights = normalizeDimensionWeights({});
    expect(sortedKeys(weights)).toEqual([...CATEGORIES].sort());
    expect(
      Object.values(weights).reduce((sum, value) => sum + value, 0),
    ).toBeCloseTo(1);
  });

  it("passes the exhaustive DimensionWeightsSchema even for empty input", () => {
    const weights = normalizeDimensionWeights({});
    expect(DimensionWeightsSchema.safeParse(weights).success).toBe(true);
  });

  it("fills missing categories with defaults for partial input", () => {
    const weights = normalizeDimensionWeights({ goal: 0.4, emotion: 0.1 });
    expect(sortedKeys(weights)).toEqual([...CATEGORIES].sort());
    expect(DimensionWeightsSchema.safeParse(weights).success).toBe(true);
    expect(weights.goal ?? 0).toBeGreaterThan(weights.basic ?? 0);
  });

  it("clamps out-of-range values before normalizing", () => {
    const weights = normalizeDimensionWeights({ goal: 5, boundary: 0.01 });
    expect(DimensionWeightsSchema.safeParse(weights).success).toBe(true);
    expect(weights.goal ?? 0).toBeGreaterThan(weights.boundary ?? 0);
  });

  it("ignores invalid values and still returns a complete set", () => {
    const weights = normalizeDimensionWeights({
      goal: Number.NaN,
      emotion: -1,
      interest: 0,
      boundary: 0.2,
    });
    expect(sortedKeys(weights)).toEqual([...CATEGORIES].sort());
    expect(weights.boundary ?? 0).toBeGreaterThan(weights.goal ?? 0);
  });
});
