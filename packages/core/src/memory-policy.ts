import type {
  MemoryKind,
  MemoryMutation,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
} from "./types";

const EXPLICIT_MEMORY_REQUEST = /(?:请|帮我)?记住|以后记得|请保存|别忘了|不要忘记/u;
const MEMORY_DENIAL = /(?:不要|别|无需|不用)(?:把|再)?[^，。！？]{0,12}(?:记住|记录|保存)|(?:忘掉|删除|撤回)(?:这|刚才|关于)?/u;

export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT_MEMORY_REQUEST.test(text) && !MEMORY_DENIAL.test(text);
}

export function isMemoryDenial(text: string): boolean {
  return MEMORY_DENIAL.test(text);
}

export function inferMemoryKind(content: string, requested?: MemoryKind): MemoryKind {
  if (requested && requested !== "profile") return requested;
  if (/(?:误以为|一直以为|原来不是|容易混淆|理解错|概念错误|错误认识)/u.test(content)) {
    return "misconception";
  }
  if (/(?:已经掌握|已经理解|学会|正在学习|还不理解|知识点|概念|课程|章节)/u.test(content)) {
    return "learning";
  }
  return requested ?? "profile";
}

export function normalizeMemoryMutation(
  mutation: MemoryMutation,
  context: { conversationId: string; projectId?: string; now?: Date },
): MemoryMutation & { kind: MemoryKind; scope: MemoryScope; scopeKey: string | null; status: MemoryStatus } {
  const now = context.now ?? new Date();
  if (mutation.tier === "short") {
    const maximumExpiry = new Date(now.getTime() + 7 * 86_400_000);
    const requestedExpiry = mutation.validUntil ? new Date(mutation.validUntil) : maximumExpiry;
    const validUntil = Number.isFinite(requestedExpiry.getTime()) && requestedExpiry < maximumExpiry
      ? requestedExpiry
      : maximumExpiry;
    return {
      ...mutation,
      kind: "episode",
      scope: "conversation",
      scopeKey: context.conversationId,
      validUntil: validUntil.toISOString(),
      status: "active",
    };
  }

  const requestedKind = inferMemoryKind(mutation.content, mutation.kind);
  const kind = requestedKind === "episode" ? "profile" : requestedKind;
  const scope: MemoryScope = mutation.scope === "project" && context.projectId ? "project" : "user";
  return {
    ...mutation,
    kind,
    scope,
    scopeKey: scope === "project" ? context.projectId! : null,
    status: mutation.sourceType === "inferred" ? "pending" : "active",
  };
}

export function memoryIsRecallable(
  memory: MemoryRecord,
  context: { conversationId?: string; projectId?: string; now?: Date },
): boolean {
  if ((memory.status ?? "active") !== "active") return false;
  const now = (context.now ?? new Date()).getTime();
  if (memory.validUntil && new Date(memory.validUntil).getTime() <= now) return false;
  if (memory.tier === "short") {
    return memory.kind === "episode"
      && memory.scope === "conversation"
      && Boolean(context.conversationId)
      && memory.scopeKey === context.conversationId;
  }
  if (memory.kind === "episode" || memory.scope === "conversation") return false;
  if (memory.scope === "project") return Boolean(context.projectId) && memory.scopeKey === context.projectId;
  return memory.scope === undefined || memory.scope === "user";
}

export function memoryKindLabel(kind?: MemoryKind): string {
  const labels: Record<MemoryKind, string> = {
    profile: "稳定画像",
    learning: "学习进度",
    misconception: "概念误区",
    episode: "会话上下文",
  };
  return labels[kind ?? "profile"];
}
