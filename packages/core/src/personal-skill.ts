import {
  MemoryCategorySchema,
  PersonalSkillSchema,
  type MemoryCategory,
  type PersonalSkill,
} from "./types";

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

const MIN_WEIGHT = 0.04;
const MAX_WEIGHT = 0.35;

// DimensionWeightsSchema 是枚举键的穷举 record，缺任何一个维度都会让
// ReflectionOutputSchema.parse 失败，因此兜底必须覆盖全部八个类别。
const fallbackDimensionWeights: Record<MemoryCategory, number> = {
  basic: 0.11,
  goal: 0.16,
  interest: 0.11,
  expression: 0.14,
  emotion: 0.11,
  experience: 0.11,
  challenge: 0.15,
  boundary: 0.11,
};

export function normalizeDimensionWeights(
  weights: Record<string, number>,
): Record<string, number> {
  const merged: Record<MemoryCategory, number> = { ...fallbackDimensionWeights };
  for (const [category, value] of Object.entries(weights)) {
    const parsed = MemoryCategorySchema.safeParse(category);
    if (!parsed.success || !Number.isFinite(value) || value <= 0) continue;
    merged[parsed.data] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, value));
  }
  const total = Object.values(merged).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries(merged).map(([category, value]) => [category, value / total]),
  );
}
