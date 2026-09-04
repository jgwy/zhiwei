import type { ChatMessage, CompiledContext, MemoryCategory, PersonalSkill, RiskAssessment, BenchmarkMode } from "@zhiwei/core";

export * from "./gateway";
export * from "./lifecycle";
export * from "./response-quality";
export * from "./fact-grounding";

export type DialogueInput = {
  userId: string;
  conversationId: string;
  messageId: string;
  content: string;
  context: CompiledContext;
  riskAssessment?: RiskAssessment;
  benchmarkMode?: BenchmarkMode;
};

export type ReflectionInput = DialogueInput & {
  kind: "chat" | "onboarding";
  questionId?: string;
  questionCategory?: MemoryCategory;
  /** Frozen, ordered user evidence; replay callers may provide a single message. */
  sourceMessages?: ChatMessage[];
  batchId?: string;
  withdrawals?: Array<{memoryId:string;versionId:string;content:string;withdrawnAt:string}>;
};

export type EvolutionInput = {
  currentSkill: PersonalSkill;
  evidenceIds: string[];
  feedback?: "understood" | "not-me";
  feedbackReason?: string;
  latestUserMessage?: string;
  profileSummary?: string;
};
