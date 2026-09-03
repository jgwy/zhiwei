import { describe, expect, it } from "vitest";
import { rankMemories, type MemoryRecord } from "@zhiwei/core";

describe("offline retrieval fixtures", () => {
  it("places a semantically matching memory within top 8", () => {
    const memories: MemoryRecord[] = Array.from({ length: 20 }, (_, index) => ({
      id: `m-${index}`,
      versionId: crypto.randomUUID(),
      category: index === 15 ? "goal" : "basic",
      content: index === 15 ? "希望找到新的工作方向" : `普通背景 ${index}`,
      tier: "long",
      confidence: 0.8,
      validUntil: null,
      eventTime: { kind: "unknown", start: null, end: null, precision: "unknown", expression: null, timeZone: null },
      firstObservedAt: null,
      lastConfirmedAt: null,
      reason: "fixture",
      createdAt: new Date().toISOString(),
    }));
    expect(rankMemories(memories, "新的工作方向", 8).map((memory) => memory.id)).toContain("m-15");
  });
});

