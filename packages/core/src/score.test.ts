import { describe, expect, it } from "vitest";
import {
  calculateUnderstandingScore,
  deriveUnderstandingComponents,
} from "./score";
import type { MemoryRecord } from "./types";

const NOW = new Date("2026-09-03T08:00:00.000Z");
const CATEGORIES: MemoryRecord["category"][] = [
  "basic",
  "goal",
  "interest",
  "expression",
  "emotion",
  "experience",
  "challenge",
  "boundary",
];
const EQUAL_WEIGHTS = Object.fromEntries(
  CATEGORIES.map((category) => [category, 1]),
);

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

  it("keeps three onboarding answers in the just-met range", () => {
    const components = deriveUnderstandingComponents({
      memories: makeMemories(3),
      dimensionWeights: EQUAL_WEIGHTS,
      positiveFeedback: 0,
      negativeFeedback: 0,
      correctedMemories: 0,
      observationSessions: 1,
      observationSpanDays: 0,
      now: NOW,
    });

    expect(calculateUnderstandingScore(components)).toBeGreaterThanOrEqual(5);
    expect(calculateUnderstandingScore(components)).toBeLessThanOrEqual(10);
    expect(components.validation).toBeLessThan(0.15);
    expect(components.personalization).toBeLessThan(0.1);
    expect(components.temporal).toBeLessThan(0.15);
  });

  it("does not turn one information-heavy conversation into high familiarity", () => {
    const eightFacts = deriveScore({ memories: 8, sessions: 1, spanDays: 0 });
    const twentyFourFacts = deriveScore({ memories: 24, sessions: 1, spanDays: 0 });
    const withRepeatedFeedback = deriveScore({ memories: 48, sessions: 1, spanDays: 0, positiveFeedback: 20 });

    expect(eightFacts).toBeLessThanOrEqual(25);
    expect(twentyFourFacts).toBeLessThanOrEqual(25);
    expect(withRepeatedFeedback).toBeLessThanOrEqual(25);
    expect(twentyFourFacts - eightFacts).toBeLessThanOrEqual(4);
  });

  it("does not inflate first-meeting familiarity when model weights concentrate on known dimensions", () => {
    const memories = makeMemories(2);
    const dimensionWeights = Object.fromEntries(CATEGORIES.map(category => [category,
      memories.some(memory => memory.category === category) ? 0.5 : 0,
    ]));
    const components = deriveUnderstandingComponents({
      memories, dimensionWeights, positiveFeedback: 0, negativeFeedback: 0,
      correctedMemories: 0, observationSessions: 1, observationSpanDays: 0, now: NOW,
    });
    expect(calculateUnderstandingScore(components)).toBeLessThanOrEqual(10);
    expect(calculateUnderstandingScore(components)).toBeGreaterThanOrEqual(5);
  });

  it("grows gradually with independent conversations, elapsed time and feedback", () => {
    const progression = [
      deriveScore({ memories: 3, sessions: 1, spanDays: 0 }),
      deriveScore({ memories: 8, sessions: 3, spanDays: 14, positiveFeedback: 1 }),
      deriveScore({ memories: 24, sessions: 8, spanDays: 90, positiveFeedback: 6 }),
      deriveScore({ memories: 48, sessions: 20, spanDays: 365, positiveFeedback: 20 }),
    ];

    expect(progression[0]).toBeGreaterThanOrEqual(5);
    expect(progression[0]).toBeLessThanOrEqual(10);
    expect(progression[1]).toBeGreaterThan(progression[0]!);
    expect(progression[2]).toBeGreaterThan(progression[1]!);
    expect(progression[3]).toBeGreaterThan(progression[2]!);
    expect(progression[3]).toBeLessThanOrEqual(95);
  });

  it("falls after corrections, negative feedback or stale evidence", () => {
    const stable = deriveScore({
      memories: 24,
      sessions: 8,
      spanDays: 120,
      positiveFeedback: 8,
    });
    const corrected = deriveScore({
      memories: 24,
      sessions: 8,
      spanDays: 120,
      positiveFeedback: 2,
      negativeFeedback: 6,
      correctedMemories: 8,
    });
    const stale = deriveScore({
      memories: 24,
      sessions: 8,
      spanDays: 120,
      positiveFeedback: 8,
      now: new Date("2028-09-03T08:00:00.000Z"),
    });

    expect(corrected).toBeLessThan(stable);
    expect(stale).toBeLessThan(stable);
  });

  it("does not let model confidence or ordinary replacement count change familiarity", () => {
    const lowConfidence = makeMemories(12).map((memory) => ({ ...memory, confidence: 0.1 }));
    const highConfidence = makeMemories(12).map((memory) => ({ ...memory, confidence: 0.99 }));
    const base = {
      dimensionWeights: EQUAL_WEIGHTS,
      positiveFeedback: 2,
      negativeFeedback: 0,
      observationSessions: 4,
      observationSpanDays: 30,
      now: NOW,
    };
    const low = calculateUnderstandingScore(deriveUnderstandingComponents({ ...base, memories: lowConfidence, correctedMemories: 0 }));
    const high = calculateUnderstandingScore(deriveUnderstandingComponents({ ...base, memories: highConfidence, correctedMemories: 20 }));

    expect(high).toBe(low);
  });
});

function deriveScore(input: {
  memories: number;
  sessions: number;
  spanDays: number;
  positiveFeedback?: number;
  negativeFeedback?: number;
  correctedMemories?: number;
  now?: Date;
}): number {
  const components = deriveUnderstandingComponents({
    memories: makeMemories(input.memories, input.spanDays),
    dimensionWeights: EQUAL_WEIGHTS,
    positiveFeedback: input.positiveFeedback ?? 0,
    negativeFeedback: input.negativeFeedback ?? 0,
    correctedMemories: input.correctedMemories ?? 0,
    observationSessions: input.sessions,
    observationSpanDays: input.spanDays,
    now: input.now ?? NOW,
  });
  return calculateUnderstandingScore(components);
}

function makeMemories(count: number, spanDays = 0): MemoryRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const elapsedDays = count > 1
      ? spanDays * (1 - index / (count - 1))
      : 0;
    return {
      id: `memory-${index}`,
      versionId: `version-${index}`,
      category: CATEGORIES[index % CATEGORIES.length]!,
      content: `测试记忆 ${index}`,
      tier: "long",
      confidence: 0.88,
      validUntil: null,
      reason: "测试",
      createdAt: new Date(NOW.getTime() - elapsedDays * 86_400_000).toISOString(),
    };
  });
}
