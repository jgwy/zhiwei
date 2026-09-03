import { describe, expect, it } from "vitest";
import { filterMemoryMutations } from "./memory-filter";
import type { MemoryMutation, MemoryRecord } from "./types";

function activeMemory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content" | "category">): MemoryRecord {
  return {
    versionId: crypto.randomUUID(),
    tier: "long",
    confidence: 0.8,
    validUntil: null,
    reason: "测试",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMutation(overrides: Partial<MemoryMutation> & Pick<MemoryMutation, "content" | "category">): MemoryMutation {
  return {
    operation: "create",
    tier: "long",
    confidence: 0.8,
    validUntil: null,
    reason: "测试证据",
    evidenceMessageIds: [crypto.randomUUID()],
    ...overrides,
  };
}

describe("filterMemoryMutations", () => {
  it("keeps at most two mutations", () => {
    const mutations = [
      createMutation({ category: "interest", content: "喜欢周末爬山" }),
      createMutation({ category: "goal", content: "打算三个月内完成半程马拉松" }),
      createMutation({ category: "basic", content: "现在在苏州做结构设计" }),
    ];
    expect(filterMemoryMutations(mutations, [])).toHaveLength(2);
  });

  it("drops worry statements that were filed under goal", () => {
    const mutations = [createMutation({ category: "goal", content: "担心下学期的课程安排" })];
    expect(filterMemoryMutations(mutations, [])).toHaveLength(0);
  });

  it("drops a near-duplicate create in the same category", () => {
    const existing = activeMemory({ id: crypto.randomUUID(), category: "interest", content: "喜欢在周末跑步" });
    const mutations = [createMutation({ category: "interest", content: "喜欢在周末跑步运动" })];
    expect(filterMemoryMutations(mutations, [existing])).toHaveLength(0);
  });

  it("converts a correction-style create into a supersede of the most similar memory", () => {
    const existing = activeMemory({ id: crypto.randomUUID(), category: "interest", content: "喜欢在周末跑步" });
    const mutations = [
      createMutation({ category: "interest", content: "其实不是跑步，我现在更喜欢周末骑行" }),
    ];
    const result = filterMemoryMutations(mutations, [existing]);
    expect(result).toHaveLength(1);
    expect(result[0]?.operation).toBe("supersede");
    expect(result[0]?.memoryId).toBe(existing.id);
  });

  it("keeps a plain create when it merely shares a category", () => {
    const existing = activeMemory({ id: crypto.randomUUID(), category: "interest", content: "喜欢在周末跑步" });
    const mutations = [createMutation({ category: "interest", content: "最近迷上了天文摄影" })];
    const result = filterMemoryMutations(mutations, [existing]);
    expect(result).toHaveLength(1);
    expect(result[0]?.operation).toBe("create");
  });
});
