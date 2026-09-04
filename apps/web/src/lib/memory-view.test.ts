import { describe, expect, it } from "vitest";
import type { MemoryRecord, ProfileSnapshot } from "@zhiwei/core/client";
import { memorySettingChecked, resolveLongTermSummary, selectUserMemories, type ProfileView, type UserMemoryView } from "./memory-view";

function memory(index: number, overrides: Partial<UserMemoryView> = {}): UserMemoryView {
  return {
    id: `memory-${index}`,
    versionId: `version-${index}`,
    category: "basic",
    content: `认识 ${index}`,
    tier: "short",
    confidence: 0.8,
    validUntil: null,
    reason: "测试",
    status: "active",
    createdAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
    ...overrides,
  } as MemoryRecord;
}

function profile(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    id: "profile-1",
    summary: "一段可靠的长期印象。",
    dimensionWeights: {},
    understanding: { coverage: 0, validation: 0, personalization: 0, temporal: 0 },
    score: 20,
    createdAt: "2026-09-03T00:00:00.000Z",
    schemaVersion: "long-profile-v2",
    ...overrides,
  } as ProfileSnapshot & ProfileView;
}

describe("ordinary memory view", () => {
  it("shows active long-term atoms and at most the newest six unexpired short-term memories", () => {
    const memories = Array.from({ length: 8 }, (_, index) => memory(index));
    const longTerm = memory(20, { tier: "long" });
    const withdrawn = memory(21, { status: "withdrawn" });
    const expired = memory(22, { validUntil: "2026-09-01T00:00:00.000Z" });
    const selected = selectUserMemories([...memories, longTerm, withdrawn, expired], Date.parse("2026-09-10T00:00:00.000Z"));

    expect(selected.longTerm).toEqual([longTerm]);
    expect(selected.allRecent).toHaveLength(8);
    expect(selected.allRecent.slice(0, 6).map((item) => item.content)).toEqual(["认识 7", "认识 6", "认识 5", "认识 4", "认识 3", "认识 2"]);
  });

  it("never presents legacy, stale, or missing profiles as the current long-term summary", () => {
    expect(resolveLongTermSummary(null).state).toBe("missing");
    expect(resolveLongTermSummary(profile({ schemaVersion: "legacy-v1" })).state).toBe("rebuilding");
    expect(resolveLongTermSummary(profile({ schemaVersion: "long-profile-v2" })).state).toBe("ready");
    expect(resolveLongTermSummary(profile({ schemaVersion: "long-profile-v2", syncStatus: "current" })).state).toBe("ready");
    expect(resolveLongTermSummary(profile({ schemaVersion: "long-profile-v2", syncStatus: "stale" }))).toMatchObject({ state: "stale", text: "一段可靠的长期印象。" });
    expect(resolveLongTermSummary(profile()).state).toBe("ready");
  });

  it("keeps layered preferences independent from the master pause switch", () => {
    const settings = { memoryEnabled: false, shortTermMemoryEnabled: true, longTermMemoryEnabled: false };
    expect(memorySettingChecked(settings, "memoryEnabled")).toBe(false);
    expect(memorySettingChecked(settings, "shortTermMemoryEnabled")).toBe(true);
    expect(memorySettingChecked(settings, "longTermMemoryEnabled")).toBe(false);
  });
});
