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
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type BootstrapData = {
  user: {
    id: string;
    onboarding_complete: boolean;
    settings: Record<string, boolean>;
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
};
