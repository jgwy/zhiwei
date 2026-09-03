import { createHash } from "node:crypto";
import type { MemoryMutation, MemoryRecord, MemoryTier } from "./types";

export const SHORT_MEMORY_DEFAULT_DAYS = 7;
export const SHORT_MEMORY_MIN_DAYS = 1;
export const SHORT_MEMORY_MAX_DAYS = 30;

const DAY_MS = 86_400_000;
const FORBIDDEN_SECRET = /(?:密码|口令|验证码|密钥|api[\s_-]*key|access[\s_-]*token|secret(?:\s+key)?|private[\s_-]*key)/iu;
const API_KEY_SHAPE = /\b(?:sk|ak)-[A-Za-z0-9._-]{12,}\b/u;
const CHINESE_ID_SHAPE = /\b\d{17}[\dXx]\b/u;
const BANK_CARD_SHAPE = /\b\d{16,19}\b/u;

export function containsForbiddenMemorySecret(content: string): boolean {
  return FORBIDDEN_SECRET.test(content)
    || API_KEY_SHAPE.test(content)
    || CHINESE_ID_SHAPE.test(content)
    || BANK_CARD_SHAPE.test(content);
}

export function normalizeMemoryContent(content: string): string {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(normalizeMemoryContent(content)).digest("hex");
}

export function normalizeMemoryValidity(
  tier: MemoryTier,
  requested: string | null | undefined,
  now = new Date(),
): { validUntil: string | null; normalized: boolean; reason: string | null } {
  if (tier === "long") {
    return {
      validUntil: null,
      normalized: requested !== null && requested !== undefined,
      reason: requested == null ? null : "长期记忆不设置自动失效时间",
    };
  }

  const parsed = requested ? new Date(requested) : null;
  const deltaDays = parsed ? (parsed.getTime() - now.getTime()) / DAY_MS : Number.NaN;
  if (
    parsed
    && Number.isFinite(parsed.getTime())
    && deltaDays >= SHORT_MEMORY_MIN_DAYS
    && deltaDays <= SHORT_MEMORY_MAX_DAYS
  ) {
    return { validUntil: parsed.toISOString(), normalized: false, reason: null };
  }

  return {
    validUntil: new Date(now.getTime() + SHORT_MEMORY_DEFAULT_DAYS * DAY_MS).toISOString(),
    normalized: true,
    reason: "近期记忆期限缺失或不在 1–30 天范围内，已使用 7 天默认期限",
  };
}

export function memoryIsRecallable(memory: MemoryRecord, now = new Date()): boolean {
  if ((memory.status ?? "active") !== "active") return false;
  if (memory.validUntil && new Date(memory.validUntil).getTime() <= now.getTime()) return false;
  return true;
}

export type RankedMemory = { memory: MemoryRecord; score: number };

export function rankMemoryRecords(
  memories: MemoryRecord[],
  query: string,
  semanticScores: ReadonlyMap<string, number> = new Map(),
  now = new Date(),
): RankedMemory[] {
  const terms = extractSearchTerms(query);
  return memories
    .filter((memory) => memoryIsRecallable(memory, now))
    .map((memory) => {
      const lexical = terms.length
        ? terms.filter((term) => memory.content.includes(term)).length / terms.length
        : 0;
      const ageDays = Math.max(0, (now.getTime() - new Date(memory.createdAt).getTime()) / DAY_MS);
      const freshness = Math.exp(-ageDays / (memory.tier === "short" ? 14 : 365));
      const semantic = Math.max(0, Math.min(1, semanticScores.get(memory.versionId) ?? 0));
      const score = semanticScores.has(memory.versionId)
        ? semantic * 0.78 + lexical * 0.14 + freshness * 0.08
        : lexical * 0.82 + freshness * 0.18;
      return { memory, score };
    })
    .sort((left, right) => right.score - left.score || right.memory.createdAt.localeCompare(left.memory.createdAt));
}

// 5/3 is the preferred long/short mix. If one tier has too few candidates,
// the other tier fills the unused slots so retrieval can still return eight.
export function selectMemoryQuota(ranked: RankedMemory[], limit = 8): MemoryRecord[] {
  const cappedLimit = Math.max(1, Math.min(8, limit));
  const selected: RankedMemory[] = [];
  const long = ranked.filter(({ memory }) => memory.tier === "long");
  const short = ranked.filter(({ memory }) => memory.tier === "short");
  selected.push(...long.slice(0, Math.min(5, cappedLimit)));
  selected.push(...short.slice(0, Math.min(3, Math.max(0, cappedLimit - selected.length))));

  if (selected.length < cappedLimit) {
    const selectedIds = new Set(selected.map(({ memory }) => memory.versionId));
    selected.push(...ranked.filter(({ memory }) => !selectedIds.has(memory.versionId)).slice(0, cappedLimit - selected.length));
  }
  return selected
    .sort((left, right) => right.score - left.score)
    .slice(0, cappedLimit)
    .map(({ memory }) => memory);
}

export function validateReflectionBatch(actions: MemoryMutation[]): void {
  if (actions.length > 3) throw new Error("memory_action_limit_exceeded");
  const targets = new Set<string>();
  for (const action of actions) {
    const evidence = new Set(action.evidenceMessageIds);
    if (evidence.size !== action.evidenceMessageIds.length) {
      throw new Error("memory_evidence_scope_invalid");
    }
    if (action.operation !== "create") {
      if (targets.has(action.memoryId)) throw new Error("memory_batch_target_conflict");
      targets.add(action.memoryId);
    }
  }
}

function extractSearchTerms(query: string): string[] {
  const normalized = query.replace(/[，。！？、,.!?：:；;]/gu, " ");
  const words = normalized.split(/\s+/u).filter((term) => term.length >= 2);
  const compact = normalized.replace(/\s+/gu, "");
  const bigrams = Array.from(
    { length: Math.max(0, compact.length - 1) },
    (_, index) => compact.slice(index, index + 2),
  );
  return [...new Set([...words, ...bigrams])].slice(0, 12);
}
