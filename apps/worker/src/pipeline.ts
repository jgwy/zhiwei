import {
  MemoryMutationSchema,
  MemoryReflectionCommitSchema,
  containsForbiddenMemorySecret,
  normalizeMemoryValidity,
  type MemoryMutation,
  type MemoryRecord,
  type MemoryReflectionCommit,
  type ReflectionDecision,
} from "@zhiwei/core";
import type { LifecycleMemoryInput } from "@zhiwei/model-gateway";

export type MemoryLayerSettings = {
  memoryEnabled?: boolean;
  shortTermMemoryEnabled?: boolean;
  longTermMemoryEnabled?: boolean;
  emotionTrackingEnabled?: boolean;
};

export type PreparedReflection = {
  actions: MemoryMutation[];
  blockedSecretCount: number;
  disabledLayerCount: number;
  validityAdjustments: Array<{ index: number; reason: string }>;
};

export function prepareReflectionActions(
  decision: ReflectionDecision,
  sourceMessageId: string,
  settings: MemoryLayerSettings,
  now = new Date(),
): PreparedReflection {
  const actions: MemoryMutation[] = [];
  const validityAdjustments: PreparedReflection["validityAdjustments"] = [];
  let blockedSecretCount = 0;
  let disabledLayerCount = 0;

  for (const [index, raw] of decision.memories.slice(0, 3).entries()) {
    const action = MemoryMutationSchema.parse(raw);
    if (!action.evidenceMessageIds.includes(sourceMessageId)) {
      throw new Error("memory_evidence_scope_invalid");
    }
    if ("content" in action && containsForbiddenMemorySecret(action.content)) {
      blockedSecretCount += 1;
      continue;
    }
    if ("tier" in action && !memoryLayerEnabled(action, settings)) {
      disabledLayerCount += 1;
      continue;
    }
    if ("tier" in action) {
      const validity = normalizeMemoryValidity(action.tier, action.validUntil, now);
      if (validity.reason) validityAdjustments.push({ index, reason: validity.reason });
      actions.push({ ...action, validUntil: validity.validUntil } as MemoryMutation);
    } else {
      actions.push(action);
    }
  }

  return { actions, blockedSecretCount, disabledLayerCount, validityAdjustments };
}

export function embeddingInputs(actions: MemoryMutation[]): Array<{ index: number; content: string }> {
  return actions.flatMap((action, index) => "content" in action ? [{ index, content: action.content }] : []);
}

export function alignEmbeddings(
  actionCount: number,
  inputs: Array<{ index: number }>,
  vectors: number[][] | null,
): Array<number[] | null> {
  const aligned = Array.from({ length: actionCount }, () => null as number[] | null);
  if (!vectors || vectors.length !== inputs.length) return aligned;
  for (const [vectorIndex, input] of inputs.entries()) aligned[input.index] = vectors[vectorIndex] ?? null;
  return aligned;
}

export function profileMemories(memories: MemoryRecord[]): LifecycleMemoryInput[] {
  return memories
    .filter((memory) => (memory.status ?? "active") === "active")
    .filter((memory) => memory.tier === "long")
    .filter((memory) => memory.category !== "emotion" && memory.category !== "boundary")
    .map((memory) => ({
      memoryId: memory.id,
      versionId: memory.versionId,
      category: memory.category,
      content: memory.content,
      confidence: memory.confidence,
    }));
}

export function consolidationMemories(memories: MemoryRecord[]): LifecycleMemoryInput[] {
  return memories
    .filter((memory) => (memory.status ?? "active") === "active" && memory.tier === "long")
    .map((memory) => ({
      memoryId: memory.id,
      versionId: memory.versionId,
      category: memory.category,
      content: memory.content,
      confidence: memory.confidence,
    }));
}

export function shouldRefreshSessionSummary(
  decision: ReflectionDecision,
  existingSummary: string | null,
  messageCount: number,
): boolean {
  return decision.refreshSummary || !existingSummary || messageCount >= 12;
}

export function backgroundReflection(input: {
  memories?: MemoryMutation[];
  mood?: MemoryReflectionCommit["mood"];
  nextSessionSummary?: string;
  returnNote?: MemoryReflectionCommit["returnNote"];
}): MemoryReflectionCommit {
  return MemoryReflectionCommitSchema.parse({
    memories: input.memories ?? [],
    mood: input.mood ?? null,
    sessionSummary: input.nextSessionSummary,
    returnNote: input.returnNote ?? null,
    summaryChanged: typeof input.nextSessionSummary === "string",
  });
}

function memoryLayerEnabled(action: Extract<MemoryMutation, { tier: "short" | "long" }>, settings: MemoryLayerSettings) {
  if (settings.memoryEnabled === false) return false;
  if (action.tier === "short" && settings.shortTermMemoryEnabled === false) return false;
  if (action.tier === "long" && settings.longTermMemoryEnabled === false) return false;
  if (action.category === "emotion" && settings.emotionTrackingEnabled === false) return false;
  return true;
}
