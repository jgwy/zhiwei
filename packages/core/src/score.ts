import type {
  MemoryRecord,
  UnderstandingComponents,
} from "./types";
import { normalizeDimensionWeights } from "./personal-skill";

export function calculateUnderstandingScore(
  components: UnderstandingComponents,
): number {
  const c = clamp(components.coverage);
  const v = clamp(components.validation);
  const p = clamp(components.personalization);
  const t = clamp(components.temporal);
  return Math.min(95, Math.round(95 * c * (0.45 + 0.25 * v + 0.2 * p + 0.1 * t)));
}

export function deriveUnderstandingComponents(input: {
  memories: MemoryRecord[];
  dimensionWeights: Record<string, number>;
  positiveFeedback: number;
  negativeFeedback: number;
  correctedMemories: number;
  now?: Date;
}): UnderstandingComponents {
  const now = input.now ?? new Date();
  const weights = normalizeDimensionWeights(input.dimensionWeights);
  const byCategory = new Map<string, MemoryRecord[]>();
  for (const memory of input.memories) {
    const existing = byCategory.get(memory.category) ?? [];
    existing.push(memory);
    byCategory.set(memory.category, existing);
  }

  let coverage = 0;
  for (const [category, weight] of Object.entries(weights)) {
    const categoryMemories = byCategory.get(category) ?? [];
    if (!categoryMemories.length) continue;
    const quality = Math.min(
      1,
      categoryMemories.reduce((sum, memory) => sum + memory.confidence, 0) /
        Math.max(1, categoryMemories.length * 0.8),
    );
    coverage += weight * quality;
  }

  const total = input.memories.length;
  const confidence = total
    ? input.memories.reduce((sum, memory) => sum + memory.confidence, 0) / total
    : 0;
  const correctionPenalty = total
    ? Math.min(0.4, input.correctedMemories / total)
    : 0;
  const validation = clamp(confidence - correctionPenalty);

  const feedbackTotal = input.positiveFeedback + input.negativeFeedback;
  const personalization = feedbackTotal
    ? (input.positiveFeedback + 1) / (feedbackTotal + 2)
    : 0.5;

  const freshness = total
    ? input.memories.reduce((sum, memory) => {
        const ageDays = Math.max(
          0,
          (now.getTime() - new Date(memory.createdAt).getTime()) / 86_400_000,
        );
        const horizon = memory.tier === "short" ? 30 : 365;
        return sum + Math.max(0.2, 1 - ageDays / horizon);
      }, 0) / total
    : 0;

  return {
    coverage: clamp(coverage),
    validation,
    personalization: clamp(personalization),
    temporal: clamp(freshness),
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

