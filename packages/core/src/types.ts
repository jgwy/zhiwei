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

export const MemoryMutationSchema = z.object({
  operation: z.enum(["create", "supersede", "promote"]),
  memoryId: z.string().uuid().optional(),
  category: MemoryCategorySchema,
  content: z.string().min(1).max(600),
  tier: z.enum(["short", "long"]),
  confidence: z.number().min(0).max(1),
  validUntil: z.string().datetime().nullable(),
  reason: z.string().min(1).max(500),
  evidenceMessageIds: z.array(z.string().uuid()).min(1).max(12),
});
export type MemoryMutation = z.infer<typeof MemoryMutationSchema>;

export const DimensionWeightsSchema = z
  .record(MemoryCategorySchema, z.number().min(0).max(1))
  .refine((weights) => Object.values(weights).some((value) => value > 0), {
    message: "至少一个画像维度必须有权重",
  });

export const ReflectionOutputSchema = z.object({
  memories: z.array(MemoryMutationSchema).max(12),
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
  status?: "active" | "superseded" | "withdrawn";
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

export const ClaimStatusSchema = z.enum(["supported", "uncertain", "human_review"]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

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
  createdAt: string;
};

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
  | { type: "message.completed"; messageId: string; jobId: string }
  | { type: "error"; code: string; message: string };
