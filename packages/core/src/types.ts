import { z } from "zod";

export const MemoryCategorySchema = z.enum([
  "basic",
  "goal",
  "interest",
  "expression",
  "emotion",
  "experience",
  "challenge",
  "boundary",
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryTierSchema = z.enum(["short", "long"]);
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

// The legacy values remain readable because migration 007 may already have
// produced them. New model proposals are committed directly as active versions.
export const MemoryStatusSchema = z.enum([
  "pending",
  "accepted",
  "active",
  "superseded",
  "rejected",
  "withdrawn",
  "expired",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

const MemoryEvidenceSchema = z.object({
  reason: z.string().min(1).max(500),
  evidenceMessageIds: z.array(z.string().uuid()).min(1).max(12),
});

const MemoryContentSchema = MemoryEvidenceSchema.extend({
  category: MemoryCategorySchema,
  content: z.string().min(1).max(600),
  tier: MemoryTierSchema,
  confidence: z.number().min(0).max(1),
  validUntil: z.string().datetime().nullable().optional(),
});

export const MemoryMutationSchema = z.discriminatedUnion("operation", [
  MemoryContentSchema.extend({ operation: z.literal("create") }),
  MemoryContentSchema.extend({
    operation: z.literal("supersede"),
    memoryId: z.string().uuid(),
    expectedVersionId: z.string().uuid(),
  }),
  MemoryContentSchema.extend({
    operation: z.literal("promote"),
    memoryId: z.string().uuid(),
    expectedVersionId: z.string().uuid(),
    tier: z.literal("long"),
  }),
  MemoryEvidenceSchema.extend({
    operation: z.literal("withdraw"),
    memoryId: z.string().uuid(),
    expectedVersionId: z.string().uuid(),
  }),
]);
export type MemoryMutation = z.infer<typeof MemoryMutationSchema>;

export const MemorySearchInputSchema = z.object({
  query: z.string().max(1_000),
  limit: z.number().int().min(1).max(8).default(8),
  queryEmbedding: z.array(z.number()).length(1024).optional(),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemoryListInputSchema = z.object({
  tiers: z.array(MemoryTierSchema).min(1).max(2).optional(),
  statuses: z.array(MemoryStatusSchema).min(1).max(7).optional(),
  limit: z.number().int().min(1).max(1_000).default(100),
});
export type MemoryListInput = z.infer<typeof MemoryListInputSchema>;

const IdempotencyKeySchema = z.string().trim().min(8).max(200);

export const MemoryWithdrawInputSchema = z.object({
  memoryId: z.string().uuid(),
  versionId: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type MemoryWithdrawInput = z.infer<typeof MemoryWithdrawInputSchema>;

export const MemoryUsageInputSchema = z.object({
  versionIds: z.array(z.string().uuid()).min(1).max(8),
  conversationId: z.string().uuid(),
  idempotencyKey: IdempotencyKeySchema,
});
export type MemoryUsageInput = z.infer<typeof MemoryUsageInputSchema>;

export const MemoryEmbeddingInputSchema = z.object({
  memoryId: z.string().uuid(),
  versionId: z.string().uuid(),
  embedding: z.array(z.number().finite()).length(1024),
  idempotencyKey: IdempotencyKeySchema,
});
export type MemoryEmbeddingInput = z.infer<typeof MemoryEmbeddingInputSchema>;

export const MemoryConsolidationRewriteSchema = z.object({
  sourceVersionIds: z.array(z.string().uuid()).min(2).max(24),
  category: MemoryCategorySchema,
  content: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});
export type MemoryConsolidationRewrite = z.infer<typeof MemoryConsolidationRewriteSchema>;

export const MemoryConsolidationInputSchema = z.object({
  rewrites: z.array(MemoryConsolidationRewriteSchema).min(1).max(16),
  verification: z.object({
    approved: z.boolean(),
    checkedSourceVersionIds: z.array(z.string().uuid()).max(1_000),
    omittedFacts: z.array(z.string().max(300)).max(24),
    contradictions: z.array(z.string().max(300)).max(24),
    overInferences: z.array(z.string().max(300)).max(24),
  }),
  idempotencyKey: IdempotencyKeySchema,
});
export type MemoryConsolidationInput = z.infer<typeof MemoryConsolidationInputSchema>;

export const MemoryRestoreInputSchema = z.object({
  memoryId: z.string().uuid(),
  versionId: z.string().uuid(),
  expectedActiveVersionId: z.string().uuid().nullable(),
  idempotencyKey: IdempotencyKeySchema,
});
export type MemoryRestoreInput = z.infer<typeof MemoryRestoreInputSchema>;

export type MemoryOperationReceipt = {
  idempotencyKey: string;
  operation: string;
  replayed: boolean;
};

export const MemoryReflectionCommitSchema = z.object({
  memories: z.array(MemoryMutationSchema).max(3),
  mood: z.object({
    score: z.number().int().min(-5).max(5),
    summary: z.string().min(1).max(240),
    meaningful: z.boolean(),
  }).nullable().optional(),
  sessionSummary: z.string().min(1).max(1_200).optional(),
  summaryChanged: z.boolean().optional(),
  returnNote: z.object({
    content: z.string().min(1).max(300),
    validAfter: z.string().datetime(),
    expiresAt: z.string().datetime(),
  }).nullable().optional(),
});
export type MemoryReflectionCommit = z.infer<typeof MemoryReflectionCommitSchema>;

export const DimensionWeightsSchema = z
  .record(MemoryCategorySchema, z.number().min(0).max(1))
  .refine((weights) => Object.values(weights).some((value) => value > 0), {
    message: "至少一个画像维度必须有权重",
  });

export const ReflectionOutputSchema = z.object({
  memories: z.array(MemoryMutationSchema).max(3),
  profileSummary: z.string().min(1).max(1600),
  dimensionWeights: DimensionWeightsSchema,
  mood: z
    .object({
      score: z.number().int().min(-5).max(5),
      summary: z.string().min(1).max(240),
      meaningful: z.boolean(),
    })
    .nullable(),
  sessionSummary: z.string().min(1).max(1200),
  returnNote: z
    .object({
      content: z.string().min(1).max(300),
      validAfter: z.string().datetime(),
      expiresAt: z.string().datetime(),
    })
    .nullable(),
  shouldEvolveSkill: z.boolean(),
  evolutionReason: z.string().max(500).nullable(),
  profileChanged: z.boolean().optional().default(true),
  summaryChanged: z.boolean().optional().default(true),
});
export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;

export const PersonalSkillSchema = z.object({
  expression: z.object({
    warmth: z.number().int().min(0).max(10),
    directness: z.number().int().min(0).max(10),
    brevity: z.number().int().min(0).max(10),
    formality: z.number().int().min(0).max(10),
    humor: z.number().int().min(0).max(10),
    emoji: z.enum(["none", "mirror", "light"]),
  }),
  attention: z.object({
    priorityTopics: z.array(z.string().min(1).max(80)).max(12),
    longTermConcerns: z.array(z.string().min(1).max(120)).max(12),
    unfinishedThreads: z.array(z.string().min(1).max(160)).max(12),
    memoryRecallBias: z.array(MemoryCategorySchema).max(8),
  }),
  rhythm: z.object({
    questionFrequency: z.number().int().min(0).max(10),
    adviceTiming: z.enum(["listen-first", "balanced", "direct"]),
    challengeLevel: z.number().int().min(0).max(10),
    followUpStyle: z.enum(["quiet", "gentle", "active"]),
    responseShape: z.enum(["natural", "compact", "structured-when-needed"]),
  }),
  evolution: z.object({
    triggerEvidenceIds: z.array(z.string().uuid()).max(20),
    reason: z.string().min(1).max(600),
    expectedEffect: z.string().min(1).max(600),
  }),
});
export type PersonalSkill = z.infer<typeof PersonalSkillSchema>;

export type ModelCapabilities = {
  streaming: boolean;
  structuredOutput: boolean;
  toolCalls: boolean;
  nativeWebSearch: boolean;
  usage: boolean;
  maxContextTokens: number;
};

export const ClaimStatusSchema = z.enum(["supported", "uncertain", "human_review"]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ModelTaskSchema = z.enum([
  "dialogue",
  "conversation-title",
  "question-planner",
  "reflection",
  "profile-synthesis",
  "session-summary",
  "return-note",
  "skill-evolution",
  "fact-routing",
  "fact-brief",
  "embedding",
  "memory-consolidation-plan",
  "memory-consolidation-review",
]);
export type ModelTask = z.infer<typeof ModelTaskSchema>;

export type ModelSource = {
  title: string;
  url: string;
  siteName?: string;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  searchCalls: number;
};

export type ModelTransport = "openai-responses" | "openai-chat-completions" | "dashscope-multimodal+openai-chat" | "openai-embeddings" | "scripted" | "replay" | "fault";

export type ModelAttemptMeta = {
  model: string;
  transport: ModelTransport;
  requestId?: string;
  usage: ModelUsage;
  durationMs: number;
  finishReason: string;
  outcome: "completed" | "quality-rejected" | "failed";
  errorCode?: string;
};

export type ModelCallMeta = {
  task: ModelTask;
  provider: string;
  model: string;
  transport: ModelTransport;
  requestId?: string;
  usage: ModelUsage;
  estimatedCostCny: number;
  firstTokenMs?: number;
  durationMs: number;
  finishReason: string;
  retries: number;
  fallbackFrom?: string;
  sources: ModelSource[];
  thinking: boolean;
  attempts?: ModelAttemptMeta[];
};

export type ModelStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "source"; source: ModelSource }
  | { type: "completed"; meta: ModelCallMeta };

export const ConversationTitleOutputSchema = z.object({
  title: z.string().trim().min(4).max(18),
});
export type ConversationTitleOutput = z.infer<typeof ConversationTitleOutputSchema>;

export const QuestionPlannerOutputSchema = z.object({
  gapCandidates: z.array(z.object({
    category: MemoryCategorySchema,
    text: z.string().min(4).max(60),
    options: z.array(z.string().min(1).max(40)).min(2).max(4),
    rationale: z.string().min(1).max(180),
  })).min(2).max(4),
  adjacentCandidates: z.array(z.object({
    category: MemoryCategorySchema,
    text: z.string().min(4).max(60),
    options: z.array(z.string().min(1).max(40)).min(2).max(4),
    rationale: z.string().min(1).max(180),
  })).min(1).max(2),
});
export type QuestionPlannerOutput = z.infer<typeof QuestionPlannerOutputSchema>;

export const ReflectionDecisionSchema = z.object({
  memories: z.array(MemoryMutationSchema).max(3),
  mood: z.object({
    score: z.number().int().min(-5).max(5),
    summary: z.string().min(1).max(240),
    meaningful: z.boolean(),
  }).nullable(),
  refreshProfile: z.boolean(),
  refreshSummary: z.boolean(),
  returnTopic: z.string().min(1).max(240).nullable(),
  shouldEvolveSkill: z.boolean(),
  evolutionReason: z.string().max(500).nullable(),
  needsDeepReview: z.boolean(),
  decisionReason: z.string().min(1).max(500),
});
export type ReflectionDecision = z.infer<typeof ReflectionDecisionSchema>;

export const ProfileSynthesisOutputSchema = z.object({
  summary: z.string().min(1).max(1600),
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
});
export type ProfileSynthesisOutput = z.infer<typeof ProfileSynthesisOutputSchema>;

export const SessionSummaryOutputSchema = z.object({
  summary: z.string().min(1).max(1200),
});

export const ReturnNoteOutputSchema = z.object({
  content: z.string().min(1).max(300),
});

export const FactRoutingOutputSchema = z.object({
  needsSearch: z.boolean(),
  scientific: z.boolean().default(false),
  responseMode: z.enum(["character", "emotional-deep"]).default("character"),
  depth: z.enum(["light", "moderate", "high"]).default("light"),
  physicalSymptom: z.boolean().default(false),
  query: z.string().max(300),
  impact: z.enum(["ordinary", "high"]),
  reason: z.string().min(1).max(240),
});
export type FactRoutingOutput = z.infer<typeof FactRoutingOutputSchema>;

export const EmotionalReplyOutputSchema = z.object({
  paragraphs: z.array(z.string().trim().min(20).max(1_500)).min(2).max(4),
  acknowledgedThreads: z.array(z.string().trim().min(1).max(120)).min(1).max(3),
  primaryNeed: z.enum(["keep-listening", "clarify-together", "gentle-advice"]),
  clarifyingDirection: z.string().trim().min(1).max(180).nullable(),
}).superRefine((value, context) => {
  const content = value.paragraphs.join("\n\n");
  if (content.length < 120) {
    context.addIssue({ code: "custom", message: "情绪回复正文至少需要120个字符" });
  }
  const questionCount = [...content.matchAll(/[？?]/gu)].length;
  if (questionCount > 2) {
    context.addIssue({ code: "custom", message: "情绪回复至多保留两个彼此相关的澄清问题" });
  }
});
export type EmotionalReplyOutput = z.infer<typeof EmotionalReplyOutputSchema>;

export const FactBriefOutputSchema = z.object({
  claims: z.array(z.object({
    text: z.string().min(1).max(500),
    status: ClaimStatusSchema,
    sourceIndices: z.array(z.number().int().min(1)).max(8),
    note: z.string().max(240).optional(),
  })).max(12),
  summary: z.string().min(1).max(1600),
});
export type FactBriefOutput = z.infer<typeof FactBriefOutputSchema>;

export const ScienceExplanationOutputSchema = z.object({
  content: z.string().min(1).max(8_000),
  claimIndicesUsed: z.array(z.number().int().min(1)).max(12),
  analogy: z.object({
    text: z.string().min(1).max(300),
    boundary: z.string().min(1).max(300),
  }).nullable(),
  distinctions: z.array(z.string().min(1).max(240)).max(8),
});
export type ScienceExplanationOutput = z.infer<typeof ScienceExplanationOutputSchema>;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type MemoryRecord = {
  id: string;
  versionId: string;
  category: MemoryCategory;
  content: string;
  tier: "short" | "long";
  confidence: number;
  validUntil: string | null;
  reason: string;
  status?: MemoryStatus;
  lastUsedAt?: string | null;
  evidenceMessageIds?: string[];
  parentVersionIds?: string[];
  createdAt: string;
};

export const RiskLevelSchema = z.enum(["ordinary", "ambiguous", "immediate"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export type RiskAssessment = {
  level: RiskLevel;
  evidence: string[];
  reason: string;
  responsePath: "normal-dialogue" | "clarify-current-danger" | "urgent-real-world-support";
};

export type AtomicClaim = {
  text: string;
  status: ClaimStatus;
  sourceTitle?: string;
  sourceUrl?: string;
  note?: string;
};

export const BenchmarkModeSchema = z.enum(["direct", "profile", "adaptive"]);
export type BenchmarkMode = z.infer<typeof BenchmarkModeSchema>;

export type BenchmarkOutput = {
  mode: BenchmarkMode;
  content: string;
  claims: AtomicClaim[];
  latencyMs: number;
  estimatedTokens: number;
};

export type ProfileSnapshot = {
  id: string;
  summary: string;
  dimensionWeights: Record<string, number>;
  understanding: UnderstandingComponents;
  score: number;
  schemaVersion: string;
  sourceMemoryVersionIds: string[];
  scoreChangeReasons: ScoreChangeReason[];
  syncStatus: "legacy" | "syncing" | "current" | "stale" | "failed";
  createdAt: string;
};

export type ScoreChangeReason = {
  component: keyof UnderstandingComponents | "total";
  delta: number;
  message: string;
};

export type MemoryEventType =
  | "created"
  | "candidate_created"
  | "updated"
  | "confirmed"
  | "superseded"
  | "rejected"
  | "withdrawn"
  | "expired"
  | "used"
  | "embedding_updated"
  | "promoted"
  | "consolidated"
  | "restored";

export type MemoryEventActor = "user" | "model" | "system" | "developer";

export type UnderstandingComponents = {
  coverage: number;
  validation: number;
  personalization: number;
  temporal: number;
};

export type QuestionDefinition = {
  id: string;
  category: MemoryCategory;
  text: string;
  options: string[];
  priority: number;
  keywords?: string[];
};

export type StreamEvent =
  | { type: "message.started"; messageId: string; traceId: string }
  | { type: "text.delta"; delta: string }
  | { type: "tool.started"; name: string }
  | { type: "tool.completed"; name: string }
  | { type: "message.completed"; messageId: string; jobId: string; sources?: ModelSource[] }
  | { type: "error"; code: string; message: string };
