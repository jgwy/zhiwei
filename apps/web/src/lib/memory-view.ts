import type { MemoryRecord, ProfileSnapshot } from "@zhiwei/core/client";

export type UserMemoryView = MemoryRecord;
export type ProfileView = ProfileSnapshot;

export function selectUserMemories(memories: readonly UserMemoryView[], now = Date.now()) {
  const active = memories.filter((memory) => {
    if (memory.status && memory.status !== "active") return false;
    if (!memory.validUntil) return true;
    const expiry = Date.parse(memory.validUntil);
    return Number.isNaN(expiry) || expiry > now;
  });
  const newestFirst = (left: UserMemoryView, right: UserMemoryView) => Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return {
    longTerm: active.filter((memory) => memory.tier === "long").sort(newestFirst),
    allRecent: active.filter((memory) => memory.tier === "short").sort(newestFirst),
  };
}

export function resolveLongTermSummary(profile: ProfileView | null) {
  if (!profile) {
    return { state: "missing" as const, text: "关于你的长期认识尚未同步。聊到一些对你重要的事后，知微会在这里慢慢整理。" };
  }
  const consistency = profile.syncStatus;
  if (profile.schemaVersion !== "long-profile-v2" || consistency === "legacy" || consistency === "syncing") {
    return { state: "rebuilding" as const, text: "知微正在重新整理关于你的长期认识，完成后会自动同步到这里。" };
  }
  const summary = profile.summary.trim();
  if (!summary) {
    return { state: "missing" as const, text: "关于你的长期认识尚未同步。聊到一些对你重要的事后，知微会在这里慢慢整理。" };
  }
  if (consistency === "stale" || consistency === "failed") {
    return { state: "stale" as const, text: summary, note: "最新变化尚未同步，暂时显示上一次可靠整理。" };
  }
  return { state: "ready" as const, text: summary };
}

export function memorySettingChecked(settings: Record<string, boolean>, key: string) {
  if (key === "shortTermMemoryEnabled" || key === "longTermMemoryEnabled") {
    return settings[key] ?? true;
  }
  return settings[key] !== false;
}
