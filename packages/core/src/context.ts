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
  let context: CompiledContext = {
    foundationInstructions: input.foundationInstructions,
    personalSkill: input.personalSkill,
    profileSummary: input.profile?.summary ?? "",
    memories,
    sessionSummary: input.sessionSummary ?? "",
    recentMessages,
    estimatedTokens: 0,
    truncated: false,
  };

  context.estimatedTokens = roughTokens(context);
  while (context.estimatedTokens > input.maxInputTokens && context.memories.length > 2) {
    context.memories = context.memories.slice(0, -1);
    context.truncated = true;
    context.estimatedTokens = roughTokens(context);
  }
  while (
    context.estimatedTokens > input.maxInputTokens &&
    context.recentMessages.length > 4
  ) {
    context.recentMessages = context.recentMessages.slice(2);
    context.truncated = true;
    context.estimatedTokens = roughTokens(context);
  }
  if (context.estimatedTokens > input.maxInputTokens) {
    context.sessionSummary = context.sessionSummary.slice(0, 1200);
    context.profileSummary = context.profileSummary.slice(0, 1200);
    context.truncated = true;
    context.estimatedTokens = roughTokens(context);
  }
  if (context.estimatedTokens > input.maxInputTokens) throw new Error("context_budget_exceeded");
  return context;
}

function roughTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2.4);
}
