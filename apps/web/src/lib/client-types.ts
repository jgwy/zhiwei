import type {
  ChatMessage,
  MemoryRecord,
  PersonalSkill,
  ProfileSnapshot,
  QuestionDefinition,
} from "@zhiwei/core/client";

export type ConversationMeta = {
  id: string;
  title: string;
  titleSource: "default" | "model" | "manual";
  titleLocked: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type MessagePage = { messages: ChatMessage[]; hasMore: boolean; nextCursor: string | null };
export type ConversationView = ConversationMeta & { messages: ChatMessage[] };

export type BootstrapData = {
  account?: { username: string } | null;
  user: {
    id: string;
    onboarding_complete: boolean;
    settings: Record<string, boolean>;
  };
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  messagePage: MessagePage;
  profile: ProfileSnapshot | null;
  memories: MemoryRecord[];
  mood: Array<{ day: string; score: number; summary: string }>;
  skill: {
    id: string;
    version: number;
    content: PersonalSkill;
    triggerReason: string;
    expectedEffect: string;
    createdAt: string;
  } | null;
  onboarding: {
    complete: boolean;
    answeredCount: number;
    canFinish: boolean;
    question: QuestionDefinition | null;
  };
  returnNote: { content: string } | null;
  developerModeAvailable: boolean;
  adapter: string;
  modelModeLabel: string;
  modelCapabilities: {
    streaming: boolean;
    structuredOutput: boolean;
    toolCalls: boolean;
    nativeWebSearch: boolean;
    usage: boolean;
    maxContextTokens: number;
  };
};
