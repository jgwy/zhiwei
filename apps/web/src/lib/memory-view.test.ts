import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@zhiwei/core/client";
import { groupVisibleMemories, isMemorySettingEnabled } from "./memory-view";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    category: "basic",
    content: "一条认识",
    tier: "long",
    confidence: 0.8,
    validUntil: null,
    reason: "测试",
    createdAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory view", () => {
  it("keeps pending candidates out of active short- and long-term groups", () => {
    const pending = memory({ status: "pending" });
    const activeLong = memory({ status: "active", tier: "long" });
    const activeShort = memory({ status: "active", tier: "short" });
    const rejected = memory({ status: "rejected" });

    expect(groupVisibleMemories([pending, activeLong, activeShort, rejected])).toEqual({
      pending: [pending],
      active: [activeLong, activeShort],
      longTerm: [activeLong],
      shortTerm: [activeShort],
    });
  });

  it("continues to show legacy active memories that have no status", () => {
    const legacy = memory({ status: undefined });
    expect(groupVisibleMemories([legacy]).active).toEqual([legacy]);
  });

  it("prefers the scoped setting and falls back to the legacy master switch", () => {
    expect(isMemorySettingEnabled({ memoryEnabled: false }, "shortTermMemoryEnabled")).toBe(false);
    expect(isMemorySettingEnabled({ memoryEnabled: false, longTermMemoryEnabled: true }, "longTermMemoryEnabled")).toBe(true);
    expect(isMemorySettingEnabled({}, "shortTermMemoryEnabled")).toBe(true);
  });

  it("only shows short-term memory from the open conversation", () => {
    const current = memory({ tier: "short", scope: "conversation", scopeKey: "conversation-a", status: "active" });
    const other = memory({ tier: "short", scope: "conversation", scopeKey: "conversation-b", status: "active" });
    const longTerm = memory({ tier: "long", scope: "user", scopeKey: null, status: "active" });
    const grouped = groupVisibleMemories([current, other, longTerm], "conversation-a");
    expect(grouped.shortTerm).toEqual([current]);
    expect(grouped.longTerm).toEqual([longTerm]);
  });
});
