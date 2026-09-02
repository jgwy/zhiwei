import { describe, expect, it } from "vitest";
import { estimateModelCostCny } from "./pricing";

describe("model pricing", () => {
  it("includes cached tokens and web search calls", () => {
    expect(estimateModelCostCny({
      model: "qwen3.8-flash",
      usage: {
        inputTokens: 10_000,
        outputTokens: 1_000,
        cachedInputTokens: 2_000,
        reasoningTokens: 500,
        searchCalls: 1,
      },
      searchStrategy: "max",
    })).toBeCloseTo(0.0133, 4);
  });

  it("uses the matching tier and returns zero for an unknown model", () => {
    const catalog = {
      "tiered-model": [
        { maxInputTokens: 1_000, inputPerMillion: 1, outputPerMillion: 2 },
        { maxInputTokens: 10_000, inputPerMillion: 3, outputPerMillion: 4 },
      ],
    };

    expect(estimateModelCostCny({
      model: "tiered-model",
      usage: {
        inputTokens: 2_000,
        outputTokens: 1_000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        searchCalls: 0,
      },
      catalog,
    })).toBe(0.01);

    expect(estimateModelCostCny({
      model: "not-in-catalog",
      usage: {
        inputTokens: 10_000,
        outputTokens: 10_000,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        searchCalls: 0,
      },
      catalog,
    })).toBe(0);
  });

  it("charges turbo and max search calls at their distinct rates", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      searchCalls: 2,
    };

    expect(estimateModelCostCny({ model: "qwen3.8-flash", usage, searchStrategy: "turbo" })).toBe(0.006);
    expect(estimateModelCostCny({ model: "qwen3.8-flash", usage, searchStrategy: "max" })).toBe(0.008);
  });

  it("clamps cached input to total input and does not double-charge reasoning tokens", () => {
    expect(estimateModelCostCny({
      model: "qwen3.8-flash",
      usage: {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cachedInputTokens: 5_000,
        reasoningTokens: 600,
        searchCalls: 0,
      },
    })).toBe(0.0028);
  });
});
