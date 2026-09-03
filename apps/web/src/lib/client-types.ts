import type {
  ChatMessage,
  MemoryRecord,
  PersonalSkill,
  ProfileSnapshot,
  QuestionDefinition,
} from "@zhiwei/core/client";

export type ConversationView = {
  id: string;
  title: string;
  titleSource: "default" | "model" | "manual";
  titleLocked: boolean;
  createdAt: string;
  updatedAt: string;
  historyRevision: number;
  messages: ChatMessage[];
};

export type BootstrapData = {
  user: {
    id: string;
    onboarding_complete: boolean;
    settings: Record<string, boolean>;
    timezone: string;
  };
  conversations: ConversationView[];
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
