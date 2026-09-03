import type { MemoryRecord } from "@zhiwei/core/client";

export function groupVisibleMemories(memories: readonly MemoryRecord[], conversationId?: string | null) {
  const belongsHere = (memory: MemoryRecord) => memory.tier === "long"
    || !conversationId
    || memory.scopeKey === conversationId;
  const pending = memories.filter((memory) => memory.status === "pending" && belongsHere(memory));
  const active = memories.filter((memory) => (!memory.status || memory.status === "active") && belongsHere(memory));
  return {
    pending,
    active,
    longTerm: active.filter((memory) => memory.tier === "long"),
    shortTerm: active.filter((memory) => memory.tier === "short"),
  };
}

export function isMemorySettingEnabled(settings: Record<string, boolean>, key: "shortTermMemoryEnabled" | "longTermMemoryEnabled") {
  return settings[key] ?? settings.memoryEnabled ?? true;
}
