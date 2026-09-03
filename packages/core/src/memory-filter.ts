import type { MemoryMutation, MemoryRecord } from "./types";

const CORRECTION_CUES = /(?:其实(?:不是|没有)|不是(?:了|这样|这回事)|已经不|记错|理解错|我说的不是|换(?:个|了)(?:说法|想法)|重新说|现在(?:更|是)想)/u;

function bigramOverlap(left: string, right: string): number {
  const grams = (value: string) => {
    const normalized = value.replace(/[\s，。！？、,.!?：;；“”"'（）()]/gu, "");
    return new Set(
      Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2)),
    );
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return left === right ? 1 : 0;
  const intersection = [...a].filter((gram) => b.has(gram)).length;
  return intersection / Math.max(a.size, b.size);
}

/**
 * 反思产出的记忆变更守门：
 * - 最多保留 maxAccept 条；
 * - goal 类别不收"担忧/压力"类表述（那些属于 challenge）；
 * - create 与已有同类别记忆高度重叠（≥ overlapThreshold）时丢弃；
 * - create 带纠正语气（"其实不是…"）时，即使重叠不高也转为对最相似旧记忆的 supersede，
 *   避免新旧两条矛盾记忆同时处于活动状态。
 */
export function filterMemoryMutations(
  mutations: MemoryMutation[],
  active: MemoryRecord[],
  options: { maxAccept?: number; overlapThreshold?: number } = {},
): MemoryMutation[] {
  const maxAccept = options.maxAccept ?? 2;
  const overlapThreshold = options.overlapThreshold ?? 0.72;
  const accepted: MemoryMutation[] = [];
  for (const mutation of mutations) {
    if (accepted.length >= maxAccept) break;
    if (mutation.category === "goal" && /^(担心|害怕|忧虑|压力|风险|困扰)/u.test(mutation.content.trim())) {
      continue;
    }
    const sameCategoryTexts = [
      ...active.filter((memory) => memory.category === mutation.category).map((memory) => memory.content),
      ...accepted
        .filter((memory) => memory.category === mutation.category)
        .map((memory) => memory.content),
    ];
    if (mutation.operation === "create" && sameCategoryTexts.length) {
      const similarities = sameCategoryTexts.map((content) => ({
        content,
        overlap: bigramOverlap(content, mutation.content),
      }));
      const mostSimilar = similarities.reduce((best, item) => (item.overlap > best.overlap ? item : best));
      if (CORRECTION_CUES.test(mutation.content) && mostSimilar.overlap >= 0.2 && mutation.memoryId === undefined) {
        accepted.push({ ...mutation, operation: "supersede", memoryId: active.find((memory) => memory.content === mostSimilar.content)?.id });
        continue;
      }
      if (mostSimilar.overlap >= overlapThreshold) continue;
    }
    accepted.push(mutation);
  }
  return accepted;
}
