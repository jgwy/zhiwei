import type { MemoryRecord, ProfileSnapshot } from "@zhiwei/core/client";

export type UserMemoryView = Omit<MemoryRecord, "status"> & {
  status?: string;
  scope?: string;
};

export type ProfileView = ProfileSnapshot & {
  schemaVersion?: string;
  schema_version?: string;
  isLegacy?: boolean;
  is_legacy?: boolean;
  stale?: boolean;
  syncStatus?: string;
  consistencyState?: string;
  consistency_state?: string;
  score_change_reasons?: ProfileSnapshot["scoreChangeReasons"];
};

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
  const schemaVersion = profile.schemaVersion ?? profile.schema_version;
  const consistency = profile.syncStatus ?? profile.consistencyState ?? profile.consistency_state;
  const legacy = profile.isLegacy ?? profile.is_legacy ?? false;
  const versionText = String(schemaVersion ?? "").toLowerCase();
  const currentSchema = versionText.includes("v2");
  if (legacy || !currentSchema || consistency === "legacy" || consistency === "syncing") {
    return { state: "rebuilding" as const, text: "知微正在重新整理关于你的长期认识，完成后会自动同步到这里。" };
  }
  const summary = profile.summary.trim();
  if (!summary) {
    return { state: "missing" as const, text: "关于你的长期认识尚未同步。聊到一些对你重要的事后，知微会在这里慢慢整理。" };
  }
  if (profile.stale || consistency === "stale" || consistency === "failed") {
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
