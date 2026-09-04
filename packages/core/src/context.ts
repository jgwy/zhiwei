import type {
  ChatMessage,
  MemoryRecord,
  PersonalSkill,
  ProfileSnapshot,
} from "./types";

export type CompiledContext = {
  foundationInstructions: string;
  personalSkill: PersonalSkill;
  profileSummary: string;
  memories: MemoryRecord[];
  sessionSummary: string;
  recentMessages: ChatMessage[];
  estimatedTokens: number;
  truncated: boolean;
  maxInputTokens?: number;
};

export function compileContext(input: {
  foundationInstructions: string;
  personalSkill: PersonalSkill;
  profile: ProfileSnapshot | null;
  memories: MemoryRecord[];
  sessionSummary: string | null;
  messages: ChatMessage[];
  maxInputTokens: number;
  memoryLimit?: number;
}): CompiledContext {
  const recentMessages = input.messages.slice(-12);
  const memories = input.memories.slice(0, input.memoryLimit ?? 8);
  const context: CompiledContext = {
    foundationInstructions: input.foundationInstructions,
    personalSkill: input.personalSkill,
    profileSummary: input.profile?.summary ?? "",
    memories,
    sessionSummary: input.sessionSummary ?? "",
    recentMessages,
    estimatedTokens: 0,
    truncated: false,
    maxInputTokens: input.maxInputTokens,
  };
  return fitContextBudget(context, input.maxInputTokens);
}

export function fitContextBudget(
  input: CompiledContext,
  maxInputTokens: number,
  measure: (context: CompiledContext) => number = estimateContextTokens,
): CompiledContext {
  const context = { ...input, maxInputTokens };
  context.estimatedTokens = measure(context);
  while (context.estimatedTokens > maxInputTokens && context.memories.length > 0) {
    context.memories = context.memories.slice(0, -1);
    context.truncated = true;
    context.estimatedTokens = measure(context);
  }
  while (
    context.estimatedTokens > maxInputTokens &&
    context.recentMessages.length > 4
  ) {
    context.recentMessages = context.recentMessages.slice(2);
    context.truncated = true;
    context.estimatedTokens = measure(context);
  }
  if (context.estimatedTokens > maxInputTokens) {
    context.sessionSummary = context.sessionSummary.slice(0, 1200);
    context.profileSummary = context.profileSummary.slice(0, 1200);
    context.truncated = true;
    context.estimatedTokens = measure(context);
  }
  if (context.estimatedTokens > maxInputTokens) {
    context.sessionSummary = "";
    context.profileSummary = "";
    context.estimatedTokens = measure(context);
  }
  if (context.estimatedTokens > maxInputTokens) throw new Error("context_budget_exceeded");
  return context;
}

export function estimateContextTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2.4);
}
