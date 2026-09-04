import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({
  getPool: () => database,
  withTransaction: vi.fn(),
}));

import { rankMemories, recordModelRun, searchMemories, updateConversationTitle } from "./repository";
import type { MemoryRecord } from "./types";

function memory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    versionId: crypto.randomUUID(),
    category: "interest",
    tier: "short",
    confidence: 0.5,
    validUntil: null,
    reason: "测试证据",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("memory retrieval", () => {
  beforeEach(() => { database.query.mockReset(); });

  it("ranks lexical relevance with tier quotas independently of confidence", () => {
    const lexical = memory({ id: crypto.randomUUID(), content: "喜欢在周末跑步", confidence: 0.8 });
    const confident = memory({ id: crypto.randomUUID(), content: "目前专注阅读", confidence: 0.95, tier: "long" });
    const unrelated = memory({ id: crypto.randomUUID(), content: "偏好安静环境", confidence: 0.2 });

    const ranked = rankMemories([unrelated, confident, lexical], "周末 跑步", 2);

    expect(ranked.map((item) => item.id)).toEqual([lexical.id, confident.id]);
    expect(rankMemories([
      { ...unrelated, confidence: 1 }, { ...confident, confidence: 0 }, { ...lexical, confidence: 0 },
    ], "周末 跑步", 2).map((item) => item.id)).toEqual([lexical.id, confident.id]);
  });

  it("uses a 1024-dimensional embedding and keeps the database query user-scoped", async () => {
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query.mockImplementation(async (_sql, parameters) => {
      const rows = parameters[1] === "short" ? [{
          id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "interest",
          content: "与问题无关但向量接近", tier: "short", confidence: 0.5,
          valid_until: null, reason: "测试", created_at: now, similarity: 0.95,
        }] : [{
          id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "interest",
          content: "喜欢周末跑步", tier: "long", confidence: 0.9,
          valid_until: null, reason: "测试", created_at: now, similarity: 0.75,
        }];
      return { rowCount: rows.length, rows };
    });

    const result = await searchMemories(userId, "周末 跑步", 1, Array.from({ length: 1024 }, () => 0.01));

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("喜欢周末跑步");
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls.map((call) => call[1][1])).toEqual(["long", "short"]);
    for (const [sql, parameters] of database.query.mock.calls) {
      expect(sql).toContain("mv.user_id=$1 AND mv.tier=$2");
      expect(sql).toContain("WHERE m.user_id=$1");
      expect(sql).toContain("memoryEnabled");
      expect(sql).toContain("longTermMemoryEnabled");
      expect(sql).toContain("shortTermMemoryEnabled");
      expect(sql).toContain("emotionTrackingEnabled");
      expect(sql).toContain("mv.is_active");
      expect(sql).toContain("embedding_v2 <=> $3::vector");
      expect(sql).toContain("UNION");
      expect(parameters[0]).toBe(userId);
      expect(JSON.parse(parameters[2])).toEqual(Array.from({ length: 1024 }, () => 0.01));
      expect(parameters[3]).toEqual(expect.arrayContaining(["周末", "跑步"]));
    }
  });

  it("falls back to keyword retrieval when an embedding has the wrong dimension", async () => {
    const userId = crypto.randomUUID();
    database.query.mockImplementation(async (_sql, parameters) => {
      const rows = parameters[1] === "long" ? [{
        id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "goal",
        content: "希望完成毕业论文", tier: "long", confidence: 0.8,
        valid_until: null, reason: "测试", created_at: new Date().toISOString(),
      }] : [];
      return { rowCount: rows.length, rows };
    });

    const result = await searchMemories(userId, "毕业论文", 8, [0.1, 0.2]);

    expect(result[0]?.content).toBe("希望完成毕业论文");
    expect(result).toHaveLength(1);
    expect(database.query).toHaveBeenCalledTimes(2);
    for (const [sql, parameters] of database.query.mock.calls) {
      expect(parameters[0]).toBe(userId);
      expect(parameters[2]).toBeNull();
      expect(parameters[3]).toEqual(expect.arrayContaining(["毕业论文", "论文"]));
      expect(sql).toContain("$3::vector IS NOT NULL");
      expect(sql).toContain("strpos(mv.content,term)>0");
    }
  });

  it("updates a title within the current user scope and preserves the manual lock guard", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await updateConversationTitle(userId, conversationId, "模型生成的会话标题", "model");
    await updateConversationTitle(userId, conversationId, "我自己改的标题", "manual");

    const [modelSql, modelParameters] = database.query.mock.calls[0]!;
    expect(modelSql).toContain("title_locked = false");
    expect(modelParameters).toEqual([conversationId, userId, "模型生成的会话标题", "model"]);
    expect(database.query.mock.calls[1]?.[1]).toEqual([conversationId, userId, "我自己改的标题", "manual"]);
  });

  it("persists both first-token timings and explicitly unknown partial usage", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await recordModelRun({
      userId,
      traceId: "trace-test",
      role: "dialogue",
      adapterId: "gateway-test",
      modelName: "qwen-plus-character",
      transport: "openai-responses",
      conversationId,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      reasoningTokens: 0,
      searchCalls: 0,
      estimatedInputTokens: 110,
      estimatedOutputTokens: 60,
      estimatedCostCny: 0.000183,
      firstTokenMs: 321,
      firstDeltaMs: 456,
      usageReported: false,
      requestId: "request-test",
      retries: 1,
      fallbackFrom: "qwen-plus-character-old",
      errorCode: undefined,
      thinking: false,
      sources: [{ title: "官方来源", url: "https://example.invalid/source" }],
      attempts: [{
        model: "qwen-plus-character",
        transport: "openai-responses",
        requestId: "request-test",
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningTokens: 0, searchCalls: 0 },
        durationMs: 987,
        finishReason: "completed",
        outcome: "completed",
      }],
      promptVersion: "v2",
      status: "completed",
      durationMs: 987,
      finishReason: "completed",
    });

    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("first_delta_ms, usage_reported");
    expect(sql).toContain("$30");
    expect(parameters).toHaveLength(30);
    expect(parameters[5]).toBe("qwen-plus-character");
    expect(parameters[8]).toBe(0.000183);
    expect(JSON.parse(parameters[24])).toEqual([{ title: "官方来源", url: "https://example.invalid/source" }]);
    expect(parameters[25]).toBe("v2");
    expect(parameters[26]).toBe("openai-responses");
    expect(JSON.parse(parameters[27])).toEqual([expect.objectContaining({ outcome: "completed" })]);
    expect(parameters[18]).toBe(321);
    expect(parameters[28]).toBe(456);
    expect(parameters[29]).toBe(false);
  });
});
