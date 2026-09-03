import { describe, expect, it } from "vitest";
import { defaultPersonalSkill, normalizeDimensionWeights } from "./personal-skill";

describe("normalizeDimensionWeights", () => {
  it("includes every memory category in the zero-total fallback", () => {
    const weights = normalizeDimensionWeights({ basic: 0 });
    for (const category of ["basic", "goal", "interest", "expression", "emotion", "experience", "challenge", "boundary"]) {
      expect(weights[category]).toBeGreaterThan(0);
    }
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("normalizes and clamps arbitrary weights", () => {
    const weights = normalizeDimensionWeights({ basic: 2, goal: 2, challenge: 0 });
    expect(weights.basic).toBeCloseTo(weights.goal!, 5);
    expect(weights.challenge).toBeUndefined();
  });
});

describe("defaultPersonalSkill", () => {
  it("parses against the published schema", () => {
    expect(defaultPersonalSkill.expression.warmth).toBeGreaterThan(0);
    expect(defaultPersonalSkill.rhythm.adviceTiming).toBe("listen-first");
  });
});
