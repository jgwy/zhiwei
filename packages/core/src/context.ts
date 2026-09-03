import type {
  ChatMessage,
  ConversationSummaryRecord,
  MemoryRecord,
  PersonalSkill,
  ProfileSnapshot,
  TemporalContext,
} from "./types";
import { createTemporalContext } from "./temporal";

export type CompiledContext = {
  foundationInstructions: string;
  personalSkill: PersonalSkill;
  profileSummary: string;
  profileUpdatedAt: string | null;
  memories: MemoryRecord[];
  sessionSummary: ConversationSummaryRecord | null;
  recentMessages: ChatMessage[];
  temporalContext: TemporalContext;
  estimatedTokens: number;
  truncated: boolean;
};

export function compileContext(input: {
  foundationInstructions: string;
  personalSkill: PersonalSkill;
  profile: ProfileSnapshot | null;
  memories: MemoryRecord[];
  sessionSummary: ConversationSummaryRecord | null;
  messages: ChatMessage[];
  maxInputTokens: number;
  timeZone: string;
  now?: Date;
}): CompiledContext {
  const recentMessages = input.messages.slice(-12);
  const memories = input.memories.slice(0, 8);
  let context: CompiledContext = {
    foundationInstructions: input.foundationInstructions,
    personalSkill: input.personalSkill,
    profileSummary: input.profile?.summary ?? "",
    profileUpdatedAt: input.profile?.createdAt ?? null,
    memories,
    sessionSummary: input.sessionSummary,
    recentMessages,
    temporalContext: createTemporalContext(input.timeZone, input.now),
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
    if (context.sessionSummary) {
      context.sessionSummary = {
        ...context.sessionSummary,
        summary: context.sessionSummary.summary.slice(0, 1200),
      };
    }
    context.profileSummary = context.profileSummary.slice(0, 1200);
    context.truncated = true;
    context.estimatedTokens = roughTokens(context);
  }
  return context;
}

function roughTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2.4);
}

