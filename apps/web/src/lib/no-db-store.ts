import type { ChatMessage, MemoryMutation, MemoryRecord } from "@zhiwei/core/client";
import type { ConversationView } from "@/lib/client-types";
import { randomUUID } from "node:crypto";

type NoDbState = {
  conversations: ConversationView[];
  memories: MemoryRecord[];
  settings: Record<string, boolean>;
};

const globalStore = globalThis as typeof globalThis & {
  __zhiweiNoDbState?: NoDbState;
};

function state(): NoDbState {
  if (!globalStore.__zhiweiNoDbState) {
    const now = new Date().toISOString();
    globalStore.__zhiweiNoDbState = {
      conversations: [{
        id: randomUUID(),
        title: "第一次聊天",
        titleSource: "default",
        titleLocked: false,
        createdAt: now,
        updatedAt: now,
        messages: [],
      }],
      memories: [],
      settings: {
        memoryEnabled: true,
        emotionTrackingEnabled: true,
        skillEvolutionEnabled: true,
        returnNotesEnabled: true,
      },
    };
  }
  return globalStore.__zhiweiNoDbState;
}

export function isNoDbMode() {
  return process.env.NO_DB_MODE === "true";
}

export function listNoDbConversations() {
  return state().conversations;
}

export function listNoDbMemories() {
  const now = Date.now();
  return state().memories.filter((memory) => !memory.validUntil || new Date(memory.validUntil).getTime() > now);
}

export function getNoDbSettings() {
  return state().settings;
}

export function updateNoDbSettings(settings: Record<string, boolean>) {
  state().settings = { ...state().settings, ...settings };
  return state().settings;
}

export function commitNoDbMemories(mutations: MemoryMutation[], sourceText?: string) {
  if (!state().settings.memoryEnabled) return [];
  const explicitRequest = /记住|以后记得|请保存|别忘了|不要忘记/u.test(sourceText ?? "");
  for (const mutation of mutations.slice(0, 2)) {
    if (/(密码|口令|API\s*key|密钥|验证码|身份证号|银行卡号)/iu.test(mutation.content)) continue;
    const sensitive = /(健康|疾病|用药|政治|宗教|性取向|财务|收入|债务|身份)/u.test(mutation.content);
    if (sensitive && !explicitRequest) continue;
    const memoryId = mutation.memoryId ?? randomUUID();
    state().memories = state().memories.filter((memory) => memory.id !== memoryId);
    const now = new Date().toISOString();
    const sourceType = explicitRequest ? "explicit" : mutation.sourceType;
    state().memories.push({
      id: memoryId,
      versionId: randomUUID(),
      category: mutation.category,
      content: mutation.content.trim().slice(0, 600),
      tier: mutation.tier,
      confidence: mutation.confidence,
      validUntil: mutation.validUntil,
      reason: mutation.reason,
      status: "active",
      sourceType,
      scope: mutation.scope,
      sensitivity: mutation.sensitivity,
      importance: mutation.importance,
      evidenceQuote: mutation.evidenceQuote ?? sourceText?.slice(0, 200) ?? null,
      lastConfirmedAt: sourceType === "explicit" || sourceType === "confirmed" ? now : null,
      lastUsedAt: null,
      createdAt: now,
    });
  }
  return listNoDbMemories();
}

export function updateNoDbMemory(input: { memoryId: string; content: string; category?: MemoryRecord["category"]; tier?: MemoryRecord["tier"]; validUntil?: string | null; reason?: string }) {
  const current = state().memories.find((memory) => memory.id === input.memoryId);
  if (!current) throw new Error("找不到可编辑的活动记忆");
  const now = new Date().toISOString();
  const next: MemoryRecord = {
    ...current,
    versionId: randomUUID(),
    content: input.content.trim().slice(0, 600),
    category: input.category ?? current.category,
    tier: input.tier ?? current.tier,
    validUntil: input.validUntil === undefined ? current.validUntil : input.validUntil,
    reason: input.reason ?? "用户主动修改了这条认识",
    confidence: 1,
    sourceType: "confirmed",
    lastConfirmedAt: now,
    evidenceQuote: "用户编辑后的确认内容",
    createdAt: now,
  };
  state().memories = state().memories.map((memory) => memory.id === input.memoryId ? next : memory);
  return next;
}

export function confirmNoDbMemory(memoryId: string) {
  const current = state().memories.find((memory) => memory.id === memoryId);
  if (!current) throw new Error("找不到可确认的活动记忆");
  const next = { ...current, sourceType: "confirmed" as const, lastConfirmedAt: new Date().toISOString() };
  state().memories = state().memories.map((memory) => memory.id === memoryId ? next : memory);
  return next;
}

export function withdrawNoDbMemory(memoryId: string) {
  const current = state().memories.find((memory) => memory.id === memoryId);
  if (!current) throw new Error("找不到可撤回的活动记忆");
  state().memories = state().memories.filter((memory) => memory.id !== memoryId);
  return { withdrawalId: randomUUID(), memoryId, category: current.category };
}

export function createNoDbConversation(title = "新的对话") {
  const now = new Date().toISOString();
  const conversation: ConversationView = {
    id: randomUUID(),
    title,
    titleSource: "default",
    titleLocked: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  state().conversations.unshift(conversation);
  return conversation;
}

export function updateNoDbConversationTitle(id: string, title: string) {
  const conversation = state().conversations.find((item) => item.id === id);
  if (!conversation) throw new Error("conversation_not_found");
  conversation.title = title.slice(0, 36);
  conversation.titleSource = "manual";
  conversation.titleLocked = true;
  conversation.updatedAt = new Date().toISOString();
}

export function addNoDbMessage(
  conversationId: string,
  role: ChatMessage["role"],
  content: string,
  metadata: Record<string, unknown> = {},
  id: string = randomUUID(),
) {
  const conversation = state().conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new Error("conversation_not_found");
  const message: ChatMessage = {
    id,
    role,
    content,
    metadata,
    createdAt: new Date().toISOString(),
  };
  conversation.messages.push(message);
  conversation.updatedAt = message.createdAt;
  return message;
}
