import type { ModelUsage } from "./types";

export type PriceRange = {
  maxInputTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
};

export const fallbackPriceCatalog: Record<string, PriceRange[]> = {
  "qwen-plus-character": [{
    maxInputTokens: 32_768,
    inputPerMillion: 0.8,
    outputPerMillion: 2,
    cachedInputPerMillion: 0.16,
  }],
  "qwen3.8-flash": [{
    maxInputTokens: 1_000_000,
    inputPerMillion: 0.8,
    outputPerMillion: 2.7,
    cachedInputPerMillion: 0.1,
  }],
  "qwen3.7-text-embedding": [{
    maxInputTokens: 128_000,
    inputPerMillion: 0.5,
    outputPerMillion: 0,
  }],
};

export function estimateModelCostCny(input: {
  model: string;
  usage: ModelUsage;
  searchStrategy?: "turbo" | "max";
  catalog?: Record<string, PriceRange[]>;
}) {
  const ranges = input.catalog?.[input.model] ?? fallbackPriceCatalog[input.model] ?? [];
  const range = ranges.find((candidate) => input.usage.inputTokens <= candidate.maxInputTokens)
    ?? ranges.at(-1);
  if (!range) return 0;
  const cached = Math.min(input.usage.inputTokens, Math.max(0, input.usage.cachedInputTokens));
  const uncached = Math.max(0, input.usage.inputTokens - cached);
  const tokenCost =
    (uncached / 1_000_000) * range.inputPerMillion
    + (cached / 1_000_000) * (range.cachedInputPerMillion ?? range.inputPerMillion)
    + (input.usage.outputTokens / 1_000_000) * range.outputPerMillion;
  const searchUnit = input.searchStrategy === "max" ? 0.004 : 0.003;
  return Number((tokenCost + input.usage.searchCalls * searchUnit).toFixed(6));
}
