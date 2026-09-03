import { createHash } from "node:crypto";
import type {
  MemoryMutation,
  MemoryRecord,
  MemoryScope,
  MemorySensitivity,
  MemorySourceType,
  MemoryStatus,
} from "./types";

const EXPLICIT_SAVE = /(?:请|帮我)?(?:重新|再)?记住|以后记得|请保存|别忘了|不要忘记/u;
const MEMORY_DENIAL = /(?:不要|别|无需|不用)(?:把|再)?[^，。！？]{0,12}(?:记住|记录|保存)|(?:忘掉|删除|撤回)(?:这条|刚才这条|关于这条)?(?:记忆|认识)?/u;
const CORRECTION = /(?:其实|不是|改成|纠正|记错|不再|现在是|准确地说)/u;
const FORBIDDEN_SECRET = /(?:密码|口令|API\s*key|密钥|验证码|身份证号|银行卡号)/iu;
const SENSITIVE_CONTENT = /(?:健康|疾病|诊断|用药|服药|病史|头晕|眩晕|头痛|失眠|抑郁|焦虑症|政治|宗教|性取向|财务|收入|债务|身份信息)/u;

export const SHORT_MEMORY_MAX_AGE_MS = 7 * 86_400_000;

export type NormalizedMemoryMutation = MemoryMutation & {
  sourceType: MemorySourceType;
  scope: MemoryScope;
  scopeKey: string | null;
  sensitivity: MemorySensitivity;
  status: MemoryStatus;
  validUntil: string | null;
};

export function isExplicitMemoryRequest(text: string): boolean {
  return EXPLICIT_SAVE.test(text) && !isMemoryDenial(text);
}

export function isExplicitMemoryRequestForQuote(sourceText: string, evidenceQuote?: string): boolean {
  if (!evidenceQuote) return false;
  const normalizedSource = normalizeMemoryContent(sourceText);
  const normalizedQuote = normalizeMemoryContent(evidenceQuote);
  const quoteIndex = normalizedSource.indexOf(normalizedQuote);
  if (quoteIndex < 0) return false;
  if (isExplicitMemoryRequest(normalizedQuote)) return true;

  const clauses = normalizedSource.slice(0, quoteIndex).split(/[，。！？；,!?;]/u);
  const precedingInstruction = [...clauses].reverse().find((clause) => clause.trim().length > 0) ?? "";
  return isExplicitMemoryRequest(`${precedingInstruction}${normalizedQuote}`);
}

export function isMemoryDenial(text: string): boolean {
  return MEMORY_DENIAL.test(text);
}

export function isMemoryCorrection(text: string): boolean {
  return CORRECTION.test(text);
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(normalizeMemoryContent(content)).digest("hex");
}

export function normalizeMemoryContent(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

export function shouldPersistMemory(
  content: string,
  sourceText: string,
  _sourceType: MemorySourceType,
  category?: MemoryMutation["category"],
  evidenceQuote?: string,
): boolean {
  if (FORBIDDEN_SECRET.test(content)) return false;
  const relevantEvidence = evidenceQuote ?? sourceText;
  return category === "boundary" || !isMemoryDenial(relevantEvidence);
}

export function validatedMemorySourceType(
  requested: MemorySourceType | undefined,
  evidenceQuote: string | undefined,
  evidenceTexts: string[],
  conversationKind: "chat" | "onboarding",
): MemorySourceType {
  if (conversationKind === "onboarding") return "user_stated";
  if (requested !== "user_stated" || !evidenceQuote) return "inferred";
  const quote = normalizeMemoryContent(evidenceQuote);
  return quote.length > 0 && evidenceTexts.some((text) => normalizeMemoryContent(text).includes(quote))
    ? "user_stated"
    : "inferred";
}

export function normalizeMemoryMutation(
  mutation: MemoryMutation,
  context: {
    conversationId: string;
    sourceText: string;
    sourceType: MemorySourceType;
    now?: Date;
  },
): NormalizedMemoryMutation {
  const now = context.now ?? new Date();
  const sourceType = context.sourceType === "system" ? "inferred" : context.sourceType;
  const sensitivity: MemorySensitivity = SENSITIVE_CONTENT.test(mutation.content) ? "sensitive" : "normal";

  if (mutation.tier === "short") {
    const maximumExpiry = new Date(now.getTime() + SHORT_MEMORY_MAX_AGE_MS);
    const requestedExpiry = mutation.validUntil ? new Date(mutation.validUntil) : maximumExpiry;
    const validUntil = Number.isFinite(requestedExpiry.getTime())
      && requestedExpiry.getTime() > now.getTime()
      && requestedExpiry.getTime() <= maximumExpiry.getTime()
      ? requestedExpiry
      : maximumExpiry;
    return {
      ...mutation,
      sourceType,
      sensitivity,
      scope: "conversation",
      scopeKey: context.conversationId,
      status: sensitivity === "sensitive" ? "pending" : "active",
      validUntil: validUntil.toISOString(),
    };
  }

  return {
    ...mutation,
    sourceType,
    sensitivity,
    scope: "user",
    scopeKey: null,
    status: mutation.operation === "create" && sourceType === "user_stated" && sensitivity === "normal" ? "active" : "pending",
    validUntil: mutation.validUntil,
  };
}

export function memoryIsRecallable(
  memory: MemoryRecord,
  context: { conversationId?: string; now?: Date },
): boolean {
  if ((memory.status ?? "active") !== "active") return false;
  const now = (context.now ?? new Date()).getTime();
  if (memory.validUntil && new Date(memory.validUntil).getTime() <= now) return false;
  if (memory.tier === "short") {
    return memory.scope === "conversation"
      && Boolean(context.conversationId)
      && memory.scopeKey === context.conversationId;
  }
  return memory.scope === undefined || memory.scope === "user";
}
