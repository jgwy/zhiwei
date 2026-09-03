import { z } from "zod";
import { MemoryCategorySchema } from "@zhiwei/core";

export const LONG_PROFILE_SCHEMA_VERSION = "long-profile-v2";
export const CONSOLIDATION_COUNT_TRIGGER = 48;
export const CONSOLIDATION_TOKEN_TRIGGER = 12_000;
export const CONSOLIDATION_TARGET_COUNT = 32;
export const CONSOLIDATION_TARGET_TOKENS = 8_000;

export const LifecycleMemoryInputSchema = z.object({
  memoryId: z.string().uuid(),
  versionId: z.string().uuid(),
  category: MemoryCategorySchema,
  content: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
});
export type LifecycleMemoryInput = z.infer<typeof LifecycleMemoryInputSchema>;

export const LongProfileSynthesisOutputSchema = z.object({
  summary: z.string().min(80).max(600),
  dimensionWeights: z.object({
    basic: z.number().min(0).max(1),
    goal: z.number().min(0).max(1),
    interest: z.number().min(0).max(1),
    expression: z.number().min(0).max(1),
    emotion: z.number().min(0).max(1),
    experience: z.number().min(0).max(1),
    challenge: z.number().min(0).max(1),
    boundary: z.number().min(0).max(1),
  }),
  sourceMemoryVersionIds: z.array(z.string().uuid()).max(1_000),
  schemaVersion: z.literal(LONG_PROFILE_SCHEMA_VERSION),
});
export type LongProfileSynthesisOutput = z.infer<typeof LongProfileSynthesisOutputSchema>;

export type LongProfileSynthesisInput = {
  memories: LifecycleMemoryInput[];
  currentSummary?: string;
};

export const ConsolidationRewriteSchema = z.object({
  sourceVersionIds: z.array(z.string().uuid()).min(2).max(24),
  category: MemoryCategorySchema,
  topic: z.string().min(1).max(80),
  content: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});

export const ConsolidationPlanOutputSchema = z.object({
  rewrites: z.array(ConsolidationRewriteSchema).min(1).max(16),
  estimatedResultCount: z.number().int().min(1),
  estimatedResultTokens: z.number().int().min(1),
  rationale: z.string().min(1).max(800),
});
export type ConsolidationPlanOutput = z.infer<typeof ConsolidationPlanOutputSchema>;

export const ConsolidationReviewOutputSchema = z.object({
  approved: z.boolean(),
  checkedSourceVersionIds: z.array(z.string().uuid()).max(1_000),
  omittedFacts: z.array(z.string().min(1).max(300)).max(30),
  contradictions: z.array(z.string().min(1).max(300)).max(30),
  overInferences: z.array(z.string().min(1).max(300)).max(30),
});
export type ConsolidationReviewOutput = z.infer<typeof ConsolidationReviewOutputSchema>;

export type ConsolidationInput = {
  memories: LifecycleMemoryInput[];
  targetCount?: number;
  targetTokens?: number;
};

export type ConsolidationReviewInput = ConsolidationInput & {
  plan: ConsolidationPlanOutput;
};

export function estimateLifecycleTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2.4);
}

export function shouldConsolidateMemories(memories: LifecycleMemoryInput[]): boolean {
  return memories.length >= CONSOLIDATION_COUNT_TRIGGER
    || estimateLifecycleTokens(memories.map(({ content }) => content)) >= CONSOLIDATION_TOKEN_TRIGGER;
}

export function profileSynthesisMode(memories: LifecycleMemoryInput[]): "sparse" | "mature" {
  return memories.length >= 12 || estimateLifecycleTokens(memories.map(({ content }) => content)) >= 1_600
    ? "mature"
    : "sparse";
}

export function assertProfileSources(input: LongProfileSynthesisInput, output: LongProfileSynthesisOutput): void {
  const expected = sortedUnique(input.memories.map((memory) => memory.versionId));
  const actual = sortedUnique(output.sourceMemoryVersionIds);
  if (actual.length !== output.sourceMemoryVersionIds.length || expected.join(":") !== actual.join(":")) {
    throw new Error("长期综述的来源版本集与输入不一致");
  }
  const mode = profileSynthesisMode(input.memories);
  const paragraphCount = output.summary.split(/\n\s*\n/u).filter(Boolean).length;
  if (mode === "sparse" && output.summary.length > 250) {
    throw new Error("记忆较少时长期综述应保持在80至250字");
  }
  if (mode === "mature" && (output.summary.length < 300 || paragraphCount < 2 || paragraphCount > 4)) {
    throw new Error("记忆充分时长期综述应为300至600字且包含2至4个自然段");
  }
}

export function assertConsolidationPlan(input: ConsolidationInput, plan: ConsolidationPlanOutput): void {
  const memories = new Map(input.memories.map((memory) => [memory.versionId, memory]));
  const consumed = new Set<string>();
  for (const rewrite of plan.rewrites) {
    for (const versionId of rewrite.sourceVersionIds) {
      const source = memories.get(versionId);
      if (!source) throw new Error("收拢方案引用了当前活动集合之外的版本");
      if (source.category !== rewrite.category) throw new Error("收拢方案只能合并同类别记忆");
      if (consumed.has(versionId)) throw new Error("同一源版本不能进入多个收拢结果");
      consumed.add(versionId);
    }
  }
  const expectedCount = input.memories.length - consumed.size + plan.rewrites.length;
  const resultingContents = [
    ...input.memories.filter((memory) => !consumed.has(memory.versionId)).map((memory) => memory.content),
    ...plan.rewrites.map((rewrite) => rewrite.content),
  ];
  const actualResultTokens = estimateLifecycleTokens(resultingContents);
  if (plan.estimatedResultCount !== expectedCount) throw new Error("收拢后记忆数估算与方案不一致");
  if (expectedCount >= input.memories.length) throw new Error("收拢方案没有减少活动记忆数");
  const targetCount = input.targetCount ?? CONSOLIDATION_TARGET_COUNT;
  const targetTokens = input.targetTokens ?? CONSOLIDATION_TARGET_TOKENS;
  if (plan.estimatedResultCount > targetCount || plan.estimatedResultTokens > targetTokens || actualResultTokens > targetTokens) {
    throw new Error("收拢方案未达到目标记忆数或上下文体积");
  }
}

export function assertConsolidationReview(
  plan: ConsolidationPlanOutput,
  review: ConsolidationReviewOutput,
): void {
  const expected = sortedUnique(plan.rewrites.flatMap((rewrite) => rewrite.sourceVersionIds));
  const actual = sortedUnique(review.checkedSourceVersionIds);
  if (actual.length !== review.checkedSourceVersionIds.length || expected.join(":") !== actual.join(":")) {
    throw new Error("收拢核对未覆盖方案中的全部源版本");
  }
  const hasIssue = review.omittedFacts.length > 0
    || review.contradictions.length > 0
    || review.overInferences.length > 0;
  if (review.approved === hasIssue) {
    throw new Error("收拢核对结论与问题列表不一致");
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
