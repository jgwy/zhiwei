import { MemoryCategorySchema, PersonalSkillSchema, type PersonalSkill } from "./types";

export const defaultPersonalSkill: PersonalSkill = PersonalSkillSchema.parse({
  expression: {
    warmth: 8,
    directness: 6,
    brevity: 5,
    formality: 3,
    humor: 3,
    emoji: "mirror",
  },
  attention: {
    priorityTopics: [],
    longTermConcerns: [],
    unfinishedThreads: [],
    memoryRecallBias: ["goal", "challenge", "expression", "emotion"],
  },
  rhythm: {
    questionFrequency: 5,
    adviceTiming: "listen-first",
    challengeLevel: 6,
    followUpStyle: "gentle",
    responseShape: "natural",
  },
  evolution: {
    triggerEvidenceIds: [],
    reason: "这是知微与新用户初次相识时使用的默认交互方式。",
    expectedEffect: "保持温和、清醒且有充分内容，在获得真实反馈后逐渐适应用户。",
  },
});

export function normalizeDimensionWeights(
  weights: Record<string, number>,
): Record<string, number> {
  const entries = Object.entries(weights)
    .filter(([key, value]) => MemoryCategorySchema.options.includes(key as any) && Number.isFinite(value) && value >= 0)
    .map(([key, value]) => [key, value === 0 ? 0 : Math.min(0.35, Math.max(0.04, value))] as const);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) {
    if (entries.length) return Object.fromEntries(entries.map(([key]) => [key, 1 / entries.length]));
    return {
      basic: 0.125,
      goal: 0.125,
      interest: 0.125,
      expression: 0.125,
      emotion: 0.125,
      experience: 0.125,
      challenge: 0.125,
      boundary: 0.125,
    };
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}
