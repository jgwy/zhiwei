import { PersonalSkillSchema, type PersonalSkill } from "./types";

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
  const dimensions = [
    "basic",
    "goal",
    "interest",
    "expression",
    "emotion",
    "experience",
    "challenge",
    "boundary",
  ] as const;
  const entries = dimensions.map((key) => {
    const value = weights[key];
    const normalized = typeof value === "number" && Number.isFinite(value)
      ? value === 0 ? 0 : Math.min(0.35, Math.max(0.04, value))
      : 0;
    return [key, normalized] as const;
  });
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) {
    return normalizeDimensionWeights({
      basic: 0.12,
      goal: 0.18,
      interest: 0.12,
      expression: 0.16,
      emotion: 0.12,
      experience: 0.12,
      challenge: 0.18,
      boundary: 0.08,
    });
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}
