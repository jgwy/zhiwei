import { describe, expect, it } from "vitest";
import { normalizeDimensionWeights } from "./personal-skill";

const dimensions = [
  "basic",
  "goal",
  "interest",
  "expression",
  "emotion",
  "experience",
  "challenge",
  "boundary",
];

describe("normalizeDimensionWeights", () => {
  it("always returns all profile dimensions", () => {
    const weights = normalizeDimensionWeights({ basic: 0.4, goal: 0.2 });

    expect(Object.keys(weights)).toEqual(dimensions);
    expect(weights.expression).toBe(0);
    expect(weights.boundary).toBe(0);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("uses a complete default distribution when no weights are usable", () => {
    const weights = normalizeDimensionWeights({});

    expect(Object.keys(weights)).toEqual(dimensions);
    expect(weights.boundary).toBeGreaterThan(0);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });
});
