import { describe, expect, it } from "vitest";
import { calculateUnderstandingScore } from "./score";

describe("calculateUnderstandingScore", () => {
  it("starts from zero when there is no profile coverage", () => {
    expect(
      calculateUnderstandingScore({
        coverage: 0,
        validation: 1,
        personalization: 1,
        temporal: 1,
      }),
    ).toBe(0);
  });

  it("is capped at 95", () => {
    expect(
      calculateUnderstandingScore({
        coverage: 1,
        validation: 1,
        personalization: 1,
        temporal: 1,
      }),
    ).toBe(95);
  });

  it("can decrease after a negative signal", () => {
    const before = calculateUnderstandingScore({
      coverage: 0.7,
      validation: 0.9,
      personalization: 0.9,
      temporal: 0.9,
    });
    const after = calculateUnderstandingScore({
      coverage: 0.7,
      validation: 0.6,
      personalization: 0.3,
      temporal: 0.7,
    });
    expect(after).toBeLessThan(before);
  });
});

