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
  return Math.min(95, Math.round(95 * c * (0.35 + 0.3 * v + 0.2 * p + 0.15 * t)));
}

export function deriveUnderstandingComponents(input: {
  memories: MemoryRecord[];
  dimensionWeights: Record<string, number>;
  positiveFeedback: number;
  negativeFeedback: number;
  correctedMemories: number;
  observationSessions?: number;
  observationSpanDays?: number;
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

  let weightedBreadth = 0;
  for (const [category, weight] of Object.entries(weights)) {
    const categoryMemories = byCategory.get(category) ?? [];
    if (!categoryMemories.length) continue;
    weightedBreadth += weight;
  }

  const total = input.memories.length;
  if (!total) {
    return {
      coverage: 0,
      validation: 0,
      personalization: 0,
      temporal: 0,
    };
  }

  const observationSessions = Math.max(
    1,
    Math.floor(input.observationSessions ?? inferObservationSessions(input.memories)),
  );
  const sessionMaturity = saturate(observationSessions - 1, 4);
  const volumeMaturity = saturate(total, 10);

  // Breadth is useful immediately, but depth must be earned across independent
  // conversations. More facts from one conversation therefore have a limited effect.
  const evidenceDepth = 0.43 + 0.19 * volumeMaturity + 0.38 * sessionMaturity;
  // Concentrating model weights on the first known dimensions must not make a
  // single observation look mature. Independent conversations lift this ceiling.
  const coverage = clamp(Math.min(weightedBreadth * evidenceDepth, 0.25 + 0.75 * sessionMaturity));

  const representedCategories = byCategory.size;
  const corroborationMaturity = saturate(
    Math.max(0, total - representedCategories),
    8,
  );

  const feedbackTotal = input.positiveFeedback + input.negativeFeedback;
  const feedbackMaturity = saturate(feedbackTotal, 6);
  const positiveShare = feedbackTotal
    ? input.positiveFeedback / feedbackTotal
    : 0;
  const negativeShare = feedbackTotal
    ? input.negativeFeedback / feedbackTotal
    : 0;
  // Model confidence and ordinary version replacement are diagnostic data. They
  // do not make the product claim greater familiarity with the user.
  const validationSupport =
    0.14 +
    0.34 * sessionMaturity +
    0.18 * corroborationMaturity * sessionMaturity +
    0.34 * feedbackMaturity * positiveShare * sessionMaturity;
  const validation = clamp(
    validationSupport - 0.25 * feedbackMaturity * negativeShare,
  );

  // No feedback is unknown rather than a neutral 50%. Repeated successful
  // interactions and explicit feedback gradually establish personalization.
  const personalization = clamp(
    0.06 +
      0.22 * sessionMaturity +
      0.14 * corroborationMaturity * sessionMaturity +
      0.6 * feedbackMaturity * positiveShare * sessionMaturity -
      0.45 * feedbackMaturity * negativeShare,
  );

  const freshness = input.memories.reduce((sum, memory) => {
    const ageDays = Math.max(
      0,
      (now.getTime() - new Date(memory.createdAt).getTime()) / 86_400_000,
    );
    const halfLifeDays = memory.tier === "short" ? 30 : 365;
    return sum + Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
  }, 0) / total;
  const observationSpanDays = Math.max(
    0,
    input.observationSpanDays ?? inferObservationSpanDays(input.memories),
  );
  const spanMaturity = saturate(observationSpanDays, 60);
  const temporal = clamp(
    freshness * (0.12 + 0.43 * sessionMaturity + 0.45 * spanMaturity),
  );

  return {
    coverage: clamp(coverage),
    validation,
    personalization,
    temporal,
  };
}

function inferObservationSessions(memories: MemoryRecord[]): number {
  const timestamps = memories
    .map((memory) => new Date(memory.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!timestamps.length) return 0;

  let sessions = 1;
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index]! - timestamps[index - 1]! >= 6 * 60 * 60 * 1_000) {
      sessions += 1;
    }
  }
  return sessions;
}

function inferObservationSpanDays(memories: MemoryRecord[]): number {
  const timestamps = memories
    .map((memory) => new Date(memory.createdAt).getTime())
    .filter(Number.isFinite);
  if (timestamps.length < 2) return 0;
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000;
}

function saturate(value: number, scale: number): number {
  return 1 - Math.exp(-Math.max(0, value) / scale);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
