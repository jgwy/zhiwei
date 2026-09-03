import { describe, expect, it } from "vitest";
import {
  containsForbiddenMemorySecret,
  normalizeMemoryValidity,
  rankMemoryRecords,
  selectMemoryQuota,
  validateReflectionBatch,
} from "./memory-policy";
import { ReflectionDecisionSchema, type MemoryRecord } from "./types";

const NOW = new Date("2026-09-03T00:00:00.000Z");

describe("direct memory policy", () => {
  it("accepts only 1–30 day short expiries and otherwise uses seven days", () => {
    expect(normalizeMemoryValidity("short", "2026-09-04T00:00:00.000Z", NOW).validUntil)
      .toBe("2026-09-04T00:00:00.000Z");
    expect(normalizeMemoryValidity("short", "2026-10-03T00:00:00.000Z", NOW).validUntil)
      .toBe("2026-10-03T00:00:00.000Z");
    expect(normalizeMemoryValidity("short", null, NOW).validUntil)
      .toBe("2026-09-10T00:00:00.000Z");
    expect(normalizeMemoryValidity("short", "2026-10-04T00:00:00.000Z", NOW).validUntil)
      .toBe("2026-09-10T00:00:00.000Z");
    expect(normalizeMemoryValidity("long", "2026-09-05T00:00:00.000Z", NOW).validUntil).toBeNull();
  });

  it("uses a 5/3 preferred tier mix and fills empty slots from the other tier", () => {
    const mixed = rankMemoryRecords([
      ...Array.from({ length: 7 }, (_, index) => memory(`l-${index}`, "long", index)),
      ...Array.from({ length: 6 }, (_, index) => memory(`s-${index}`, "short", index)),
    ], "共同关键词", new Map(), NOW);
    const selected = selectMemoryQuota(mixed, 8);
    expect(selected.filter((item) => item.tier === "long")).toHaveLength(5);
    expect(selected.filter((item) => item.tier === "short")).toHaveLength(3);

    const shortOnly = selectMemoryQuota(
      rankMemoryRecords(Array.from({ length: 8 }, (_, index) => memory(`only-${index}`, "short", index)), "共同关键词", new Map(), NOW),
      8,
    );
    expect(shortOnly).toHaveLength(8);
  });

  it("does not use confidence as a retrieval signal", () => {
    const low = memory("low", "long", 0, 0.01);
    const high = memory("high", "long", 1, 0.99);
    const ranked = rankMemoryRecords([low, high], "共同关键词", new Map(), NOW);
    expect(ranked[0]?.memory.id).toBe("low");
  });

  it("blocks obvious secrets and more than three model actions", () => {
    expect(containsForbiddenMemorySecret(`我的 API key 是 ${["sk", "abcdefghijklmnop"].join("-")}`)).toBe(true);
    const action = {
      operation: "create" as const,
      category: "goal" as const,
      content: "准备期末考试",
      tier: "short" as const,
      confidence: 0.9,
      validUntil: null,
      reason: "用户明确表达",
      evidenceMessageIds: [crypto.randomUUID()],
    };
    expect(() => validateReflectionBatch([action, action, action, action])).toThrow("memory_action_limit_exceeded");
    expect(ReflectionDecisionSchema.safeParse({
      memories: [action, action, action, action], mood: null, refreshProfile: true,
      refreshSummary: false, returnTopic: null, shouldEvolveSkill: false,
      evolutionReason: null, needsDeepReview: false, decisionReason: "测试",
    }).success).toBe(false);
  });
});

function memory(id: string, tier: "short" | "long", ageDays: number, confidence = 0.5): MemoryRecord {
  return {
    id,
    versionId: `${id}-version`,
    category: "interest",
    content: "共同关键词",
    tier,
    confidence,
    validUntil: tier === "short" ? "2026-09-20T00:00:00.000Z" : null,
    reason: "测试",
    status: "active",
    createdAt: new Date(NOW.getTime() - ageDays * 86_400_000).toISOString(),
  };
}
