import type {
  MemoryKind,
  MemoryMutation,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
} from "./types";

const EXPLICIT_MEMORY_REQUEST = /(?:请|帮我)?记住|以后记得|请保存|别忘了|不要忘记/u;
const MEMORY_DENIAL = /(?:不要|别|无需|不用)(?:把|再)?[^，。！？]{0,12}(?:记住|记录|保存)|(?:忘掉|删除|撤回)(?:这|刚才|关于)?/u;
const CORRECTION_SIGNAL = /(?:其实|不是|改成|纠正|记错|不再|现在是|准确地说)/u;
const SECRET_CONTENT = /(密码|口令|API\s*key|密钥|验证码|身份证号|银行卡号)/iu;
const SENSITIVE_CONTENT = /(健康|疾病|用药|政治|宗教|性取向|财务|收入|债务|身份)/u;

export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT_MEMORY_REQUEST.test(text) && !MEMORY_DENIAL.test(text);
}

export function isMemoryDenial(text: string): boolean {
  return MEMORY_DENIAL.test(text);
}

export type MemoryMutationRejection = {
  mutation: MemoryMutation;
  reason: "denied" | "invalid_evidence_message" | "missing_evidence_quote" | "quote_not_in_source" | "quote_does_not_support_memory" | "unsafe_content" | "sensitive_without_consent" | "misclassified_goal" | "duplicate" | "limit";
};

export function validateMemoryEvidence(
  mutation: MemoryMutation,
  context: { sourceMessageId: string; sourceText: string },
): MemoryMutationRejection["reason"] | null {
  if (
    mutation.evidenceMessageIds.length !== 1
    || mutation.evidenceMessageIds[0] !== context.sourceMessageId
  ) return "invalid_evidence_message";

  const quote = mutation.evidenceQuote?.trim();
  if (!quote) return "missing_evidence_quote";
  if (!context.sourceText.includes(quote)) return "quote_not_in_source";

  const normalizedQuote = normalizeEvidenceText(quote);
  const normalizedMemory = normalizeEvidenceText(mutation.content);
  if (!normalizedQuote) return "quote_does_not_support_memory";
  if (/^\d+$/u.test(normalizedQuote) && normalizedMemory !== normalizedQuote) {
    return "quote_does_not_support_memory";
  }
  if (semanticOverlap(quote, mutation.content) < 0.08) return "quote_does_not_support_memory";
  return null;
}

export function selectMemoryMutations(input: {
  mutations: MemoryMutation[];
  activeMemories: MemoryRecord[];
  sourceText: string;
  sourceMessageId: string;
  sourceKind: "chat" | "onboarding";
  limit?: number;
}): { accepted: MemoryMutation[]; rejected: MemoryMutationRejection[] } {
  const accepted: MemoryMutation[] = [];
  const rejected: MemoryMutationRejection[] = [];
  const limit = input.limit ?? 2;
  if (isMemoryDenial(input.sourceText)) {
    return {
      accepted,
      rejected: input.mutations.map((mutation) => ({ mutation, reason: "denied" })),
    };
  }

  const explicitRequest = isExplicitMemoryRequest(input.sourceText) || input.sourceKind === "onboarding";
  const correctionSignal = CORRECTION_SIGNAL.test(input.sourceText);
  for (const mutation of input.mutations) {
    if (accepted.length >= limit) {
      rejected.push({ mutation, reason: "limit" });
      continue;
    }
    const evidenceReason = validateMemoryEvidence(mutation, {
      sourceMessageId: input.sourceMessageId,
      sourceText: input.sourceText,
    });
    if (evidenceReason) {
      rejected.push({ mutation, reason: evidenceReason });
      continue;
    }
    if (mutation.category === "goal" && /^(担心|害怕|忧虑|压力|风险|困扰)/u.test(mutation.content.trim())) {
      rejected.push({ mutation, reason: "misclassified_goal" });
      continue;
    }
    if (SECRET_CONTENT.test(mutation.content)) {
      rejected.push({ mutation, reason: "unsafe_content" });
      continue;
    }
    const sensitive = SENSITIVE_CONTENT.test(mutation.content);
    if (sensitive && !explicitRequest) {
      rejected.push({ mutation, reason: "sensitive_without_consent" });
      continue;
    }

    const kind = inferMemoryKind(mutation.content, mutation.kind);
    const sameCategory = input.activeMemories.filter((memory) => (
      memory.category === mutation.category && (memory.kind ?? "profile") === kind
    ));
    const duplicate = sameCategory.find((memory) => semanticOverlap(memory.content, mutation.content) >= 0.72);
    if (mutation.operation === "create" && duplicate && !correctionSignal) {
      rejected.push({ mutation, reason: "duplicate" });
      continue;
    }
    const conflict = correctionSignal
      ? [...sameCategory].sort((left, right) => semanticOverlap(right.content, mutation.content) - semanticOverlap(left.content, mutation.content))[0]
      : undefined;
    const shouldSupersede = mutation.operation === "create" && conflict
      && semanticOverlap(conflict.content, mutation.content) >= 0.28;
    accepted.push({
      ...mutation,
      operation: shouldSupersede ? "supersede" : mutation.operation,
      memoryId: shouldSupersede ? conflict.id : mutation.memoryId,
      kind,
      tier: explicitRequest || mutation.category === "basic" || kind === "learning" || kind === "misconception"
        ? "long"
        : mutation.tier,
      sourceType: explicitRequest ? "explicit" : shouldSupersede ? "confirmed" : "inferred",
      sensitivity: sensitive ? "sensitive" : mutation.sensitivity ?? "normal",
      importance: mutation.importance ?? (explicitRequest ? 0.8 : 0.5),
    });
  }
  return { accepted, rejected };
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

function normalizeEvidenceText(value: string) {
  return value.replace(/用户|本人|自己|我|你|他|她/gu, "").replace(/[\s，。！？、,.!?：“”"'（）()：:；;]/gu, "");
}

function semanticOverlap(left: string, right: string) {
  const grams = (value: string) => {
    const normalized = normalizeEvidenceText(value);
    if (normalized.length === 1) return new Set([normalized]);
    return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2)));
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return normalizeEvidenceText(left) === normalizeEvidenceText(right) ? 1 : 0;
  const intersection = [...a].filter((gram) => b.has(gram)).length;
  return intersection / Math.max(a.size, b.size);
}
